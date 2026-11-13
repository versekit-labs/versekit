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
#   6. 结算          归协调器；脚本只读 worker-list 做终端回收，不 release、不 ack
#
# 两条来自官方指南的硬约束，改动时不要违反：
#   - `worker_done` 只发一次，必须带 taskId + dispatchId；心跳不等于完成。
#   - 空等/超时是 checkpoint，不是失败；只有正证据（exited）才能 stop/abandon/retry。
#
# 终端防泄漏：已完成（worker_done 被协调器 ack）的 worker 终端不会自己消失，
# 每个残留的 dsh 进程都是一份内存。派工前先回收「已结算 dispatch」的终端进程；
# 仍在跑的 dispatch 只读不碰。回收只调用 `terminal close`，不做 orchestration release
# ——Run 所有权、收件箱与 release 仍归协调器（ACC-harness-run-01）。
# 电脑重启后旧 handle 会回 `terminal_handle_stale`（或已不在 `terminal list`）：
# 这种终端本来就不存在，按「已关」记账，不重复 close、不计入未关上限；
# 只有真实存活却关不掉的才计数（ACC-harness-leak-05）。
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
#   IMPL_CHANNEL=claude|dsh       实现/返工 worker 的通道覆盖（默认 claude）
#   IMPL_MODEL=sonnet|opus        实现/返工 worker 的 claude 模型覆盖
#   CYCLE_WORKER_RETRIES          worker-start 首次失败后的重试次数（默认 2）
#   CYCLE_RETRY_BACKOFF_1/_2      第 1/2 次失败后的等待秒数（默认 2 / 4）
#   CYCLE_MAX_STALE_TERMINALS     已完成未关 worker 终端的上限（默认 lane 数 + 2）；
#                                 超过就先回收，清完仍超则本轮不开新终端。
#                                 重启后已不存在的 handle 按已关处理，不占这个上限。
#
# 通道按角色选（issue #87 / ACC-harness-claude-02）：
#   - 实现 / 返工 worker 默认 claude 通道（Sonnet）；issue 带 model:opus label 或返工
#     round >= 3 时用 Opus；
#   - 验收 worker 始终走 DeepSeek（bin/dsh-model.sh：volc 优先、qwen 兜底），绝不选 claude；
#   - claude 不可用时实现 worker 自动降级 DeepSeek，日志写明原因。
# 选路逻辑集中在 bin/worker-channel.sh；每次派工日志写「角色 → 通道 → 模型」。
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
# 已完成但没关掉的 worker 终端，超过「lane 数 + 2」就认为在泄漏（ACC-harness-leak-03）。
# 上限可配置；回收后仍超限时不再开新终端，并给协调器留 alert。
STALE_TERMINAL_LIMIT="${CYCLE_MAX_STALE_TERMINALS:-}"
case "$STALE_TERMINAL_LIMIT" in ''|*[!0-9]*) STALE_TERMINAL_LIMIT=$((CYCLE_LANES + 2)) ;; esac
LANE_DIR="$STATE_DIR/lanes"
mkdir -p "$LANE_DIR"
LANES_USED=""   # 本轮已经用掉的 lane，绝不在一轮内复用（否则两个 issue 会共用同一 worktree）

log() { printf '%s\n' "$*"; }

# ensure_terminal 的返回值是「终端 handle」且被 $(...) 捕获：
# 函数里的说明性日志必须走 stderr，否则会和 handle 一起被当成终端名。
logerr() { printf '%s\n' "$*" >&2; }

# 第 N 次失败后等多久再重试（秒）。默认 2s / 4s，退避而不是立刻打同一个接口。
retry_backoff() {
  case "$1" in
    1) printf '%s' "${CYCLE_RETRY_BACKOFF_1:-2}" ;;
    2) printf '%s' "${CYCLE_RETRY_BACKOFF_2:-4}" ;;
    *) printf '0' ;;
  esac
}

# ---------------------------------------------------------------- 终端探针
# `terminal close` 的回执里是否写明 handle 已失效。
# 电脑重启或 Orca server 换实例后，旧 handle 会回 terminal_handle_stale；
# 这种终端本来就不存在，必须按「已关」处理，否则会一直被算成未关、拖死整轮派工。
terminal_close_receipt_is_stale() {
  printf '%s' "$1" | python3 -c '
import json,sys
raw=sys.stdin.read()
codes={"terminal_handle_stale","terminal_not_found","no_such_terminal","terminal_does_not_exist","handle_not_found"}
def stale(o):
    if isinstance(o,dict):
        c=o.get("code")
        if isinstance(c,str) and c.strip().lower() in codes:
            return True
        return any(stale(v) for v in o.values())
    if isinstance(o,list):
        return any(stale(x) for x in o)
    return False
try:
    d=json.loads(raw)
except Exception:
    d=None
if d is not None and stale(d):
    raise SystemExit(0)
if "terminal_handle_stale" in raw:
    raise SystemExit(0)
raise SystemExit(1)
' 2>/dev/null
}

# handle 是否还在 `orca terminal list` 里。0=在，1=不在（已不存在），2=查不到（不下结论）。
# 只在 close 失败后调用：close 成功已经说明处理完，不必多打一次接口。
terminal_listed() {
  local h="$1" raw
  raw=$(orca terminal list --json 2>/dev/null) || return 2
  [ -n "$raw" ] || return 2
  printf '%s' "$raw" | python3 -c '
import json,sys
h=sys.argv[1]
try:
    d=json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
root=d.get("result") if isinstance(d,dict) and isinstance(d.get("result"),dict) else d
terms=root.get("terminals") if isinstance(root,dict) else root
if not isinstance(terms,list):
    raise SystemExit(2)
for t in terms:
    v=t.get("handle") if isinstance(t,dict) else (t if isinstance(t,str) else "")
    if v==h:
        raise SystemExit(0)
raise SystemExit(1)
' "$h" 2>/dev/null
}

# 关闭终端的统一口径：0 = 已关或本来就不存在；1 = 真实存活却关不掉。
# 结果放 TERMINAL_CLOSE_RESULT（closed|stale|failed），失败回执放 TERMINAL_CLOSE_OUT，
# 供调用方记账与「每轮至多一行」汇总使用。
TERMINAL_CLOSE_RESULT=""
TERMINAL_CLOSE_OUT=""
close_terminal_worker() {
  local h="$1" out rc listed_rc
  TERMINAL_CLOSE_RESULT=""
  TERMINAL_CLOSE_OUT=""
  rc=0
  out=$(orca terminal close --terminal "$h" --json 2>&1) || rc=$?
  TERMINAL_CLOSE_OUT="$out"
  if [ "$rc" -eq 0 ]; then
    TERMINAL_CLOSE_RESULT="closed"
    return 0
  fi
  if terminal_close_receipt_is_stale "$out"; then
    TERMINAL_CLOSE_RESULT="stale"
    return 0
  fi
  # 回执没写 stale 时再查一次 list：不在列表里同样说明终端已不存在。
  listed_rc=0
  terminal_listed "$h" || listed_rc=$?
  if [ "$listed_rc" -eq 1 ]; then
    TERMINAL_CLOSE_RESULT="stale"
    return 0
  fi
  TERMINAL_CLOSE_RESULT="failed"
  return 1
}

# 所有权探测失败不能静默：逐轮写日志；连续失败 >=2 次再落一个协调器开场会读的
# alert 文件。失败只影响「消费/结算」段落，不影响派工与合并。
OWNER_FAIL_LOG="$STATE_DIR/cycle-owner-failures.log"
reset_owner_failures() {
  : > "$OWNER_FAIL_LOG"
  # 本轮的终端泄漏 alert 不能被同轮的消费段静默清掉：协调器开场要读它。
  # 用 marker 文件而不是变量：ensure_terminal 跑在 $(...) 子 shell 里，变量带不回来。
  if [ ! -e "$STATE_DIR/cycle-terminal-leak.marker" ]; then
    rm -f "$STATE_DIR/cycle-owner-alert.txt"
  fi
  return 0
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

# 角色名（日志里「角色 → 通道 → 模型」用）。
role_label() {
  case "$1" in
    engineer) printf '实现' ;;
    rework) printf '返工' ;;
    acceptance) printf '验收' ;;
    *) printf '%s' "$1" ;;
  esac
}

# issue 的 label 列表，逗号连接。model:opus 决定实现 worker 是否升级 Opus。
# 走 bin/ghx（与 agentctl 同一账号，不切换全局活跃账号）；gh 失败时当作没有 label，
# 不阻断派工——最坏只是这一单用 Sonnet。
issue_labels() {
  local num="$1" out
  [ -n "$num" ] || return 0
  out=$(bin/ghx issue view "$num" --json labels --jq '.labels[].name' 2>/dev/null) || return 0
  printf '%s' "$out" | tr '\n' ',' | sed 's/,$//'
}

# 选通道 + 模型。结果写 CHOSEN_CHANNEL / CHOSEN_MODEL / CHOSEN_REASON。
# no_probe=1 只在 dry-run 用：不花探测请求，按默认假设 claude 可用。
CHOSEN_CHANNEL=""
CHOSEN_MODEL=""
CHOSEN_REASON=""
choose_worker_channel() {
  local role="$1" labels="${2:-}" round="${3:-}" noprobe="${4:-0}" out
  local args=(--role "$role")
  if [ -n "$labels" ]; then args+=(--labels "$labels"); fi
  if [ -n "$round" ]; then args+=(--round "$round"); fi
  if [ "$noprobe" = "1" ]; then args+=(--no-probe); fi
  # worker-channel 的失败原因走 stderr，直接落到本轮日志，不被 $(...) 吞掉。
  out=$(bin/worker-channel.sh "${args[@]}" 2>/dev/null) || return 1
  IFS='|' read -r CHOSEN_CHANNEL CHOSEN_MODEL CHOSEN_REASON <<< "$out"
  case "${CHOSEN_CHANNEL}:${CHOSEN_MODEL}" in
    claude:sonnet|claude:opus|volc:deepseek-v4.1-flash|qwen:deepseek-v4.1-flash-1017) return 0 ;;
  esac
  CHOSEN_CHANNEL=""
  CHOSEN_MODEL=""
  CHOSEN_REASON=""
  return 1
}

# 终端对应的通道/模型/原因（ensure_terminal 落在 `$STATE_DIR/<key>.*` 里）。
terminal_field() {
  cat "$STATE_DIR/$1.$2" 2>/dev/null || true
}

# claude 通道的任务书额外约束（ACC-harness-claude-05）：
# 只动本 worktree 与工单「涉及」的文件，不碰 worktree 以外，不改用户全局配置。
claude_task_constraints() {
  printf '%s' '- 只改本 worktree 内、工单「涉及」列出的文件；不碰 worktree 以外的任何路径
- 不改用户全局配置（~/.claude、~/.dsh 等）；临时文件放本 worktree 或 TMPDIR
'
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
  local role="$1" wt="$2" title="$3" branch="${4:-}" key="${5:-$1}" labels="${6:-}" round="${7:-}"
  local f="$STATE_DIR/$key.terminal" cf="$STATE_DIR/$key.channel" mf="$STATE_DIR/$key.model" rf="$STATE_DIR/$key.reason" bf="$STATE_DIR/$key.branch"
  local channel="" model="" reason="" role_zh h oldch oldmd
  role_zh=$(role_label "$role")
  # 选路：实现/返工默认 claude（Sonnet/Opus），验收固定 DeepSeek；
  # claude 不可用时实现 worker 自动降级，不让整轮停派。
  if [ -z "$WORKER_AGENT" ]; then
    choose_worker_channel "$role" "$labels" "$round" 0 || {
      logerr "    ✗ ${role_zh} 没有可用通道（claude 与 DeepSeek 都不可用）"
      return 1
    }
    channel="$CHOSEN_CHANNEL"; model="$CHOSEN_MODEL"; reason="$CHOSEN_REASON"
  else
    # 原生 agent 模式没有通道概念；清掉旧映射，避免调用方读到上一单的通道。
    rm -f "$cf" "$mf" "$rf"
  fi
  if [ -s "$f" ]; then
    h=$(cat "$f")
    oldch=$(cat "$cf" 2>/dev/null || true)
    oldmd=$(cat "$mf" 2>/dev/null || true)
    # 返工换了分支就不能复用：终端里的工作树还停在上一单的分支上。
    if [ -n "$branch" ] && [ "$(cat "$bf" 2>/dev/null || true)" != "$branch" ]; then
      logerr "    · ${role_zh} 目标分支变为 ${branch}，不复用旧终端 ${h}"
      rm -f "$f" "$bf" "$cf" "$mf" "$rf"
    # 通道或模型变了就不能复用：终端里的 agent 已经绑定了旧通道/旧模型。
    # 旧终端必须**先关再建**：只解除映射会在切换后留下两个进程同时吃内存
    # （ACC-harness-leak-02）。
    elif [ -n "$channel" ] && { [ "$oldch" != "$channel" ] || { [ -n "$oldmd" ] && [ "$oldmd" != "$model" ]; }; }; then
      logerr "    · ${role_zh} 通道切换，已关旧终端 ${h}（${oldch:-?}/${oldmd:-?} → ${channel}/${model}）"
      # 旧终端可能重启后已不存在（terminal_handle_stale / 不在 terminal list）：
      # 统一口径按「已关」处理，否则会因为一个不存在的 handle 停掉整轮派工。
      if close_terminal_worker "$h"; then
        rm -f "$f" "$cf" "$mf" "$rf"
      else
        # 真实存活却关不掉就不建新终端：两个同时留存正是这次要修的问题；下一轮再试。
        logerr "    ⚠ 通道切换关闭旧终端 ${h} 失败，本轮不建新终端（避免两个终端同时留存）"
        return 1
      fi
    elif orca terminal show --terminal "$h" --json >/dev/null 2>&1; then
      [ -n "$channel" ] && printf '%s' "$channel" > "$cf"
      [ -n "$model" ] && printf '%s' "$model" > "$mf"
      [ -n "$reason" ] && printf '%s' "$reason" > "$rf"
      printf '%s\n' "$h"; return 0
    else
      rm -f "$f"
    fi
  fi
  # 已完成未关的终端回收之后仍超上限：不再开新终端（ACC-harness-leak-03）。
  terminal_budget_exceeded || return 1
  local new
  if [ -n "$WORKER_AGENT" ]; then
    made=$(orca terminal create --worktree "$wt" --command "$WORKER_AGENT" --title "$title" --json 2>/dev/null || true)
    new=$(printf '%s' "$made" | jfind handle)
  else
    new=$(WORKER_CHANNEL="$channel" WORKER_MODEL="$model" bin/worker-up.sh "$wt" "$title" 2>/dev/null) || new=""
  fi
  [ -n "$new" ] || return 1
  printf '%s' "$new" > "$f"
  [ -n "$channel" ] && printf '%s' "$channel" > "$cf"
  [ -n "$model" ] && printf '%s' "$model" > "$mf"
  [ -n "$reason" ] && printf '%s' "$reason" > "$rf"
  [ -n "$branch" ] && printf '%s' "$branch" > "$bf"
  printf '%s\n' "$new"
}

# ---------------------------------------------------------------- 终端回收（防泄漏）
# 已完成 worker 的终端不会自己消失：一次清理时见过 33 个 dsh 进程约占 2GB。
# 协调器 ack worker_done 之后，这里把**已结算 dispatch** 对应的终端关掉；
# 仍在跑的不关（只有正证据才动手），关闭失败只记日志，不阻断整轮。
# 只关进程，不 release、不 ack：Run 所有权与收件箱仍归协调器。
CLOSED_TERMINALS_LEDGER="$STATE_DIR/closed-worker-terminals.log"
: >> "$CLOSED_TERMINALS_LEDGER" 2>/dev/null || true
# 台账里的 handle = 已确认处理完（关闭成功，或重启后判定已不存在）。
# 下一轮不再对这些 handle 调 close：Orca 对 external terminal 仍可能报 retained，
# 重复 close 只会刷屏，不会让 worker-list 变干净（ACC-harness-leak-05）。
# 每轮开头清掉上一轮的泄漏 marker：本轮还漏水就重新落，不漏了就让消费段正常清 alert。
TERMINAL_LEAK_MARKER="$STATE_DIR/cycle-terminal-leak.marker"
rm -f "$TERMINAL_LEAK_MARKER"

# 终端关掉后同步清掉 state 里的映射：下一轮 ensure_terminal 会按新终端重建，
# 免得拿着已关闭的 handle 去复用。
forget_terminal_mapping() {
  local h="$1" f
  for f in "$STATE_DIR"/*.terminal; do
    [ -f "$f" ] || continue
    if [ "$(cat "$f" 2>/dev/null || true)" = "$h" ]; then
      rm -f "$f" "${f%.terminal}.channel" "${f%.terminal}.branch"
    fi
  done
}

# 从 worker-list 提取「已结算且终端未释放」的 handle。
# 同一个 handle 只要还有任何一个未结算的 dispatch 在用，就整个跳过——
# 终端会被 lane 复用，只看某一行 settled 就关会误杀正在跑的 worker。
worker_terminal_rows() {
  orca orchestration worker-list --run "$RUN_ID" --limit 100 --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
root=d.get("result") if isinstance(d,dict) and isinstance(d.get("result"),dict) else d
rows=root.get("workers") or [] if isinstance(root,dict) else (root if isinstance(root,list) else [])
settled_status={"completed","complete","done","settled","failed","cancelled","canceled","abandoned","stopped","exited","timed_out","timeout","released"}
settled_outcome={"succeeded","failed","cancelled","canceled","abandoned","timed_out","timeout","exited","stopped"}
def handle(w):
    v=(w.get("agentTerminalHandle") or w.get("terminalHandle") or w.get("handle")
       or (w.get("resource") or {}).get("terminalHandle"))
    if not v:
        t=w.get("terminal")
        v=t.get("handle") if isinstance(t,dict) else (t if isinstance(t,str) else None)
    return v or ""
def terminal_state(w):
    return str(w.get("terminalState") or (w.get("resource") or {}).get("state") or "").lower()
def is_settled(w):
    st=str(w.get("dispatchStatus") or w.get("status") or w.get("state") or "").lower()
    ws=str(w.get("workerState") or "").lower()
    out=str((w.get("projection") or {}).get("outcome") or w.get("outcome") or "").lower()
    return st in settled_status or out in settled_outcome or ws in {"succeeded","failed","cancelled","canceled","abandoned","stopped","exited","timed_out","timeout"}
active=set()
for w in rows:
    h=handle(w)
    if h and not is_settled(w):
        active.add(h)
seen=set()
for w in rows:
    h=handle(w)
    if not h or h in active or h in seen:
        continue
    if terminal_state(w) in {"released","release_pending","release_unknown"}:
        continue
    if not is_settled(w):
        continue
    seen.add(h)
    print("%s\t%s" % (h, w.get("dispatchId") or ""))
' 2>/dev/null
}

# 清完仍超上限就不开新终端，并给协调器留一条开场会读的 alert。
# 只有真实存活却关不掉的终端会进 RECLAIM_REMAINING；重启后已不存在的
# handle 在回收段就按「已关」记账，不会把上限撑爆（ACC-harness-leak-05）。
terminal_budget_exceeded() {
  [ "${RECLAIM_REMAINING:-0}" -gt "$STALE_TERMINAL_LIMIT" ] || return 0
  local msg="已完成但仍存活且关不掉的 worker 终端 ${RECLAIM_REMAINING} 个，超过上限 ${STALE_TERMINAL_LIMIT}（lane 数 ${CYCLE_LANES} + 2；可用 CYCLE_MAX_STALE_TERMINALS 调整），本轮不开新终端。"
  logerr "    ✗ ${msg}"
  if ! grep -qF '[终端回收]' "$STATE_DIR/cycle-owner-alert.txt" 2>/dev/null; then
    printf '[终端回收] %s\n时间：%s\n' "$msg" "$(date -u +%FT%TZ)" >> "$STATE_DIR/cycle-owner-alert.txt"
  fi
  : > "$TERMINAL_LEAK_MARKER"
  return 1
}

# 派工前回收：候选 = 已完成、终端仍在、且没有活着的 dispatch 共用该终端。
# 三档结果分开记：关闭成功 / 已不存在（stale 或不在 list） / 真实存活但关不掉。
# 前两档都记台账并清映射；只有第三档计入未关上限。日志每轮至多一行汇总。
RECLAIM_CANDIDATES=0
RECLAIM_REMAINING=0
reclaim_settled_worker_terminals() {
  local rows handle dispatch
  local ledgered=0 candidates=0 closed_now=0 stale_now=0 still_open=0
  local first_open_error=""
  RECLAIM_CANDIDATES=0
  RECLAIM_REMAINING=0
  if ! rows=$(worker_terminal_rows); then
    log "  ⚠ worker-list 查询失败，跳过终端回收（不阻断本轮）"
    return 0
  fi
  [ -n "$rows" ] || return 0
  while IFS=$'\t' read -r handle dispatch; do
    [ -n "$handle" ] || continue
    # 已记台账（关闭成功或判定已不存在）的不再尝试 close，也不计入本轮候选。
    if grep -qxF -- "$handle" "$CLOSED_TERMINALS_LEDGER" 2>/dev/null; then
      ledgered=$((ledgered + 1))
      continue
    fi
    candidates=$((candidates + 1))
    if [ "$DRY" = "1" ]; then
      # dry-run 不写台账、不发 close；只报告本轮会处理多少个。
      still_open=$((still_open + 1))
      continue
    fi
    if close_terminal_worker "$handle"; then
      printf '%s\n' "$handle" >> "$CLOSED_TERMINALS_LEDGER"
      forget_terminal_mapping "$handle"
      if [ "$TERMINAL_CLOSE_RESULT" = "stale" ]; then
        stale_now=$((stale_now + 1))
      else
        closed_now=$((closed_now + 1))
      fi
    else
      # 真实存活却关不掉：计入未关数（会撞上限），但只留一行汇总，不逐 handle 刷屏。
      still_open=$((still_open + 1))
      if [ -z "$first_open_error" ]; then
        first_open_error=$(printf '%s' "$TERMINAL_CLOSE_OUT" | tr '\n' ' ' | head -c 120)
      fi
    fi
  done <<< "$rows"
  RECLAIM_CANDIDATES=$candidates
  RECLAIM_REMAINING=$still_open
  if [ "$candidates" -gt 0 ] || [ "$ledgered" -gt 0 ]; then
    local note=""
    if [ "$DRY" = "1" ]; then
      note="（dry-run 未实际关闭）"
    fi
    local msg="  · 终端回收：候选 ${candidates} 个，关闭 ${closed_now} 个，已不存在 ${stale_now} 个，仍存活关不掉 ${still_open} 个，台账跳过 ${ledgered} 个${note}"
    if [ -n "$first_open_error" ]; then
      msg="${msg}；首个失败：${first_open_error}"
    fi
    log "$msg"
  fi
  return 0
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

# 任务书按官方 Task-spec contract 写：Target / Change / Constraints / Ownership / Observable acceptance。
# channel=claude 时追加 worktree 边界与“不改用户全局配置”的约束（ACC-harness-claude-05）。
engineer_spec() {
  local num="$1" title="$2" wt="$3" lane="$4" branch="$5" body="$6" channel="$7"
  local extra=""
  if [ "$channel" = "claude" ]; then extra=$(claude_task_constraints); extra="${extra}"$'\n'; fi
  printf '目标：#%s %s\n\n改动：按下面工单的「口径」逐条实现。\n\n约束：\n%s- 只改工单「涉及」列出的文件/模块；不改 api 形状、数据库 schema、commands.mjs 的命令定义\n- 不改 issue 的 s:* label（状态由协调器迁移）\n- 不合并 PR、不给自己发通行证\n- 完成后必须能通过 npm run ci\n\n归属：你在 %s 这个独立 worktree（lane %s，分支 %s）里工作，只动本分支；不要碰其他 lane 的 worktree。\n\n可观察验收：\n- 开 PR，body 含 Closes #%s 与证据包 YAML（head_sha、acceptance 逐条 status: pass）\n- 用 worker_done 结束，带 taskId 与 dispatchId 和 --outcome\n\n工单原文：\n%s' \
    "$num" "$title" "$extra" "$wt" "$lane" "${branch:-（Orca 新建）}" "$num" "$body"
}

rework_spec() {
  local num="$1" title="$2" pull="$3" branch="$4" round="$5" comment_url="$6" comment_body="$7" rwt="$8" body="$9" channel="${10}"
  local extra=""
  if [ "$channel" = "claude" ]; then extra=$(claude_task_constraints); extra="${extra}"$'\n'; fi
  printf '目标：返工 issue #%s %s（PR #%s，原分支 %s，第 %s 轮）。\n\n改动：按最近验收意见在原分支继续修改；不新建分支、不新建 issue、不改写历史。\n\n最近验收评论：%s\n\n验收意见（节选）：\n%s\n\n约束：\n%s- 在分支 %s 上继续，PR #%s 保持同一个；改完 push 到同一分支\n- 只改工单「涉及」列出的文件/模块；不改 api 形状、数据库 schema、commands.mjs 的命令定义\n- 不改 issue 的 s:* label（状态由协调器迁移）\n- 不合并 PR、不给自己发通行证\n- 完成后必须能通过 npm run ci\n\n归属：worktree=%s（目标分支 %s）；若当前不在该分支，先 git switch %s。\n\n可观察验收：\n- 更新 PR #%s 的 body，含 Closes #%s 与证据包 YAML（head_sha、acceptance 逐条 status: pass）\n- 用 worker_done 结束，带 taskId 与 dispatchId 和 --outcome\n\n工单原文：\n%s' \
    "$num" "$title" "$pull" "$branch" "$round" "$comment_url" "$comment_body" "$extra" \
    "$branch" "$pull" "$rwt" "$branch" "$branch" "$pull" "$num" "$body"
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

  # dry-run 也写明每次派工会选的「角色 → 通道 → 模型」（ACC-harness-claude-02）。
  # --no-probe：演练不花探测请求；真实派工仍会探测 claude 是否可用。
  local nums n labels
  nums=$(printf '%s' "$claimed" | python3 -c '
import json,sys
cap=int(sys.argv[1])
try:
    d=json.load(sys.stdin)
except Exception:
    d={}
for i,w in enumerate(d.get("wouldClaim") or []):
    if i < cap:
        print(w.get("number"))
' "$cap" 2>/dev/null || true)
  for n in $nums; do
    labels=$(issue_labels "$n")
    if choose_worker_channel engineer "$labels" "" 1; then
      log "    · [dry-run] #${n} 角色 实现 → 通道 ${CHOSEN_CHANNEL} → 模型 ${CHOSEN_MODEL}（${CHOSEN_REASON}）"
    else
      log "    · [dry-run] #${n} 没有可用通道"
    fi
  done
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

  local labels; labels=$(issue_labels "$num")
  local handle
  if ! handle=$(ensure_terminal engineer "$selector" "worker: #$num" "" "lane-$lane" "$labels"); then
    log "    ✗ 起 worker 终端失败，把 #$num 退回 s:ready"
    set_issue_state "$num" ready || true
    return 1
  fi

  # 每次派工写明「角色 → 通道 → 模型」；升级 Opus 的原因也在 reason 里。
  local ch md rsn
  ch=$(terminal_field "lane-$lane" channel)
  md=$(terminal_field "lane-$lane" model)
  rsn=$(terminal_field "lane-$lane" reason)
  if [ -n "$ch" ]; then
    log "    · 角色 实现 → 通道 ${ch} → 模型 ${md}（${rsn}）"
  fi

  local spec
  spec=$(engineer_spec "$num" "$title" "$wt" "$lane" "$branch" "$body" "$ch")

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
# 派工前先回收：已完成 worker 的终端没人关，dsh 会一直占内存（ACC-harness-leak-01/03）。
# 放在 claim 之前：清理失败也不影响 claim/合并，且超限时 ensure_terminal 会拒绝开新终端。
reclaim_settled_worker_terminals
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

  local labels; labels=$(issue_labels "$num")
  local ch="" md="" rsn="" spec
  if [ "$DRY" = "1" ]; then
    if choose_worker_channel rework "$labels" "$round" 1; then
      ch="$CHOSEN_CHANNEL"; md="$CHOSEN_MODEL"; rsn="$CHOSEN_REASON"
      log "    · [dry-run] 角色 返工 → 通道 ${ch} → 模型 ${md}（${rsn}）"
    else
      log "    · [dry-run] 没有可用通道"
    fi
    spec=$(rework_spec "$num" "$title" "$pull" "$branch" "$round" "$comment_url" "$comment_body" "$rwt" "$body" "$ch")
    log "  · [dry-run] 会派返工 #${num}（PR #${pull}，原分支 ${branch}，head ${head:0:7}，round ${round}，口径 ${acc}）"
    log "$spec"
    return 0
  fi

  log "  → 返工 #$num ${title}（PR #${pull}，分支 ${branch}，round ${round}，口径 ${acc}）"
  local handle
  if ! handle=$(ensure_terminal rework "$rwt" "rework: #$num" "$branch" "" "$labels" "$round"); then
    log "    ✗ 起返工终端失败，把 #$num 退回 s:changes（补偿迁移）"
    set_issue_state "$num" changes force || true
    return 1
  fi

  ch=$(terminal_field rework channel)
  md=$(terminal_field rework model)
  rsn=$(terminal_field rework reason)
  if [ -n "$ch" ]; then
    log "    · 角色 返工 → 通道 ${ch} → 模型 ${md}（${rsn}）"
  fi
  spec=$(rework_spec "$num" "$title" "$pull" "$branch" "$round" "$comment_url" "$comment_body" "$rwt" "$body" "$ch")

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
    if choose_worker_channel acceptance "" "" 1; then
      log "  · [dry-run] 会派验收：issue #$num / PR #${pull}（head ${head:0:7}，口径 ${acc}；角色 验收 → 通道 ${CHOSEN_CHANNEL} → 模型 ${CHOSEN_MODEL}）"
    else
      log "  · [dry-run] 会派验收：issue #$num / PR #${pull}；但 DeepSeek 通道不可用"
    fi
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

  # 验收固定 DeepSeek：日志写明「角色 → 通道 → 模型」，并证明不会选 claude。
  local ch md rsn
  ch=$(terminal_field acceptance channel)
  md=$(terminal_field acceptance model)
  rsn=$(terminal_field acceptance reason)
  if [ -n "$ch" ]; then
    log "    · 角色 验收 → 通道 ${ch} → 模型 ${md}（${rsn}）"
  fi

  local spec
  spec=$(printf '目标：验收 issue #%s 的 PR #%s（head %s）。\n\n改动：不改实现代码，只产出判定。\n\n约束：\n- 只按 docs/design/ACCEPTANCE.md 的条目判定，条目外的「我觉得」不阻塞 PR\n- 不改实现代码、不合并 PR、不改 s:* label\n- 需要看界面时用 8788 端口，避开实现方可能占用的 8787\n\n归属：你在 %s 这个 worktree 里，验收必须换上下文，不看实现方的思考过程。\n\n可观察验收（必须逐条做到）：\n1. 拉 PR diff 与 body 里的证据包 YAML\n2. 逐条比对：%s\n3. 本地跑 npm run ci\n4. 在 PR 留一条评论，正文必须含 ```yaml 块：\n   verdict: PASS|FAIL\n   round: <第几轮>\n   head_sha: "<PR 当前 head>"\n   acceptance:\n     - id: <ACC id>\n       status: pass|fail\n   FAIL 时额外给 failed: 列表，每条含 item / expected / observed / repro\n5. 不要改 s:* label，状态迁移由协调器做（AGENT-COLLAB §2）\n6. PASS 发一条 merge_ready 消息；FAIL 发 escalation 说明卡在哪\n7. 用 worker_done 结束，带 taskId 与 dispatchId 和 --outcome\n8. 收尾必须关闭自己起的 Chrome 与测试服务：只按自己启动时的 pid/端口关（kill <pid> 或 lsof -ti :<端口> 后 kill），不碰 ~/.local/state/versekit/browser/ 下的登录窗口；验收结束时 ps 里不得有自己遗留的测试 Chrome' \
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