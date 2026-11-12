#!/usr/bin/env bash
# 一轮协调：**官方 coordinator loop 的机械段落**
# （orca skills get orchestration --full / Canonical supervised loop）。
#
# Run 是命名空间 + 协调器收件箱，所有权归人对话的协调器（见 docs/COORDINATOR.md）。
# cycle.sh 是机械脚本：**不拥有 Run、不消费收件箱**，只做不需要所有权的段落：
#
#   1. 机械迁移      agentctl tick --apply        （doing 有 PR → review）
#   2. 合并          agentctl merge --pending      （脚本合并，双门禁）
#   3. 派工实现      claim → worker-start          （一次建 Task + Dispatch）
#   4. 派工验收      queue + 锁 → worker-start
#   5. 消费消息      归协调器；脚本只做只读 peek，失败留痕后继续
#   6. 结算          归协调器；脚本不 worker-list / release
#
# 两条来自官方指南的硬约束，改动时不要违反：
#   - `worker_done` 只发一次，必须带 taskId + dispatchId；心跳不等于完成。
#   - 空等/超时是 checkpoint，不是失败；只有正证据（exited）才能 stop/abandon/retry。
#
# 用法：
#   bin/cycle.sh [--max N] [--dry-run] [--no-consume]
#
# 环境变量：
#   ENGINEER_WT / ACCEPTANCE_WT   worktree selector（默认 current）
#   WORKER_AGENT                  指定则用 worker-start --agent，否则走 worker-up.sh
#                                 （dsh 需要预配置 profile，--agent 会停在 landing page）
#
# 退出码：0 正常（含"没活"）；1 有派工失败。

set -euo pipefail
cd "$(dirname "$0")/.."

MAX=1
DRY=0
CONSUME=1
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-consume) CONSUME=0; shift ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

ENGINEER_WT="${ENGINEER_WT:-current}"
ACCEPTANCE_WT="${ACCEPTANCE_WT:-current}"
WORKER_AGENT="${WORKER_AGENT:-}"
FAILED=0

LOCK_DIR="${LOCK_DIR:-$HOME/.orca/versekit-locks}"
STATE_DIR="${STATE_DIR:-$HOME/.orca/versekit-state}"
ACCEPT_LOCK_TTL_MIN="${ACCEPT_LOCK_TTL_MIN:-45}"
mkdir -p "$LOCK_DIR" "$STATE_DIR"
find "$LOCK_DIR" -maxdepth 1 -type d -name 'accept-*.lock' -mmin +"$ACCEPT_LOCK_TTL_MIN" -exec rm -rf {} + 2>/dev/null || true

log() { printf '%s\n' "$*"; }

# 所有权探测失败不能静默：逐轮写日志；连续失败 >=2 次再落一个协调器开场会读的
# alert 文件。失败只影响「消费/结算」段落，不影响派工与合并。
OWNER_FAIL_LOG="$STATE_DIR/cycle-owner-failures.log"
reset_owner_failures() {
  : > "$OWNER_FAIL_LOG"
  rm -f "$STATE_DIR/cycle-owner-alert.txt"
}
record_owner_failure() {
  local code="$1" msg="$2" n
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$RUN_ID" "$code" "$msg" >> "$OWNER_FAIL_LOG"
  n=$(wc -l < "$OWNER_FAIL_LOG" | tr -d ' ')
  if [ "${n:-0}" -ge 2 ]; then
    printf 'Run 所有权探测连续失败 %s 次（%s）。\n最后错误：%s %s\ncycle.sh 已继续派工/合并；消费与结算仍归协调器，未 ack、未释放终端。\n' \
      "$n" "$(date -u +%FT%TZ)" "$code" "$msg" > "$STATE_DIR/cycle-owner-alert.txt"
    log "  ⚠ 所有权探测连续失败 ${n} 次，已写入 $STATE_DIR/cycle-owner-alert.txt（协调器开场会读）"
  fi
}

# 同一时刻只允许一个协调器在跑。launchd 与手动触发很容易撞车——
# 撞车的后果不是报错，是"两个人都以为自己在派工"。
CYCLE_LOCK="$LOCK_DIR/cycle.lock"
if ! mkdir "$CYCLE_LOCK" 2>/dev/null; then
  if [ -n "$(find "$CYCLE_LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
    rm -rf "$CYCLE_LOCK"
    mkdir "$CYCLE_LOCK" 2>/dev/null || { log "另一个协调器在跑，本轮跳过"; exit 0; }
  else
    log "另一个协调器在跑（锁 ${CYCLE_LOCK}），本轮跳过"
    exit 0
  fi
fi
trap 'rm -rf "$CYCLE_LOCK"' EXIT

# 从 JSON 里取点号路径（缺失打空）。失败不抛错——CLI 版本差异不该让整轮崩掉。
# 用 stdin 传 JSON：消息批次可能很大，塞 argv 会撞 ARG_MAX。
jget() {
  python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else d)
' "$1" 2>/dev/null || true
}

# 取嵌套路径；多个候选按顺序试。
# task-create 的 task id 在 result.task.id，worker-start 的 dispatch 在 result.dispatch.id
# 或顶层 —— 不同版本不一样，所以按候选列表试，而不是猜一个。
jpick() {
  python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
for path in sys.argv[1:]:
    cur=d
    ok=True
    for k in path.split("."):
        if isinstance(cur,dict) and k in cur: cur=cur[k]
        else: ok=False; break
    if ok and isinstance(cur,str) and cur:
        print(cur); break
' "$@" 2>/dev/null || true
}

# 递归找第一个非空的键（worker-start 的 receipt 层级随版本变）。
jfind() {
  python3 -c '
import json,sys
key=sys.argv[1]
def find(o):
    if isinstance(o,dict):
        v=o.get(key)
        if isinstance(v,str) and v: return v
        for x in o.values():
            r=find(x)
            if r: return r
    elif isinstance(o,list):
        for x in o:
            r=find(x)
            if r: return r
    return ""
try: print(find(json.load(sys.stdin)))
except Exception: print("")
' "$1" 2>/dev/null || true
}

# ---------------------------------------------------------------- 0. Run
# Run 是命名空间 + 协调器收件箱，所有权归协调器（docs/COORDINATOR.md）。
# cycle.sh 不 run-use、不创建 Run：automation precheck 没有终端句柄，绑定必然失败；
# task-create / worker-start 需要发送方句柄：显式带 --run 与 Run 所有者的 --from，
# 既不需要脚本自己的终端，也不改变 Run 所有权。
RUN_FILE="${RUN_FILE:-$HOME/.orca/versekit-run-id}"
if [ -s "$RUN_FILE" ]; then
  RUN_ID=$(cat "$RUN_FILE")
else
  log "✗ 没有 Run id 文件：$RUN_FILE"
  log "  Run 归协调器：先在协调器终端 run-use，把 id 写进这个文件；cycle.sh 不创建、不抢 Run"
  exit 1
fi
[ -n "${RUN_ID:-}" ] || { log "拿不到 Run id，无法派工"; exit 1; }
RUN_OWNER=$(orca orchestration run-show --id "$RUN_ID" --json 2>/dev/null | jget result.run.coordinator_handle)
SENDER="${RUN_OWNER:-${ORCA_TERMINAL_HANDLE:-}}"
[ -n "${SENDER:-}" ] || { log "✗ Run 没有可用的所有者句柄，无法派工（不 run-use、不抢所有权）"; exit 1; }
log "Run: ${RUN_ID}（所有者 ${RUN_OWNER:-未知}；本进程终端 ${ORCA_TERMINAL_HANDLE:-无}；派工 --from ${SENDER}）"

# ---------------------------------------------------------------- 1. 机械迁移
log "== 1/6 机械迁移 =="
if [ "$DRY" = "1" ]; then
  node bin/agentctl.mjs tick 2>&1 | sed -n '/本轮会迁移/,$p' | head -10 || true
else
  node bin/agentctl.mjs tick --apply 2>&1 | sed -n '/已迁移\|本轮会迁移/,$p' | head -10 || true
fi

# ---------------------------------------------------------------- 2. 合并
# 合并由 label 状态驱动，不依赖消息顺序：s:accept + verdict PASS + 门禁绿就合。
# 这样即使消息丢了一条，状态机也会在下一轮把它捞回来。
log "== 2/6 合并 =="
if [ "$DRY" = "1" ]; then
  node bin/agentctl.mjs merge --pending --dry-run 2>&1 | head -10 || true
else
  node bin/agentctl.mjs merge --pending 2>&1 | head -10 || true
fi

# ---------------------------------------------------------------- 终端复用
# 官方 Completion accounting 的第一选项是"同一终端接下一单"。复用有两个好处：
# 不泄漏终端，worker 也保留已经初始化的 profile（dsh 尤其需要）。
ensure_terminal() {
  local role="$1" wt="$2" title="$3"
  local f="$STATE_DIR/$role.terminal" cf="$STATE_DIR/$role.channel"
  # dsh worker 的模型通道（volc/qwen）。WORKER_AGENT 指定时走原生 agent，不涉及。
  local channel=""
  if [ -z "$WORKER_AGENT" ]; then
    channel=$(bin/dsh-model.sh) || { log "    ✗ 没有可用的模型通道（火山与千问都不可用）"; return 1; }
  fi
  if [ -s "$f" ]; then
    local h; h=$(cat "$f")
    # 通道变了（火山→千问或反过来）就不能复用：终端里的 dsh 已经绑定了旧模型。
    # 旧终端不关——可能还有 dispatch 在用；只解除映射并留痕，空闲终端由人或 TTL 清理。
    if [ -n "$channel" ] && [ "$(cat "$cf" 2>/dev/null)" != "$channel" ]; then
      log "    · $role 模型通道变为 ${channel}，不复用旧终端 $h"
      rm -f "$f"
    elif orca terminal show --terminal "$h" --json >/dev/null 2>&1; then
      printf '%s\n' "$h"; return 0
    else
      rm -f "$f"
    fi
  fi
  local new
  if [ -n "$WORKER_AGENT" ]; then
    made=$(orca terminal create --worktree "$wt" --command "$WORKER_AGENT" --title "$title" --json 2>/dev/null || true)
    new=$(printf '%s' "$made" | jfind handle)
  else
    new=$(DSH_CHANNEL="$channel" bin/worker-up.sh "$wt" "$title" 2>/dev/null) || new=""
  fi
  [ -n "$new" ] || return 1
  printf '%s' "$new" > "$f"
  [ -n "$channel" ] && printf '%s' "$channel" > "$cf"
  printf '%s\n' "$new"
}

# 派工：一次建 Task + Dispatch，再把 dispatch 与 issue 的对应写下来。
# 没有这份对应，收到 escalation 时协调器只知道"某个 dispatch 卡住了"，不知道是哪个工单。
record_dispatch() {
  local dispatch="$1" issue="$2" role="$3" pull="${4:-}"
  [ -n "$dispatch" ] || return 0
  printf '{"issue":%s,"role":"%s","pull":"%s"}\n' "$issue" "$role" "$pull" > "$STATE_DIR/dispatch-$dispatch.json"
}

issue_for_dispatch() {
  local f="$STATE_DIR/dispatch-$1.json"
  [ -f "$f" ] || return 0
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("issue",""))' "$f" 2>/dev/null || true
}

dispatch_one() {
  local role="$1" wt="$2"
  local claimed
  # dry-run 必须连 claim 都用只读版，否则"演练"会真的把 issue 抢走。
  if [ "$DRY" = "1" ]; then
    claimed=$(node bin/agentctl.mjs claim --role "$role" --dry-run --json 2>/dev/null) || {
      log "  ✗ $role: claim 失败"; return 1
    }
  else
    claimed=$(node bin/agentctl.mjs claim --role "$role" --json 2>/dev/null) || {
      log "  ✗ $role: claim 失败"; return 1
    }
  fi
  local num title body
  num=$(printf '%s' "$claimed" | jget claimed.number)
  if [ -z "$num" ]; then
    log "  · $role: 没有可派的活"
    # 口径不合格时把原因打出来，否则"没活"会掩盖"工单写坏了"
    printf '%s' "$claimed" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for s in d.get("skipped") or []:
    sys.stderr.write("    ✗ #%s 口径不合格：%s\n" % (s.get("number"), s.get("why")))
' 2>/dev/null || true
    return 0
  fi
  title=$(printf '%s' "$claimed" | jget claimed.title)
  body=$(printf '%s' "$claimed" | jget claimed.body)
  local acc; acc=$(printf '%s' "$claimed" | python3 -c 'import json,sys;print(", ".join(json.load(sys.stdin)["claimed"].get("acc") or []))' 2>/dev/null || true)

  if [ "$DRY" = "1" ]; then
    # claim --dry-run 不返回 claimed，只返回 wouldClaim；这里逐条报告。
    printf '%s' "$claimed" | python3 -c '
import json,sys
role, wt = sys.argv[1], sys.argv[2]
d = json.load(sys.stdin)
would = d.get("wouldClaim") or []
if not would:
    print("  · [dry-run] 没有可派的活")
for w in would:
    print("  · [dry-run] 会派 #%s 给 %s（worktree=%s，口径 %s）" % (
        w.get("number"), role, wt, ", ".join(w.get("ids") or [])))
for s in d.get("skipped") or []:
    print("  ✗ 跳过 #%s：%s" % (s.get("number"), s.get("why")))
' "$role" "$wt" 2>/dev/null || log "  · [dry-run] 没有可派的活"
    return 0
  fi

  log "  → #$num ${title}（口径 ${acc}）"
  local handle
  if ! handle=$(ensure_terminal "$role" "$wt" "worker: #$num"); then
    log "    ✗ 起 worker 终端失败，把 #$num 退回 s:ready"
    node bin/agentctl.mjs set --issue "$num" --to ready >/dev/null 2>&1 || \
      log "    ⚠ 自动退回失败，请手工把 #$num 改成 s:ready"
    return 1
  fi

  # spec 按官方 Task-spec contract 写：Target / Change / Constraints / Ownership / Observable acceptance。
  local spec
  spec=$(printf '目标：#%s %s\n\n改动：按下面工单的「口径」逐条实现。\n\n约束：\n- 只改工单「涉及」列出的文件/模块；不改 api 形状、数据库 schema、commands.mjs 的命令定义\n- 不改 issue 的 s:* label（状态由协调器迁移）\n- 不合并 PR、不给自己发通行证\n- 完成后必须能通过 npm run ci\n\n归属：你在 %s 这个 worktree 里工作，只动本分支。\n\n可观察验收：\n- 开 PR，body 含 Closes #%s 与证据包 YAML（head_sha、acceptance 逐条 status: pass）\n- 用 worker_done 结束，带 taskId 与 dispatchId 和 --outcome\n\n工单原文：\n%s' \
    "$num" "$title" "$wt" "$num" "$body")

  local task taskid start dispatch
  task=$(orca orchestration task-create --run "$RUN_ID" --from "$SENDER" --task-title "issue #$num 实现" --spec "$spec" --json 2>&1) || task=""
  taskid=$(printf '%s' "$task" | jpick result.task.id taskId result.id)
  if [ -z "$taskid" ]; then
    log "    ✗ task-create 失败：$(printf '%s' "$task" | head -c 300)"
    log "    退回 s:ready"
    node bin/agentctl.mjs set --issue "$num" --to ready >/dev/null 2>&1 || log "    ⚠ 退回失败，请手工处理 #$num"
    return 1
  fi

  start=$(orca orchestration worker-start --run "$RUN_ID" --from "$SENDER" --task "$taskid" --terminal "$handle" --worktree "$wt" --json 2>/dev/null) || start=""
  dispatch=$(printf '%s' "$start" | jpick result.dispatchId result.dispatch.id dispatchId)
  if [ -z "$dispatch" ]; then
    log "    ✗ worker-start 失败：$(printf '%s' "$start" | head -c 300)"
    log "    退回 s:ready"
    node bin/agentctl.mjs set --issue "$num" --to ready >/dev/null 2>&1 || log "    ⚠ 退回失败，请手工处理 #$num"
    return 1
  fi
  record_dispatch "$dispatch" "$num" "$role"
  log "    ✓ 已派工 task=$taskid dispatch=$dispatch"
  return 0
}

log "== 3/6 派工 =="
# BSD 的 seq 1 0 会倒着输出 "1 0"，--max 0 反而派两次。显式挡掉。
if [ "$MAX" -gt 0 ]; then
  for i in $(seq 1 "$MAX"); do
    dispatch_one engineer "$ENGINEER_WT" || FAILED=1
  done
fi

# ---------------------------------------------------------------- 4. 验收派工
log "== 4/6 验收派工 =="

dispatch_acceptance() {
  local queue
  queue=$(node bin/agentctl.mjs claim --role acceptance --json 2>/dev/null) || {
    log "  ✗ acceptance: 取队列失败"; return 1
  }
  local num pull head acc title
  num=$(printf '%s' "$queue" | python3 -c 'import json,sys;q=json.load(sys.stdin).get("queue") or [];print(q[0]["number"] if q else "")' 2>/dev/null || true)
  if [ -z "$num" ]; then
    log "  · acceptance: 没有待验收的"
    return 0
  fi
  pull=$(printf '%s' "$queue" | python3 -c 'import json,sys;q=json.load(sys.stdin)["queue"];print(q[0]["pull"] or "")' 2>/dev/null || true)
  head=$(printf '%s' "$queue" | python3 -c 'import json,sys;q=json.load(sys.stdin)["queue"];print(q[0].get("head") or "")' 2>/dev/null || true)
  acc=$(printf '%s' "$queue" | python3 -c 'import json,sys;q=json.load(sys.stdin)["queue"];print(", ".join(q[0].get("acc") or []))' 2>/dev/null || true)
  title=$(printf '%s' "$queue" | python3 -c 'import json,sys;q=json.load(sys.stdin)["queue"];print(q[0]["title"])' 2>/dev/null || true)

  if [ "$DRY" = "1" ]; then
    log "  · [dry-run] 会派验收：issue #$num / PR #${pull}（head ${head:0:7}，口径 ${acc}）"
    return 0
  fi

  # 锁按 issue + head_sha：打回后同一 issue 的新 head 能立刻复审，不会被 TTL 误伤。
  local lock="$LOCK_DIR/accept-$num-${head:0:8}.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    log "  · 验收 #$num @${head:0:7} 已在跑（锁存在），跳过"
    return 0
  fi

  log "  → 验收 #${num}（PR #${pull}，head ${head:0:7}）$title"
  local handle
  if ! handle=$(ensure_terminal acceptance "$ACCEPTANCE_WT" "verify: #$num"); then
    log "    ✗ 起验收终端失败"
    rm -rf "$lock"
    return 1
  fi

  local spec
  spec=$(printf '目标：验收 issue #%s 的 PR #%s（head %s）。\n\n改动：不改实现代码，只产出判定。\n\n约束：\n- 只按 docs/design/ACCEPTANCE.md 的条目判定，条目外的「我觉得」不阻塞 PR\n- 不改实现代码、不合并 PR、不改 s:* label\n- 需要看界面时用 8788 端口，避开实现方可能占用的 8787\n\n归属：你在 %s 这个 worktree 里，验收必须换上下文，不看实现方的思考过程。\n\n可观察验收（必须逐条做到）：\n1. 拉 PR diff 与 body 里的证据包 YAML\n2. 逐条比对：%s\n3. 本地跑 npm run ci\n4. 在 PR 留一条评论，正文必须含 ```yaml 块：\n   verdict: PASS|FAIL\n   round: <第几轮>\n   head_sha: "<PR 当前 head>"\n   acceptance:\n     - id: <ACC id>\n       status: pass|fail\n   FAIL 时额外给 failed: 列表，每条含 item / expected / observed / repro\n5. 不要改 s:* label，状态迁移由协调器做（AGENT-COLLAB §2）\n6. PASS 发一条 merge_ready 消息；FAIL 发 escalation 说明卡在哪\n7. 用 worker_done 结束，带 taskId 与 dispatchId 和 --outcome' \
    "$num" "$pull" "$head" "$ACCEPTANCE_WT" "$acc")

  local task taskid start dispatch
  task=$(orca orchestration task-create --run "$RUN_ID" --from "$SENDER" --task-title "验收 #$num" --spec "$spec" --json 2>&1) || task=""
  taskid=$(printf '%s' "$task" | jpick result.task.id taskId result.id)
  if [ -z "$taskid" ]; then
    log "    ✗ task-create 失败：$(printf '%s' "$task" | head -c 300)"
    rm -rf "$lock"
    return 1
  fi

  start=$(orca orchestration worker-start --run "$RUN_ID" --from "$SENDER" --task "$taskid" --terminal "$handle" --worktree "$ACCEPTANCE_WT" --json 2>/dev/null) || start=""
  dispatch=$(printf '%s' "$start" | jpick result.dispatchId result.dispatch.id dispatchId)
  if [ -z "$dispatch" ]; then
    log "    ✗ worker-start 失败"
    rm -rf "$lock"
    return 1
  fi
  record_dispatch "$dispatch" "$num" "acceptance" "$pull"
  log "    ✓ 已派验收 task=$taskid dispatch=$dispatch"
  return 0
}

dispatch_acceptance || FAILED=1

# ---------------------------------------------------------------- 5. 消费消息
# 收件箱归协调器（docs/COORDINATOR.md）：cycle.sh 不拥有 Run，不 check 消费、不 ack、
# 不处理消息。这里只做一次只读 --peek：它不标记已读、不消费消息，只用来发现
# 「无终端句柄 / 所有权被抢」并把原因留痕；失败不阻断派工与合并。
log "== 5/6 消费消息 =="
if [ "$CONSUME" = "0" ] || [ "$DRY" = "1" ]; then
  log "  · 跳过（dry-run / --no-consume；收件箱归协调器）"
elif [ -z "${ORCA_TERMINAL_HANDLE:-}" ]; then
  # automation precheck 的正常形态：没有终端句柄，也就没有 Run 所有权。
  # 这不是故障；记一行状态供协调器开场查看，不刷 alert。
  reset_owner_failures
  printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$RUN_ID" "no_terminal" >> "$STATE_DIR/cycle-owner-state.log"
  log "  · 跳过消费：无终端句柄（automation precheck），收件箱归协调器"
else
  probe=$(orca orchestration check --run "$RUN_ID" --peek --json 2>&1) || true
  if [ "$(printf '%s' "$probe" | jget ok)" = "True" ]; then
    reset_owner_failures
    log "  · 跳过消费：本终端可见 Run，但收件箱归协调器（cycle.sh 只 peek，不 ack）"
  else
    code=$(printf '%s' "$probe" | jget error.code)
    msg=$(printf '%s' "$probe" | jget error.message | head -c 240)
    log "  · 跳过消费：本终端不是 Run 所有者（${code:-unknown} ${msg:-没有错误消息}）"
    log "    收件箱归协调器；cycle.sh 不 run-use、不 ack、不抢占"
    record_owner_failure "${code:-unknown}" "${msg:-没有错误消息}"
  fi
fi

# ---------------------------------------------------------------- 6. 结算
# 终端账本（reclaimable / release）同样属于 Run 所有者。cycle.sh 不查、不释放，
# 避免在无所有权时抢协调器的收件箱与终端资源；结算由协调器在开场/收尾时做。
log "== 6/6 结算 =="
log "  · 跳过：终端结算归协调器（cycle.sh 不拥有 Run）"

if [ "$FAILED" = "1" ]; then
  log "本轮有失败，见上方 ✗"
  exit 1
fi
log "本轮完成"