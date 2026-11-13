#!/usr/bin/env bash
# 一轮协调：**官方 coordinator loop 的机械段落**
# （orca skills get orchestration --full / Canonical supervised loop）。
#
# Run 是命名空间 + 协调器收件箱，所有权归人对话的协调器（见 docs/COORDINATOR.md）。
# cycle.sh 是机械脚本：**不拥有 Run、不消费收件箱**，只做不需要所有权的段落：
#
#   1. 机械迁移      agentctl tick --apply        （doing 有 PR → review）
#   2. 合并          agentctl merge --pending      （脚本合并，双门禁）
#   3. 派工实现      claim → worker-start          （一次建 Task；首次失败用同一 task 退避重试）
#      派工返工      s:changes → 原 PR 原分支      （引用最近验收 FAIL 评论，3 轮封顶转 blocked）
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
#   ENGINEER_WT / ACCEPTANCE_WT   worktree selector（默认 current；仅返工兜底与验收用）
#   CYCLE_LANES                   并行 lane 上限（默认 3；--max 超过时按此封顶）
#   CYCLE_LANE_IDLE_TTL_MIN       观测不到 lane 的 dispatch 状态时，多久视为空闲（默认 90）
#   WORKER_AGENT                  指定则用 worker-start --agent，否则走 worker-up.sh
#                                 （dsh 需要预配置 profile，--agent 会停在 landing page）
#   CYCLE_WORKER_RETRIES          worker-start 首次失败后的重试次数（默认 2）
#   CYCLE_RETRY_BACKOFF_1/_2      第 1/2 次失败后的等待秒数（默认 2 / 4）
#
# 并行规则（ACC-harness-cycle-08/09/10）：
#   - 每个 issue 一个独立 worktree、独立终端、独立 Dispatch；lane 上限默认 3。
#   - 工单「涉及」文件相交的 issue 串行；没写「涉及」按串行（由 agentctl claim 判定）。
#   - lane 的 worktree 在空闲后复用，不无限新建；同一 PR 同一 head 不重复派验收（验收锁）。
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
# worker-start 首次失败后的自动重试次数（口径 ACC-harness-cycle-04：至多 2 次）。
# 重试用**同一个 task**，不重建；等待时间可调，便于演练时缩短。
WORKER_RETRIES="${CYCLE_WORKER_RETRIES:-2}"
case "$WORKER_RETRIES" in ''|*[!0-9]*) WORKER_RETRIES=2 ;; esac
FAILED=0

LOCK_DIR="${LOCK_DIR:-$HOME/.orca/versekit-locks}"
STATE_DIR="${STATE_DIR:-$HOME/.orca/versekit-state}"
ACCEPT_LOCK_TTL_MIN="${ACCEPT_LOCK_TTL_MIN:-45}"
mkdir -p "$LOCK_DIR" "$STATE_DIR"
find "$LOCK_DIR" -maxdepth 1 -type d -name 'accept-*.lock' -mmin +"$ACCEPT_LOCK_TTL_MIN" -exec rm -rf {} + 2>/dev/null || true

# 并行 lane 数上限。--max 是"这一轮想派几个"，这里是"同一时刻最多几个"。
# 两个都要守：只守 --max，调用方写 --max 10 就会开 10 个 worktree。
CYCLE_LANES="${CYCLE_LANES:-${CYCLE_MAX_LANES:-3}}"
case "$CYCLE_LANES" in ''|*[!0-9]*) CYCLE_LANES=3 ;; esac
[ "$CYCLE_LANES" -ge 1 ] || CYCLE_LANES=1
CYCLE_LANE_IDLE_TTL_MIN="${CYCLE_LANE_IDLE_TTL_MIN:-90}"
case "$CYCLE_LANE_IDLE_TTL_MIN" in ''|*[!0-9]*) CYCLE_LANE_IDLE_TTL_MIN=90 ;; esac
LANE_DIR="$STATE_DIR/lanes"
mkdir -p "$LANE_DIR"
LANES_USED=""   # 本轮已经用掉的 lane，绝不在一轮内复用（否则两个 issue 会共用同一 worktree）

log() { printf '%s\n' "$*"; }

# 第 N 次失败后等多久再重试（秒）。默认 2s / 4s，退避而不是立刻打同一个接口。
retry_backoff() {
  case "$1" in
    1) printf '%s' "${CYCLE_RETRY_BACKOFF_1:-2}" ;;
    2) printf '%s' "${CYCLE_RETRY_BACKOFF_2:-4}" ;;
    *) printf '0' ;;
  esac
}

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
  local role="$1" wt="$2" title="$3" branch="${4:-}" key="${5:-$1}"
  local f="$STATE_DIR/$key.terminal" cf="$STATE_DIR/$key.channel" bf="$STATE_DIR/$key.branch"
  # dsh worker 的模型通道（volc/qwen）。WORKER_AGENT 指定时走原生 agent，不涉及。
  local channel=""
  if [ -z "$WORKER_AGENT" ]; then
    channel=$(bin/dsh-model.sh) || { log "    ✗ 没有可用的模型通道（火山与千问都不可用）"; return 1; }
  fi
  if [ -s "$f" ]; then
    local h; h=$(cat "$f")
    # 返工换了分支就不能复用：终端里的工作树还停在上一单的分支上。
    if [ -n "$branch" ] && [ "$(cat "$bf" 2>/dev/null || true)" != "$branch" ]; then
      log "    · $role 目标分支变为 ${branch}，不复用旧终端 $h"
      rm -f "$f"
    # 通道变了（火山→千问或反过来）就不能复用：终端里的 dsh 已经绑定了旧模型。
    # 旧终端不关——可能还有 dispatch 在用；只解除映射并留痕，空闲终端由人或 TTL 清理。
    elif [ -n "$channel" ] && [ "$(cat "$cf" 2>/dev/null || true)" != "$channel" ]; then
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
  [ -n "$branch" ] && printf '%s' "$branch" > "$bf"
  printf '%s\n' "$new"
}

# 派工：一次建 Task + Dispatch，再把 dispatch 与 issue 的对应写下来。
# 没有这份对应，收到 escalation 时协调器只知道"某个 dispatch 卡住了"，不知道是哪个工单。
record_dispatch() {
  local dispatch="$1" issue="$2" role="$3" pull="${4:-}" files="${5:-}"
  [ -n "$dispatch" ] || return 0
  python3 -c '
import json,sys
dispatch, issue, role, pull, files = sys.argv[1:6]
json.dump(
    {"issue": int(issue), "role": role, "pull": pull, "files": [f for f in files.split(",") if f]},
    open(sys.argv[6], "w"),
)
' "$dispatch" "$issue" "$role" "$pull" "$files" "$STATE_DIR/dispatch-$dispatch.json" 2>/dev/null \
    || printf '{"issue":%s,"role":"%s","pull":"%s"}\n' "$issue" "$role" "$pull" > "$STATE_DIR/dispatch-$dispatch.json"
}

issue_for_dispatch() {
  local f="$STATE_DIR/dispatch-$1.json"
  [ -f "$f" ] || return 0
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("issue",""))' "$f" 2>/dev/null || true
}

# ---------------------------------------------------------------- 并行 lane
# 一个 lane = 一个 worktree + 一个终端。状态落盘到 STATE_DIR/lanes/lane-N.*：
# cycle.sh 是短进程，下一轮还要能认出"这条 lane 上是谁、跑完没有"，不能只放内存。
lane_read() {
  local f="$LANE_DIR/lane-$1.$2"
  [ -s "$f" ] && cat "$f" || true
}
lane_write() {
  printf '%s\n' "$3" > "$LANE_DIR/lane-$1.$2"
}
lane_selector() { printf 'path:%s' "$1"; }

# dispatch 是否已经结束。0=结束 1=还在跑 2=查不到。
# 只在查得到时相信它：查不到不能当"空闲"，否则会把还在跑的工作树抢过来。
worker_settled() {
  local dispatch="$1" out
  [ -n "$dispatch" ] || return 0
  out=$(orca orchestration worker-show --dispatch "$dispatch" --json 2>/dev/null) || return 2
  [ -n "$out" ] || return 2
  printf '%s' "$out" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
r=d.get("result") or d
dispatch=r.get("dispatch") or {}
worker=r.get("worker") or {}
status=str(dispatch.get("status") or "").lower()
state=str(worker.get("state") or "").lower()
outcome=str((worker.get("projection") or {}).get("outcome") or "").lower()
completed=dispatch.get("completedAt") or dispatch.get("completed_at")
settled={"completed","complete","done","settled","failed","cancelled","canceled","abandoned","stopped","exited","timed_out","timeout","released"}
if completed or status in settled or state in settled or outcome in {"succeeded","failed","cancelled","abandoned"}:
    raise SystemExit(0)
raise SystemExit(1)
' 2>/dev/null
}

# lane 是否可接新单：没有 dispatch = 新 lane；有 dispatch = 已结束才复用。
# 查不到状态时退回 TTL：默认 90 分钟内不动，避免把长任务的工作树抢走。
lane_available() {
  local lane="$1" dispatch rc=0 since now ttl
  dispatch=$(lane_read "$lane" dispatch)
  [ -n "$dispatch" ] || return 0
  worker_settled "$dispatch" || rc=$?
  if [ "$rc" -eq 0 ]; then return 0; fi
  if [ "$rc" -eq 1 ]; then return 1; fi
  since=$(lane_read "$lane" since)
  case "$since" in ''|*[!0-9]*) since=0 ;; esac
  now=$(date +%s)
  ttl=$((CYCLE_LANE_IDLE_TTL_MIN * 60))
  [ $((now - since)) -ge "$ttl" ]
}

pick_free_lane() {
  local i
  for i in $(seq 1 "$CYCLE_LANES"); do
    # 同一轮里刚派过单的 lane 即使 worker-show 说"已结束"也不能再用：
    # 那是"刚结束"还是"还没开始"在观测上无法区分，复用会让两个 issue 撞同一个 worktree。
    case " ${LANES_USED:-} " in
      *" $i "*) continue ;;
    esac
    if lane_available "$i"; then
      printf '%s\n' "$i"
      return 0
    fi
  done
  return 1
}

# 复用旧 worktree 前把它拨到新分支：lane 是资源，不是 issue 的私产。
# 有未提交修改就拒绝复用（宁可多建一个，也不覆盖别人没提交的现场）。
reset_lane_worktree() {
  local wt="$1" lane="$2" issue="$3" branch n=2 base
  command -v git >/dev/null 2>&1 || return 1
  git -C "$wt" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  [ -z "$(git -C "$wt" status --porcelain 2>/dev/null || true)" ] || return 1

  branch="issue-$issue-lane-$lane"
  while git -C "$wt" show-ref --verify --quiet "refs/heads/$branch"; do
    branch="issue-$issue-lane-$lane-$n"
    n=$((n + 1))
  done

  base=""
  for ref in origin/main main; do
    if git -C "$wt" rev-parse --verify --quiet "$ref" >/dev/null; then
      base="$ref"
      break
    fi
  done
  [ -n "$base" ] || base="HEAD"

  # 用 -b 新建分支，不动上一单的分支指针：旧分支可能还没推送，-B 会把提交冲掉。
  git -C "$wt" checkout -b "$branch" "$base" >/dev/null 2>&1 || return 1
  lane_write "$lane" branch "$branch"
  return 0
}

# 取 lane 的 worktree：有且能安全复用就复用，否则用 Orca 新建（不自己拿 git 命令建工作树）。
prepare_lane_worktree() {
  local lane="$1" issue="$2" title="$3"
  local wt name out rc branch
  wt=$(lane_read "$lane" worktree)
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    if reset_lane_worktree "$wt" "$lane" "$issue"; then
      printf '%s\n' "$wt"
      return 0
    fi
    log "    · lane ${lane} 的旧 worktree 不能安全复用（${wt}），改为新建"
  fi

  name="cycle-issue-$issue"
  rc=0
  out=$(orca worktree create --name "$name" --no-parent --setup skip --json 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    # 名字被占用是常见情况（上一轮建过、Orca 元数据还在）。换唯一名再试一次，
    # 但绝不自己拿 git 命令建工作树：worktree 必须由 Orca 管理，否则终端/生命周期都对不上。
    name="cycle-issue-$issue-$(date +%s)"
    rc=0
    out=$(orca worktree create --name "$name" --no-parent --setup skip --json 2>&1) || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    log "    ✗ orca worktree create 失败：$(printf '%s' "$out" | tr '\n' ' ' | head -c 400)"
    return 1
  fi

  wt=$(printf '%s' "$out" | jfind path)
  if [ -z "$wt" ]; then
    log "    ✗ worktree create 回执里没有 path：$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
    return 1
  fi
  branch=$(printf '%s' "$out" | jfind branch)
  branch=${branch#refs/heads/}
  lane_write "$lane" worktree "$wt"
  lane_write "$lane" name "$name"
  lane_write "$lane" branch "$branch"
  lane_write "$lane" since "$(date +%s)"
  printf '%s\n' "$wt"
}

# 从 worker-start 失败回执里抽现场：failedStage / stage / residualResources / error。
# 用递归找键，因为不同 Orca 版本把字段放在顶层或 result/attempt 里。
# **不要依赖某个固定层级**——抽不到时也要把原始回执留在日志里，不能静默。
receipt_fields() {
  python3 -c '
import json,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw)
except Exception:
    print("stage=<无 JSON> failedStage=<无 JSON> residualResources=<无 JSON> error=<无 JSON>")
    raise SystemExit
def walk(o,key):
    if isinstance(o,dict):
        v=o.get(key)
        if v not in (None,"",[],{}): return v
        for x in o.values():
            r=walk(x,key)
            if r is not None: return r
    elif isinstance(o,list):
        for x in o:
            r=walk(x,key)
            if r is not None: return r
    return None
def fmt(v):
    if v is None: return "<无>"
    if isinstance(v,str): return v
    try: return json.dumps(v,ensure_ascii=False,separators=(",",":"))
    except Exception: return str(v)
print("stage=%s failedStage=%s residualResources=%s error=%s" % (
    fmt(walk(d,"stage")), fmt(walk(d,"failedStage")), fmt(walk(d,"residualResources")), fmt(walk(d,"error"))))
' 2>/dev/null || printf 'stage=<解析失败> failedStage=<解析失败> residualResources=<解析失败> error=<解析失败>\n'
}

# 放弃一个已建但没派出去的 task：标 failed，避免它以 ready 孤儿留在 task-list。
# 这是 ACC-harness-cycle-05 的补偿动作；失败要重试，不能"喊一声就算了"。
abandon_task() {
  local taskid="$1" issue="$2" why="$3" attempt out rc
  [ -n "$taskid" ] || return 0
  for attempt in 1 2; do
    rc=0
    out=$(orca orchestration task-update --run "$RUN_ID" --from "$SENDER" --id "$taskid" \
      --status failed --result "$why" --json 2>&1) || rc=$?
    if [ "$rc" -eq 0 ]; then
      log "    · task=$taskid 已标记 failed（放弃；issue #$issue 不再挂着一个 ready 孤儿）"
      return 0
    fi
    log "    ⚠ task-update 第 ${attempt} 次失败：$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
    [ "$attempt" -lt 2 ] && sleep 1
  done
  log "    ✗ 没能把 task=$taskid 标记 failed；它会以 ready 孤儿留在 task-list，需人工清理"
  return 1
}

# 工单状态补偿（派工失败回滚）。失败重试一次，并把原因喊出来。
set_issue_state() {
  local issue="$1" to="$2" force="${3:-}" attempt out rc
  for attempt in 1 2; do
    rc=0
    if [ "$force" = "force" ]; then
      out=$(node bin/agentctl.mjs set --issue "$issue" --to "$to" --force 2>&1) || rc=$?
    else
      out=$(node bin/agentctl.mjs set --issue "$issue" --to "$to" 2>&1) || rc=$?
    fi
    if [ "$rc" -eq 0 ]; then
      log "    · issue #$issue → s:$to"
      return 0
    fi
    log "    ⚠ 退回 s:$to 第 ${attempt} 次失败：$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
    [ "$attempt" -lt 2 ] && sleep 1
  done
  log "    ✗ 自动退回 s:$to 失败，请手工把 #$issue 改成 s:$to"
  return 1
}

# worker-start 统一入口：首次失败后**用同一个 task** 退避重试至多 N 次。
# 成功时把 dispatch 放在 START_DISPATCH，失败返回 1（调用方负责回滚工单/放弃 task）。
# 失败日志必须含 stderr 与 failedStage/residualResources——上一次事故就是 stderr 被吞了。
START_DISPATCH=""
START_RESIDUAL_DISPATCH=""
worker_start_with_retry() {
  local taskid="$1" handle="$2" wt="$3" label="${4:-worker}"
  local total=$((WORKER_RETRIES + 1)) attempt=1 out err rc dispatch fields delay
  START_DISPATCH=""
  START_RESIDUAL_DISPATCH=""
  while [ "$attempt" -le "$total" ]; do
    local errf
    errf=$(mktemp "${TMPDIR:-/tmp}/cycle-worker-start-err.XXXXXX")
    rc=0
    out=$(orca orchestration worker-start --run "$RUN_ID" --from "$SENDER" --task "$taskid" \
      --terminal "$handle" --worktree "$wt" --json 2>"$errf") || rc=$?
    err=$(cat "$errf" 2>/dev/null || true)
    rm -f "$errf"

    dispatch=$(printf '%s' "$out" | jpick result.dispatchId result.dispatch.id dispatchId)
    if [ "$rc" -eq 0 ] && [ -n "$dispatch" ]; then
      START_DISPATCH="$dispatch"
      [ "$attempt" -gt 1 ] && log "    ✓ worker-start 第 ${attempt}/${total} 次尝试成功（task=${taskid}）"
      return 0
    fi

    fields=$(printf '%s' "$out" | receipt_fields)
    log "    ✗ worker-start 失败（${label}，attempt ${attempt}/${total}，task=${taskid}，rc=${rc}）"
    log "      回执：$(printf '%s' "$fields" | head -c 800)"
    log "      stderr：$(printf '%s' "$err" | tr '\n' ' ' | head -c 600)"
    [ -n "$out" ] && log "      stdout：$(printf '%s' "$out" | tr '\n' ' ' | head -c 600)"

    # 回执里已经有 dispatch：可能只是 outcome_unknown。再调一次会变成两个 Dispatch，
    # 所以停止重试，把残余交给调用方/人工，绝不"假装没派出去"。
    if [ -n "$dispatch" ]; then
      START_RESIDUAL_DISPATCH="$dispatch"
      log "      ⚠ 回执含 dispatch=${dispatch}，不再重试（避免重复 Dispatch）"
      break
    fi
    [ "$attempt" -lt "$total" ] || break
    delay=$(retry_backoff "$attempt")
    log "      ↻ ${delay}s 后用同一 task 重试（不重建 task）"
    sleep "$delay"
    attempt=$((attempt + 1))
  done

  if [ -n "$START_RESIDUAL_DISPATCH" ]; then
    if orca orchestration worker-abandon --dispatch "$START_RESIDUAL_DISPATCH" --json >/dev/null 2>&1; then
      log "    · 残余 dispatch=$START_RESIDUAL_DISPATCH 已 abandon（保留资源，不声称已停）"
    else
      log "    ⚠ 残余 dispatch=$START_RESIDUAL_DISPATCH abandon 失败，需人工查看 worker-list"
    fi
  fi
  return 1
}

# claim 的 skipped 是"为什么没派"的唯一证据：口径不合格、文件重叠串行都在这里。
print_claim_skipped() {
  printf '%s' "$1" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    raise SystemExit
for s in d.get("skipped") or []:
    print("    ✗ #%s 跳过：%s" % (s.get("number"), s.get("why")))
' 2>/dev/null || true
}

dispatch_engineer_dry_run() {
  local cap="$1" claimed
  claimed=$(node bin/agentctl.mjs claim --role engineer --dry-run --json 2>/dev/null) || {
    log "  ✗ engineer: claim 失败"
    return 1
  }
  printf '%s' "$claimed" | python3 -c '
import json,sys
cap=int(sys.argv[1])
try:
    d=json.load(sys.stdin)
except Exception:
    d={}
would=d.get("wouldClaim") or []
if not would:
    print("  · [dry-run] 没有可派的活")
for i,w in enumerate(would):
    if i >= cap:
        print("  · [dry-run] 并行 lane 上限 %s，本轮不派 #%s" % (cap, w.get("number")))
        continue
    print("  · [dry-run] 会派 #%s 到 lane %s（独立 worktree/终端，口径 %s，涉及 %s）" % (
        w.get("number"), i + 1, ", ".join(w.get("ids") or []),
        ", ".join(w.get("files") or []) or "未声明（按串行）"))
for s in d.get("skipped") or []:
    print("  ✗ 跳过 #%s：%s" % (s.get("number"), s.get("why")))
' "$cap" 2>/dev/null || log "  · [dry-run] 没有可派的活"
  return 0
}

# 一个 lane 派一个 issue：claim → 独立 worktree → 独立终端 → 1 task + 1 Dispatch。
# 任何一步失败都退回 s:ready；lane 的旧 worktree 不回滚（它是资源，不是这一单的产物）。
dispatch_engineer_lane() {
  local lane="$1" claimed rc=0
  local claimed_json
  claimed_json=$(node bin/agentctl.mjs claim --role engineer --json 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "  ✗ engineer: claim 失败：$(printf '%s' "$claimed_json" | tr '\n' ' ' | head -c 400)"
    return 1
  fi
  claimed="$claimed_json"

  local num title body acc files
  num=$(printf '%s' "$claimed" | jget claimed.number)
  if [ -z "$num" ]; then
    log "  · engineer: 没有可派的活"
    print_claim_skipped "$claimed"
    return 2
  fi
  title=$(printf '%s' "$claimed" | jget claimed.title)
  body=$(printf '%s' "$claimed" | jget claimed.body)
  acc=$(printf '%s' "$claimed" | python3 -c 'import json,sys;print(", ".join(json.load(sys.stdin)["claimed"].get("acc") or []))' 2>/dev/null || true)
  files=$(printf '%s' "$claimed" | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)["claimed"].get("files") or []))' 2>/dev/null || true)

  log "  → #$num ${title}（lane ${lane}，口径 ${acc}；涉及 ${files:-未声明/按串行}）"
  local wt
  if ! wt=$(prepare_lane_worktree "$lane" "$num" "$title"); then
    log "    ✗ 独立 worktree 准备失败，把 #$num 退回 s:ready"
    set_issue_state "$num" ready || true
    return 1
  fi
  local selector; selector=$(lane_selector "$wt")
  local branch; branch=$(lane_read "$lane" branch)

  local handle
  if ! handle=$(ensure_terminal engineer "$selector" "worker: #$num" "" "lane-$lane"); then
    log "    ✗ 起 worker 终端失败，把 #$num 退回 s:ready"
    set_issue_state "$num" ready || true
    return 1
  fi

  # spec 按官方 Task-spec contract 写：Target / Change / Constraints / Ownership / Observable acceptance。
  # 归属必须写真实路径：写 current 会让 worker 不知道自己在哪个 worktree。
  local spec
  spec=$(printf '目标：#%s %s\n\n改动：按下面工单的「口径」逐条实现。\n\n约束：\n- 只改工单「涉及」列出的文件/模块；不改 api 形状、数据库 schema、commands.mjs 的命令定义\n- 不改 issue 的 s:* label（状态由协调器迁移）\n- 不合并 PR、不给自己发通行证\n- 完成后必须能通过 npm run ci\n\n归属：你在 %s 这个独立 worktree（lane %s，分支 %s）里工作，只动本分支；不要碰其他 lane 的 worktree。\n\n可观察验收：\n- 开 PR，body 含 Closes #%s 与证据包 YAML（head_sha、acceptance 逐条 status: pass）\n- 用 worker_done 结束，带 taskId 与 dispatchId 和 --outcome\n\n工单原文：\n%s' \
    "$num" "$title" "$wt" "$lane" "${branch:-（Orca 新建）}" "$num" "$body")

  local task taskid
  task=$(orca orchestration task-create --run "$RUN_ID" --from "$SENDER" --task-title "issue #$num 实现" --spec "$spec" --json 2>&1) || task=""
  taskid=$(printf '%s' "$task" | jpick result.task.id taskId result.id)
  if [ -z "$taskid" ]; then
    log "    ✗ task-create 失败：$(printf '%s' "$task" | head -c 300)"
    log "    退回 s:ready"
    set_issue_state "$num" ready || true
    return 1
  fi

  # 首次失败不再重建 task：同一个 taskid 退避重试。成功的路径仍然只有 1 task + 1 Dispatch。
  if ! worker_start_with_retry "$taskid" "$handle" "$selector" "实现 #$num"; then
    log "    ✗ worker-start 连续失败 $((WORKER_RETRIES + 1)) 次，放弃 task=${taskid}，退回 s:ready"
    abandon_task "$taskid" "$num" "worker-start failed after $((WORKER_RETRIES + 1)) attempts (issue #$num)"
    set_issue_state "$num" ready || true
    return 1
  fi
  record_dispatch "$START_DISPATCH" "$num" engineer "" "$files"
  lane_write "$lane" issue "$num"
  lane_write "$lane" dispatch "$START_DISPATCH"
  lane_write "$lane" since "$(date +%s)"
  log "    ✓ 已派工 lane=$lane task=$taskid dispatch=$START_DISPATCH worktree=$wt"
  return 0
}

log "== 3/6 派工 =="
# BSD 的 seq 1 0 会倒着输出 "1 0"，--max 0 反而派两次。显式挡掉。
LANES_THIS_RUN="$MAX"
if [ "$LANES_THIS_RUN" -gt "$CYCLE_LANES" ]; then
  log "  · --max ${MAX} 超过并行 lane 上限 ${CYCLE_LANES}，本轮最多派 ${CYCLE_LANES} 个"
  LANES_THIS_RUN="$CYCLE_LANES"
fi
if [ "$LANES_THIS_RUN" -gt 0 ]; then
  if [ "$DRY" = "1" ]; then
    dispatch_engineer_dry_run "$LANES_THIS_RUN" || FAILED=1
  else
    for _i in $(seq 1 "$LANES_THIS_RUN"); do
      lane=""
      if ! lane=$(pick_free_lane); then
        log "  · 并行 lane 已满（上限 ${CYCLE_LANES}），本轮停止派工"
        break
      fi
      LANES_USED="${LANES_USED} ${lane}"
      rc=0
      dispatch_engineer_lane "$lane" || rc=$?
      # 2 = 没有可派的活，不必再占下一个 lane。
      [ "$rc" -eq 2 ] && break
      [ "$rc" -ne 0 ] && FAILED=1
    done
  fi
fi

# ---------------------------------------------------------------- 返工自动派
# 打回后没人派返工，是 tick 里长期显示的"派工返工"却永远不动的根因。
# 返工必须回到**原 PR 的原分支**：claim --role rework 会带回 branch/head/最近 FAIL 评论，
# 任务书引用评论、round 到顶由 claim 直接转 s:blocked + hold:human（不再派）。
# 找不到原分支对应的 worktree 时退回 ENGINEER_WT，但任务书仍要求先切到该分支。
worktree_for_branch() {
  local branch="$1"
  [ -n "$branch" ] || return 1
  orca worktree show --worktree "branch:$branch" --json >/dev/null 2>&1 || return 1
  printf 'branch:%s' "$branch"
}

dispatch_rework() {
  local claimed rc
  rc=0
  if [ "$DRY" = "1" ]; then
    claimed=$(node bin/agentctl.mjs claim --role rework --dry-run --json 2>&1) || rc=$?
  else
    claimed=$(node bin/agentctl.mjs claim --role rework --json 2>&1) || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    log "  ✗ rework: claim 失败：$(printf '%s' "$claimed" | tr '\n' ' ' | head -c 400)"
    return 1
  fi

  # 轮次到顶/无可原件时 claim 已把动作做完（或 dry-run 报告会怎么做）；先把这些说出来。
  local notes
  notes=$(printf '%s' "$claimed" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
for b in d.get("blocked") or d.get("wouldBlock") or []:
    print("  · #%s %s" % (b.get("number"), b.get("why")))
for s in d.get("skipped") or []:
    print("  ✗ 跳过返工 #%s：%s" % (s.get("number"), s.get("why")))
' 2>/dev/null || true)
  [ -n "$notes" ] && log "$notes"

  local payload prefix
  if [ "$DRY" = "1" ]; then
    # claim --dry-run 不抢单，只返回 wouldClaim；这里把第一份任务书完整打出来供审阅。
    payload=$(printf '%s' "$claimed" | python3 -c '
import json,sys
w=json.load(sys.stdin).get("wouldClaim") or []
print(json.dumps(w[0], ensure_ascii=False) if w else "")
' 2>/dev/null || true)
    prefix=""
  else
    payload="$claimed"
    prefix="claimed."
  fi

  local num title body pull branch head round comment_url comment_body acc
  num=$(printf '%s' "$payload" | jget "${prefix}number")
  if [ -z "$num" ]; then
    log "  · rework: 没有可派的返工"
    return 0
  fi
  title=$(printf '%s' "$payload" | jget "${prefix}title")
  body=$(printf '%s' "$payload" | jget "${prefix}body")
  pull=$(printf '%s' "$payload" | jget "${prefix}pull")
  branch=$(printf '%s' "$payload" | jget "${prefix}branch")
  head=$(printf '%s' "$payload" | jget "${prefix}head")
  round=$(printf '%s' "$payload" | jget "${prefix}round")
  comment_url=$(printf '%s' "$payload" | jget "${prefix}commentUrl")
  comment_body=$(printf '%s' "$payload" | jget "${prefix}commentBody")
  acc=$(printf '%s' "$payload" | python3 -c '
import json,sys
d=json.load(sys.stdin)
d=d.get("claimed") or d
print(", ".join(d.get("ids") or d.get("acc") or []))
' 2>/dev/null || true)
  local files
  files=$(printf '%s' "$payload" | python3 -c '
import json,sys
d=json.load(sys.stdin)
d=d.get("claimed") or d
print(",".join(d.get("files") or []))
' 2>/dev/null || true)
  comment_body=${comment_body:0:1200}

  local rwt="$ENGINEER_WT" resolved
  if resolved=$(worktree_for_branch "$branch"); then
    rwt="$resolved"
  else
    log "    · 没找到分支 ${branch} 的 worktree，仍在 ${ENGINEER_WT} 里派工（任务书要求先切到该分支）"
  fi

  local spec
  spec=$(printf '目标：返工 issue #%s %s（PR #%s，原分支 %s，第 %s 轮）。\n\n改动：按最近验收意见在原分支继续修改；不新建分支、不新建 issue、不改写历史。\n\n最近验收评论：%s\n\n验收意见（节选）：\n%s\n\n约束：\n- 在分支 %s 上继续，PR #%s 保持同一个；改完 push 到同一分支\n- 只改工单「涉及」列出的文件/模块；不改 api 形状、数据库 schema、commands.mjs 的命令定义\n- 不改 issue 的 s:* label（状态由协调器迁移）\n- 不合并 PR、不给自己发通行证\n- 完成后必须能通过 npm run ci\n\n归属：worktree=%s（目标分支 %s）；若当前不在该分支，先 git switch %s。\n\n可观察验收：\n- 更新 PR #%s 的 body，含 Closes #%s 与证据包 YAML（head_sha、acceptance 逐条 status: pass）\n- 用 worker_done 结束，带 taskId 与 dispatchId 和 --outcome\n\n工单原文：\n%s' \
    "$num" "$title" "$pull" "$branch" "$round" "$comment_url" "$comment_body" \
    "$branch" "$pull" "$rwt" "$branch" "$branch" "$pull" "$num" "$body")

  if [ "$DRY" = "1" ]; then
    log "  · [dry-run] 会派返工 #${num}（PR #${pull}，原分支 ${branch}，head ${head:0:7}，round ${round}，口径 ${acc}）"
    log "$spec"
    return 0
  fi

  log "  → 返工 #$num ${title}（PR #${pull}，分支 ${branch}，round ${round}，口径 ${acc}）"
  local handle
  if ! handle=$(ensure_terminal rework "$rwt" "rework: #$num" "$branch"); then
    log "    ✗ 起返工终端失败，把 #$num 退回 s:changes（补偿迁移）"
    set_issue_state "$num" changes force || true
    return 1
  fi

  local task taskid
  task=$(orca orchestration task-create --run "$RUN_ID" --from "$SENDER" --task-title "issue #$num 返工（round ${round}）" --spec "$spec" --json 2>&1) || task=""
  taskid=$(printf '%s' "$task" | jpick result.task.id taskId result.id)
  if [ -z "$taskid" ]; then
    log "    ✗ task-create 失败：$(printf '%s' "$task" | head -c 300)"
    log "    退回 s:changes（补偿迁移）"
    set_issue_state "$num" changes force || true
    return 1
  fi

  if ! worker_start_with_retry "$taskid" "$handle" "$rwt" "返工 #$num"; then
    log "    ✗ worker-start 连续失败 $((WORKER_RETRIES + 1)) 次，放弃 task=${taskid}，退回 s:changes"
    abandon_task "$taskid" "$num" "worker-start failed after $((WORKER_RETRIES + 1)) attempts (rework issue #$num)"
    # doing → changes 不在自动迁移表里；这是派工失败的补偿，用 --force 并留告警。
    set_issue_state "$num" changes force || true
    return 1
  fi
  record_dispatch "$START_DISPATCH" "$num" "rework" "$pull" "$files"
  log "    ✓ 已派返工 task=$taskid dispatch=${START_DISPATCH}（原分支 ${branch}）"
  return 0
}

dispatch_rework || FAILED=1

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

  local task taskid
  task=$(orca orchestration task-create --run "$RUN_ID" --from "$SENDER" --task-title "验收 #$num" --spec "$spec" --json 2>&1) || task=""
  taskid=$(printf '%s' "$task" | jpick result.task.id taskId result.id)
  if [ -z "$taskid" ]; then
    log "    ✗ task-create 失败：$(printf '%s' "$task" | head -c 300)"
    rm -rf "$lock"
    return 1
  fi

  if ! worker_start_with_retry "$taskid" "$handle" "$ACCEPTANCE_WT" "验收 #$num"; then
    log "    ✗ worker-start 连续失败 $((WORKER_RETRIES + 1)) 次，放弃 task=${taskid}；issue 保持 s:review 等下一轮"
    abandon_task "$taskid" "$num" "worker-start failed after $((WORKER_RETRIES + 1)) attempts (acceptance issue #$num)"
    rm -rf "$lock"
    return 1
  fi
  record_dispatch "$START_DISPATCH" "$num" "acceptance" "$pull"
  log "    ✓ 已派验收 task=$taskid dispatch=$START_DISPATCH"
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