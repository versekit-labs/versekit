#!/usr/bin/env bash
# 协调器等待循环：把 Orca 官方的 supervised loop 做成一个不会「漏挂」的脚本。
#
# 官方循环（orca skills get orchestration --full）：
#   check --wait → 逐条处理 → 决定终端去向 → check --ack <delivery> --wait → …
#   空等/超时是检查点；连续 3 次空等后看 worker-list；没有正证据不 stop/abandon/重派。
#
# 以前这一圈靠协调器每次手动挂一个后台等待，漏挂一次流程就停。这个脚本替它转：
#   - 机械消息（worker_done succeeded / merge_ready / heartbeat）：跑一轮 bin/cycle.sh
#     （迁移状态、合并、release 已交活的 worker、派下一单），ack，继续等。
#   - 需要判断的消息（escalation / question / worker_done failed）：**不 ack**，打印出来并退出，
#     把协调器叫醒。处理完由协调器自己 ack，再重新启动本脚本。
#   - 超时：也跑一轮 cycle.sh（门禁晚绿的 PR 靠这一轮合并）；连续 3 次空等后看 worker-list，
#     有需要处理的行就退出叫醒协调器。
#   - 没有在跑的 worker、cycle 也没有新动作：连续两轮后正常退出。
#
# 必须在协调器自己的 Orca 终端里跑（它是 Run 所有者；check/ack/release 都要这个身份）。
# 运行期间不要在同一终端再跑 run-use：那会取消正在进行的等待。
#
# 用法：bin/coordinator-loop.sh [--max N]        # N = 每轮 cycle 最多派几单（默认 2）
# 环境变量：
#   COORD_WAIT_MS        单次等待毫秒数（默认 300000）
#   COORD_IDLE_ROUNDS    连续空转几轮后退出（默认 2）
#   CYCLE_LANES          并行 lane 数（默认 2）
# 退出码：
#   0   没活可等了（全部结算，没有新单可派，s:triage 里也没有待整理的 issue）
#   13  没活可派，但 s:triage 里还有 issue：要协调器补验收口径、转 s:ready（流程「停住」最常见的原因）
#   10  有消息需要协调器判断（未 ack；delivery id 与消息内容已打印）
#   11  worker-list 报告有 worker 需要处理（requiresAction 或已退出）
#   12  等待被取消（多半是同一终端跑了 run-use）或 check 报错

set -uo pipefail
cd "$(dirname "$0")/.."

MAX=2
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX="${2:-2}"; shift 2 ;;
    *) printf 'coordinator-loop: 未知参数 %s\n' "$1" >&2; exit 2 ;;
  esac
done

RUN_FILE="${RUN_FILE:-$HOME/.orca/versekit-run-id}"
[ -s "$RUN_FILE" ] || { echo "coordinator-loop: 没有 Run id 文件：$RUN_FILE" >&2; exit 12; }
RUN_ID=$(cat "$RUN_FILE")
WAIT_MS="${COORD_WAIT_MS:-300000}"
IDLE_LIMIT="${COORD_IDLE_ROUNDS:-2}"
export CYCLE_LANES="${CYCLE_LANES:-2}"
TYPES="worker_done,escalation,question,merge_ready"

say() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

# 把一次 check 的输出（前面可能有 keepalive 行）归纳成几行 key=value 和消息列表。
summarize() {
  python3 -c '
import json,sys
raw=sys.stdin.read()
doc=None
# 输出里夹着单行 keepalive JSON；最后一个多行对象才是结果。逐段尝试。
for start in [k for k,ch in enumerate(raw) if ch=="{" and (k==0 or raw[k-1]=="\n")][::-1]:
    try:
        cand=json.loads(raw[start:].split("\n[exited",1)[0])
    except Exception:
        continue
    if isinstance(cand,dict) and ("result" in cand or "error" in cand):
        doc=cand; break
if doc is None:
    print("STATE=error"); print("ERR=无法解析 check 输出"); raise SystemExit(0)
if not doc.get("ok",True):
    e=doc.get("error") or {}
    print("STATE=error"); print("ERR=%s %s" % (e.get("code",""), str(e.get("message",""))[:200])); raise SystemExit(0)
r=doc.get("result") or {}
msgs=r.get("messages") or []
if r.get("cancelled"): print("STATE=cancelled"); raise SystemExit(0)
if not msgs: print("STATE=empty"); raise SystemExit(0)
need=False
for m in msgs:
    t=m.get("type"); out=""
    try: out=(json.loads(m.get("payload") or "{}") or {}).get("outcome") or ""
    except Exception: pass
    if t in ("escalation","question") or (t=="worker_done" and out=="failed"): need=True
    body=" ".join(str(m.get("body") or "").split())[:600]
    # 空字段用 - 占位：bash 的 read 会把连续的制表符并成一个，字段会错位。
    print("MSG=%s\t%s\t%s\t%s\t%s" % (m.get("id"), t, out or "-", " ".join(str(m.get("subject") or "").split())[:120], body))
print("DELIVERY=%s" % (r.get("deliveryId") or ""))
print("STATE=%s" % ("human" if need else "mechanical"))
'
}

active_workers() {
  orca orchestration worker-list --run "$RUN_ID" --json 2>/dev/null | python3 -c '
import json,sys
try: ws=(json.load(sys.stdin).get("result") or {}).get("workers") or []
except Exception: print("?"); raise SystemExit(0)
print(sum(1 for w in ws if w.get("terminalState")=="active"))
' 2>/dev/null || echo "?"
}

# 连续空等后的体检：列出需要处理的 worker（requiresAction，或有正证据已退出）。
attention_rows() {
  orca orchestration worker-list --run "$RUN_ID" --json 2>/dev/null | python3 -c '
import json,sys
try: ws=(json.load(sys.stdin).get("result") or {}).get("workers") or []
except Exception: raise SystemExit(0)
for w in ws:
    if w.get("terminalState")!="active": continue
    p=w.get("projection") or {}
    live=(p.get("liveness") or {})
    att=(p.get("attention") or {})
    nxt=(p.get("nextAction") or {})
    if att.get("requiresAction") or live.get("verdict")=="exited":
        print("%s\tliveness=%s\tattention=%s\tnext=%s" % (w.get("dispatchId"), live.get("verdict"), ",".join(att.get("categories") or []), " ".join(nxt.get("argv") or []) or nxt.get("kind")))
' 2>/dev/null
}

run_cycle() {
  local out
  out=$(bin/cycle.sh --max "$MAX" --no-consume 2>&1) || true
  printf '%s\n' "$out" | grep -E '✓|✗|↩|→ |worker-release|⚠' | sed 's/^/    /' || true
  if printf '%s' "$out" | grep -qE '✓ 已派|✓ 合并|↩ '; then return 0; fi
  return 1
}

ack=""
empties=0
idle=0
say "开始（Run ${RUN_ID}，单次等待 $((WAIT_MS / 1000))s，每轮最多派 ${MAX} 单）"
# 先派一轮再等：否则启动时如果没有在跑的 worker，要白等一个超时才会派工。
say "先跑一轮派工"
run_cycle || true
while :; do
  args=(--run "$RUN_ID" --wait --types "$TYPES" --timeout-ms "$WAIT_MS" --json)
  [ -n "$ack" ] && args=(--run "$RUN_ID" --ack "$ack" --wait --types "$TYPES" --timeout-ms "$WAIT_MS" --json)
  raw=$(orca orchestration check "${args[@]}" 2>&1) || true
  ack=""
  info=$(printf '%s' "$raw" | summarize)
  state=$(printf '%s\n' "$info" | sed -n 's/^STATE=//p' | tail -1)
  delivery=$(printf '%s\n' "$info" | sed -n 's/^DELIVERY=//p' | tail -1)

  case "$state" in
    error)
      say "✗ check 出错：$(printf '%s\n' "$info" | sed -n 's/^ERR=//p')"
      exit 12 ;;
    cancelled)
      say "✗ 等待被取消（同一终端跑了 run-use？）。重新启动本脚本即可。"
      exit 12 ;;
    human)
      say "需要协调器判断，未 ack。delivery=${delivery}"
      printf '%s\n' "$info" | sed -n 's/^MSG=//p' | while IFS=$'\t' read -r id type outcome subject body; do
        [ "$outcome" = "-" ] && outcome=""
        printf '  - [%s%s] %s  (%s)\n    %s\n' "$type" "${outcome:+/$outcome}" "$subject" "$id" "$body"
      done
      say "处理完后：orca orchestration check --run ${RUN_ID} --ack ${delivery} --json，再重新启动 bin/coordinator-loop.sh"
      exit 10 ;;
    mechanical)
      empties=0
      printf '%s\n' "$info" | sed -n 's/^MSG=//p' | while IFS=$'\t' read -r id type outcome subject body; do
        [ "$outcome" = "-" ] && outcome=""
        say "收到 [${type}${outcome:+/$outcome}] ${subject}"
      done
      # 官方顺序：先决定终端去向（cycle 里的 worker-release）并处理完，再 ack。
      if run_cycle; then idle=0; fi
      ack="$delivery"
      ;;
    empty|*)
      empties=$((empties + 1))
      if run_cycle; then idle=0; empties=0; fi
      ;;
  esac

  n=$(active_workers)
  if [ "$n" = "0" ]; then
    idle=$((idle + 1))
    if [ "$idle" -ge "$IDLE_LIMIT" ]; then
      # 退出前把手里的 delivery ack 掉，不留给下次重放。
      [ -n "$ack" ] && orca orchestration check --run "$RUN_ID" --ack "$ack" --json >/dev/null 2>&1
      triage=$(node bin/agentctl.mjs tick --json 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit(0)
rows=d.get("rows") or d.get("issues") or []
print(" ".join("#%s" % r.get("number") for r in rows if r.get("state")=="triage" and "hold:human" not in (r.get("labels") or [])))
' 2>/dev/null || true)
      if [ -n "$triage" ]; then
        say "没有可派的活，但 s:triage 里还有：${triage}。需要协调器补验收口径并转 s:ready，然后重新启动本脚本。"
        exit 13
      fi
      say "没有在跑的 worker，也没有新单可派：结束等待。"
      exit 0
    fi
  else
    idle=0
  fi

  if [ "$empties" -ge 3 ]; then
    rows=$(attention_rows)
    if [ -n "$rows" ]; then
      [ -n "$ack" ] && orca orchestration check --run "$RUN_ID" --ack "$ack" --json >/dev/null 2>&1
      say "连续 ${empties} 次空等，下面的 worker 需要处理（没有正证据不要 stop/abandon）："
      printf '%s\n' "$rows" | sed 's/^/  - /'
      exit 11
    fi
    say "连续 ${empties} 次空等：${n} 个 worker 仍在跑，无需处理，继续等。"
    empties=0
  fi
done
