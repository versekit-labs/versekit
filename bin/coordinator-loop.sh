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
#   COORD_STALL_SECS     终端输出多久没变化就判疑似卡住（默认 1800）
#   COORD_STATE_DIR      停摆检测与循环锁的状态目录（默认 ~/.orca/<项目名>-state，不进仓库）
#   COORD_PROJECT        项目名（默认取 origin 远端的仓库名，取不到用仓库目录名）；
#                        进程名是 coordinator-loop[<项目名>]，按它 pgrep 只命中本项目
#   RUN_FILE             Run id 文件（默认 ~/.orca/<项目名>-run-id）
#   CYCLE_BIN            cycle 脚本路径（默认 bin/cycle.sh；测试用）
# 退出码：
#   0   没活可等了（全部结算，没有新单可派，s:triage 里也没有待整理的 issue）
#   13  没活可派，但 s:triage 里还有 issue：要协调器补验收口径、转 s:ready（流程「停住」最常见的原因）
#   10  有消息需要协调器判断（未 ack；delivery id 与消息内容已打印）
#   11  有 worker 需要处理：worker-list 报 requiresAction/已退出；或 worker-read 末尾出现额度/限流错误；
#       或终端输出超过 COORD_STALL_SECS 没变化（疑似卡住）。不自动 stop/kill，由协调器决定。
#       例外 1：跑在 Codex 通道上的实现/返工 worker 屏幕出现用量上限（ACC-harness-codex-04）也是正证据，循环自己处理：
#       写 $STATE_DIR/codex-exhausted（解析 try again at <时间>，解析不出按 5 小时）→ worker-stop → issue 退回 s:ready；
#       冷却期内 bin/worker-channel.sh 把 model:codex 的单子改派 Sonnet，到点自动恢复
#       例外 2：跑在火山通道上的验收 worker 报额度用尽（ACC-harness-model-07）是正证据，循环自己处理、不退出：
#       写 $STATE_DIR/volc-exhausted（解析报错里的重置时间，解析不出按 5 小时）→ worker-stop → 清验收锁 → 改用千问重派
#   14  同一项目已有循环在跑（锁文件 $COORD_STATE_DIR/coordinator-loop.lock 里的 pid 还活着且是本项目的循环）；
#       什么都不做就退出，不调用 orca / cycle.sh
#   12  等待被取消（多半是同一终端跑了 run-use）或 check 报错

set -uo pipefail
cd "$(dirname "$0")/.."

# 项目名：COORD_PROJECT > origin 远端的仓库名 > 仓库目录名。
if [ -z "${COORD_PROJECT:-}" ]; then
  _url=$(git remote get-url origin 2>/dev/null || true)
  _url="${_url%/}"; _url="${_url%.git}"; _url="${_url##*[/:]}"
  COORD_PROJECT="${_url:-$(basename "$PWD")}"
fi
export COORD_PROJECT
PROC_NAME="coordinator-loop[${COORD_PROJECT}]"

# 进程名带项目名：重新执行自己一次（COORD_LOOP_REEXEC 防无限 re-exec）。
if [ -z "${COORD_LOOP_REEXEC:-}" ]; then
  export COORD_LOOP_REEXEC=1
  exec -a "$PROC_NAME" bash "$0" "$@"
fi

COORD_STATE_DIR="${COORD_STATE_DIR:-$HOME/.orca/${COORD_PROJECT}-state}"
export COORD_STATE_DIR
LOCK_FILE="$COORD_STATE_DIR/coordinator-loop.lock"

# 循环锁（不依赖 flock）：noclobber 原子创建，内容是 pid。
# 陈旧锁（pid 不在，或那个进程不是本项目的循环）接管；只删自己的锁。
release_lock() { [ "$(cat "$LOCK_FILE" 2>/dev/null)" = "$$" ] && rm -f "$LOCK_FILE"; return 0; }
acquire_lock() {
  mkdir -p "$COORD_STATE_DIR" || return 1
  local tries=0 old cmd
  while [ "$tries" -lt 5 ]; do
    tries=$((tries + 1))
    if ( set -C; printf '%s\n' "$$" > "$LOCK_FILE" ) 2>/dev/null; then return 0; fi
    old=$(cat "$LOCK_FILE" 2>/dev/null || true)
    cmd=""
    if [ -n "$old" ] && [ "$old" != "$$" ] && kill -0 "$old" 2>/dev/null; then
      cmd=$(ps -p "$old" -o command= 2>/dev/null || true)
    fi
    case "$cmd" in
      *"$PROC_NAME"*)
        echo "已有循环在跑：pid=${old}" >&2
        exit 14 ;;
    esac
    printf '[%s] 接管陈旧的循环锁（原 pid=%s）\n' "$(date '+%H:%M:%S')" "${old:-空}"
    rm -f "$LOCK_FILE"
  done
  echo "coordinator-loop: 拿不到锁：$LOCK_FILE" >&2
  exit 12
}

MAX=2
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX="${2:-2}"; shift 2 ;;
    *) printf 'coordinator-loop: 未知参数 %s\n' "$1" >&2; exit 2 ;;
  esac
done

acquire_lock
trap release_lock EXIT
trap 'exit 143' TERM
trap 'exit 130' INT HUP

RUN_FILE="${RUN_FILE:-$HOME/.orca/${COORD_PROJECT}-run-id}"
[ -s "$RUN_FILE" ] || { echo "coordinator-loop: 没有 Run id 文件：$RUN_FILE" >&2; exit 12; }
RUN_ID=$(cat "$RUN_FILE")
WAIT_MS="${COORD_WAIT_MS:-300000}"
IDLE_LIMIT="${COORD_IDLE_ROUNDS:-2}"
export CYCLE_LANES="${CYCLE_LANES:-2}"
TYPES="worker_done,escalation,question,merge_ready"
# 火山用尽记录与验收锁：与 bin/dsh-model.sh / bin/cycle.sh 用同一组默认路径。
VOLC_STATE_DIR="${STATE_DIR:-$HOME/.orca/versekit-state}"
LOCK_DIR="${LOCK_DIR:-$HOME/.orca/versekit-locks}"
export STATE_DIR="$VOLC_STATE_DIR" LOCK_DIR

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

# 停摆检测：lastHeartbeatAt 不可靠，改看终端输出。
# 对每个在跑的 worker 读 worker-read 的终端输出：
#   - 末尾出现额度/限流错误 → 立刻判「额度用尽」
#   - 输出摘要超过 COORD_STALL_SECS 没变化 → 判「疑似卡住」
# 命中的行（制表符分隔）打印到 stdout；上次摘要与时间存在 COORD_STATE_DIR，不进仓库。
stall_rows() {
  COORD_STATE_DIR="$COORD_STATE_DIR" VOLC_STATE_DIR="$VOLC_STATE_DIR" \
  COORD_STALL_SECS="${COORD_STALL_SECS:-1800}" RUN_ID="$RUN_ID" python3 -c '
import json,os,re,subprocess,sys,time,hashlib,datetime
d=os.path.join(os.environ["COORD_STATE_DIR"],"worker-watch"); os.makedirs(d,exist_ok=True)
limit=int(os.environ["COORD_STALL_SECS"]); now=time.time()
def run(args):
    try: return json.loads(subprocess.run(["orca","orchestration"]+args,capture_output=True,text=True,timeout=60).stdout or "{}")
    except Exception: return {}
def strings(o,acc):
    if isinstance(o,str): acc.append(o)
    elif isinstance(o,dict):
        for v in o.values(): strings(v,acc)
    elif isinstance(o,list):
        for v in o: strings(v,acc)
    return acc
QUOTA=re.compile(r"exceeded.{0,60}quota|hit your usage limit|usage limit.{0,80}try again|reached your .{0,40}limit|HTTP 429|rate.?limit(ed)?|too many requests",re.I)
SECRET=re.compile(r"(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:token|key|secret|password)\s*[=:]\s*\S+)",re.I)
RESET=re.compile(r"reset\s+at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}:?\d{2})?",re.I)
def reset_at(text):
    # 解析「It will reset at 2026-11-16 13:47:50 +0800 CST」；解析不出、或时间已过，按 5 小时算。
    m=RESET.search(text)
    if m:
        try:
            z=(m.group(3) or "+0800").replace(":","")
            t=datetime.datetime.strptime(m.group(1)+" "+m.group(2)+" "+z,"%Y-%m-%d %H:%M:%S %z")
            if t.timestamp()>now: return int(t.timestamp()),m.group(1)+" "+m.group(2)+" "+z
        except Exception: pass
    t=int(now+5*3600)
    return t,time.strftime("%Y-%m-%d %H:%M:%S %z",time.localtime(t))+"（按 5 小时估算）"
CODEX_QUOTA=re.compile(r"hit your usage limit|usage limit.{0,80}try again|you.ve reached your .{0,40}limit",re.I)
CODEX_RESET=re.compile(r"try again (?:at|on|after)\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}:?\d{2})?",re.I)
def codex_reset_at(text):
    m=CODEX_RESET.search(text)
    if m:
        try:
            tm=m.group(2) if m.group(2).count(":")==2 else m.group(2)+":00"
            z=(m.group(3) or "+0800").replace(":","")
            t=datetime.datetime.strptime(m.group(1)+" "+tm+" "+z,"%Y-%m-%d %H:%M:%S %z")
            if t.timestamp()>now: return int(t.timestamp()),m.group(1)+" "+tm+" "+z
        except Exception: pass
    t=int(now+5*3600)
    return t,time.strftime("%Y-%m-%d %H:%M:%S %z",time.localtime(t))+"（按 5 小时估算）"
def codex_worker(did):
    # 只有跑在 Codex 通道上的实现/返工 worker 才算「Codex 额度用完」；cycle.sh 派工时把通道写进 dispatch 记录。
    sd=os.environ["VOLC_STATE_DIR"]
    try: rec=json.load(open(os.path.join(sd,"dispatch-%s.json"%did)))
    except Exception: return None
    if rec.get("role") not in ("engineer","rework"): return None
    return rec.get("issue") if rec.get("channel")=="codex" else None
def volc_worker(did):
    # 只有跑在火山通道上的验收 worker 才算「火山额度用尽」；其它通道的额度错误仍交给协调器。
    sd=os.environ["VOLC_STATE_DIR"]
    try: rec=json.load(open(os.path.join(sd,"dispatch-%s.json"%did)))
    except Exception: return None
    if rec.get("role")!="acceptance": return None
    try: ch=open(os.path.join(sd,"acceptance.channel")).read().strip()
    except Exception: ch=""
    return rec.get("issue") if ch=="volc" else None
ws=(run(["worker-list","--run",os.environ["RUN_ID"],"--json"]).get("result") or {}).get("workers") or []
live=set()
for w in ws:
    if w.get("terminalState")!="active": continue
    did=w.get("dispatchId") or ""
    if not did: continue
    live.add(did)
    # issue 号只取自派工记录 dispatch-<id>.json；worktree 目录名会被复用（lane 复用同一目录），不可信。
    try: ri=json.load(open(os.path.join(os.environ["VOLC_STATE_DIR"],"dispatch-%s.json"%did))).get("issue")
    except Exception: ri=None
    issue="#"+str(ri) if ri not in (None,"") else "issue 未知"
    r=run(["worker-read","--dispatch",did,"--source","terminal","--limit","60","--json"])
    if not r.get("ok",True): continue
    # 真实 worker-read：终端输出在 result.terminal.tail，其后跟着 cursor/status/projection 等元数据，
    # 只取 terminal.tail，避免额度检测/末尾打印/摘要被元数据挤掉；没有 terminal 键时才退回 result.text 或全部字符串。
    res=r.get("result")
    term=res.get("terminal") if isinstance(res,dict) else None
    if isinstance(term,dict) and "tail" in term: src=term.get("tail")
    elif isinstance(res,dict) and isinstance(res.get("text"),str): src=res.get("text")
    else: src=res
    text="\n".join(strings(src,[]))
    lines=[l for l in text.splitlines() if l.strip()]
    tail=lines[-8:]
    h=hashlib.sha256("\n".join(lines[-40:]).encode()).hexdigest()
    sf=os.path.join(d,did+".json")
    try: st=json.load(open(sf))
    except Exception: st={}
    if st.get("hash")!=h: st={"hash":h,"since":now}
    json.dump(st,open(sf,"w"))
    reason=None
    if QUOTA.search("\n".join(lines[-15:])): reason="额度用尽"
    elif now-st["since"]>=limit: reason="疑似卡住（终端输出 %d 秒没变化）" % int(now-st["since"])
    if reason:
        vu,vt,vi="-","-","-"
        if reason=="额度用尽":
            ci0=codex_worker(did)
            if ci0 is not None and CODEX_QUOTA.search("\n".join(lines[-15:])):
                ep,ct=codex_reset_at("\n".join(lines[-15:])); issue="#"+str(ci0)
                print("%s\t%s\t%s\t%s\t%s\t%s\t%s\tcodex" % (issue,did,reason," ⏎ ".join(SECRET.sub("***",l)[:200] for l in tail),ep,ct,ci0))
                continue
            vi0=volc_worker(did)
            if vi0 is not None:
                ep,vt=reset_at("\n".join(lines[-15:])); vu=str(ep); vi=str(vi0); issue="#"+vi
        print("%s\t%s\t%s\t%s\t%s\t%s\t%s" % (issue,did,reason," ⏎ ".join(SECRET.sub("***",l)[:200] for l in tail),vu,vt,vi))
for f in os.listdir(d):
    if f.endswith(".json") and f[:-5] not in live: os.remove(os.path.join(d,f))
' 2>/dev/null
}

run_cycle() {
  local out
  out=$("${CYCLE_BIN:-bin/cycle.sh}" --max "$MAX" --no-consume 2>&1) || true
  # 完整输出留一份：屏幕上只摘 ✓✗ 行，出错时要能看到 stderr 和失败阶段。
  { printf '===== %s\n' "$(date '+%F %T')"; printf '%s\n' "$out"; } >> "${CYCLE_LOG:-$COORD_STATE_DIR/cycle-rounds.log}"
  printf '%s\n' "$out" | grep -E '✓|✗|↩|→ |worker-release|⚠' | sed 's/^/    /' || true
  printf '%s\n' "$out" | grep -qE '✗' && printf '    （完整输出：%s）\n' "${CYCLE_LOG:-$COORD_STATE_DIR/cycle-rounds.log}"
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
        [ "$type" = "heartbeat" ] && continue
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

  stalled=$(stall_rows)
  # 火山额度用尽是正证据（ACC-harness-model-07）：自动 记录用尽 → worker-stop → 清验收锁 → 改用千问重派；
  # 其余停摆（疑似卡住、非火山的额度错误）仍交给协调器。
  if [ -n "$stalled" ]; then
    rest=""
    while IFS=$'\t' read -r issue did reason tail vu vt vi kind; do
      [ -n "$issue" ] || continue
      if [ "${kind:-}" = "codex" ]; then
        # Codex 额度用完（ACC-harness-codex-04）：记冷却 → worker-stop → issue 退回 s:ready；冷却期内 model:codex 改派 Sonnet。
        say "Codex 额度用完（${issue} dispatch=${did}）：worker-read 末尾 ⏎ ${tail}"
        mkdir -p "$VOLC_STATE_DIR" && printf '%s\t%s\n' "$vu" "$vt" > "$VOLC_STATE_DIR/codex-exhausted"
        say "  1/3 已记「Codex 额度用完，到 ${vt} 为止」→ $VOLC_STATE_DIR/codex-exhausted（worker-channel.sh 到期前把 model:codex 的单子改派 Sonnet）"
        if orca orchestration worker-stop --dispatch "$did" --json >/dev/null 2>&1; then
          say "  2/3 已 worker-stop dispatch=${did}"
        else
          say "  2/3 ✗ worker-stop dispatch=${did} 失败，下一轮仍会重试"
        fi
        if node "${AGENTCTL_BIN:-bin/agentctl.mjs}" set --issue "$vi" --to ready --force >/dev/null 2>&1; then
          say "  3/3 已把 #${vi} 退回 s:ready；下一轮 cycle 改派 Sonnet（见下方派工）"
        else
          say "  3/3 ✗ 退回 #${vi} 到 s:ready 失败，需要协调器手动处理"
        fi
        run_cycle || true
        continue
      fi
      if [ "${vu:--}" = "-" ]; then
        rest="${rest:+$rest$'\n'}$(printf '%s\t%s\t%s\t%s' "$issue" "$did" "$reason" "$tail")"
        continue
      fi
      say "火山额度用尽（${issue} dispatch=${did}）：worker-read 末尾 ⏎ ${tail}"
      mkdir -p "$VOLC_STATE_DIR" && printf '%s\t%s\n' "$vu" "$vt" > "$VOLC_STATE_DIR/volc-exhausted"
      say "  1/3 已记「火山额度用尽，到 ${vt} 为止」→ $VOLC_STATE_DIR/volc-exhausted（dsh-model.sh 到期前选千问）"
      if orca orchestration worker-stop --dispatch "$did" --json >/dev/null 2>&1; then
        say "  2/3 已 worker-stop dispatch=${did}"
      else
        say "  2/3 ✗ worker-stop dispatch=${did} 失败，下一轮仍会重试"
      fi
      rm -rf "$LOCK_DIR"/accept-"${vi}"-*.lock
      rm -f "$VOLC_STATE_DIR/acceptance.dispatch" "$VOLC_STATE_DIR/acceptance.channel" "$VOLC_STATE_DIR/acceptance.model"
      say "  3/3 已清 #${vi} 的验收锁与验收终端记录；本轮改用千问重派（见下方派工）"
      run_cycle || true
    done <<< "$stalled"
    stalled="$rest"
  fi
  if [ -n "$stalled" ]; then
    [ -n "$ack" ] && orca orchestration check --run "$RUN_ID" --ack "$ack" --json >/dev/null 2>&1
    say "✗ 有 worker 停摆，需要协调器处理（不自动 stop/kill；确认后 worker-stop 再重派）："
    printf '%s\n' "$stalled" | while IFS=$'\t' read -r issue did reason tail; do
      case "$issue" in "#"*) issue="issue=$issue" ;; esac
      printf '  - %s dispatch=%s 原因=%s\n    worker-read 末尾：%s\n' "$issue" "$did" "$reason" "$tail"
    done
    exit 11
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
