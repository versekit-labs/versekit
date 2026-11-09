#!/usr/bin/env bash
# 一轮协调：把 s:ready 的 issue 派给 dsh worker。
#
# 这是 coordinator 的确定性部分——派工这件事不该让 LLM 现编。
# 判断"该派谁"用 agentctl，执行"怎么派"用 Orca 原生原语，中间没有自由发挥的空间。
#
# 顺序很重要：**先认领，再起 worker**。
# 反过来的话，两个 worker 会同时抢到同一个 issue（认领才是锁），而且 worker 已经在
# 干活了没法回收。先认领的代价是"认领成功但 worker 起不来"——这种情况会把 issue
# 退回 s:ready，而不是留在 s:doing 装作有人在做。
#
# 用法：
#   bin/cycle.sh [--max N]     默认每轮最多派 2 个（并发上限，避免一次烧掉太多额度）
#   bin/cycle.sh --dry-run     只打印会派什么，不动任何状态
#
# 环境变量：
#   ENGINEER_WT   实现 worker 的 worktree selector（默认 current）
#   ACCEPTANCE_WT 验收 worker 的 worktree selector（默认 current）
#
# 退出码：0 正常（含"没活"）；1 有派工失败。

set -euo pipefail
cd "$(dirname "$0")/.."

MAX=2
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

ENGINEER_WT="${ENGINEER_WT:-current}"
ACCEPTANCE_WT="${ACCEPTANCE_WT:-current}"
FAILED=0

log() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------- 1. 机械迁移
# tick --apply 只做确定性迁移（doing 有 PR 了 → review）。它不该处理"派工"，
# 因为派工要起进程，失败率和副作用都比改 label 大得多。
log "== 1/3 机械迁移 =="
node bin/agentctl.mjs tick --apply 2>&1 | sed -n '/已迁移\|本轮会迁移/,$p' | head -10 || true

# ---------------------------------------------------------------- 2. 派工
log "== 2/3 派工 =="

dispatch_one() {
  local role="$1" wt="$2"
  local claimed
  claimed=$(node bin/agentctl.mjs claim --role "$role" --json 2>/dev/null) || {
    log "  ✗ $role: claim 失败"
    return 1
  }
  local num title body
  num=$(printf '%s' "$claimed" | python3 -c 'import json,sys;d=json.load(sys.stdin);c=d.get("claimed");print(c["number"] if c else "")')
  if [ -z "$num" ]; then
    log "  · $role: 没有可派的活"
    return 0
  fi
  title=$(printf '%s' "$claimed" | python3 -c 'import json,sys;print(json.load(sys.stdin)["claimed"]["title"])')
  body=$(printf '%s' "$claimed" | python3 -c 'import json,sys;print(json.load(sys.stdin)["claimed"]["body"])')

  if [ "$DRY" = "1" ]; then
    log "  · [dry-run] 会派 #$num 给 ${role}（worktree=${wt}）"
    # dry-run 也要把认领退回去，否则状态会留在 doing
    node bin/agentctl.mjs tick --apply >/dev/null 2>&1 || true
    return 0
  fi

  log "  → #$num $title"
  local handle
  if ! handle=$(bin/worker-up.sh "$wt" "worker: #$num"); then
    log "    ✗ 起 worker 终端失败，把 #$num 退回 s:ready"
    node bin/agentctl.mjs set --issue "$num" --to ready >/dev/null 2>&1 || \
      log "    ⚠ 自动退回失败，请手工把 #$num 改成 s:ready"
    return 1
  fi
  log "    终端 $handle"

  # spec 里带上"我在哪个 worktree"，worker 才知道该在哪改代码。
  local spec
  spec=$(printf '你是本仓库的%s agent（worktree=%s）。\n\n以下是你要做的工单：\n\n%s\n\n要求：\n- 严格按工单的「口径」验收条目实现\n- 完成后开 PR，body 含 Closes #%s 和证据包 YAML\n- 用 worker_done 结束，带 task-id 与 dispatch-id\n- 做不下去就发 escalation 并说明缺什么' \
    "$role" "$wt" "$body" "$num")

  local task
  task=$(orca orchestration task-create --spec "$spec" --json 2>/dev/null \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("result",{}).get("task",{}).get("id",""))')
  if [ -z "$task" ]; then
    log "    ✗ task-create 失败"
    return 1
  fi

  if orca orchestration worker-start --task "$task" --terminal "$handle" --worktree "$wt" --json >/dev/null 2>&1; then
    log "    ✓ 已派工 task=$task"
  else
    log "    ✗ worker-start 失败"
    return 1
  fi
  return 0
}

for i in $(seq 1 "$MAX"); do
  dispatch_one engineer "$ENGINEER_WT" || FAILED=1
done

# ---------------------------------------------------------------- 3. 验收派工
log "== 3/3 验收派工 =="

# 验收与实现的差异：
#   - 不抢单（多个验收方看同一 PR 只是浪费，不会损坏状态）
#   - spec 必须带上 PR 号和"逐条引用 ACC id"的硬要求，否则 verdict 无法核对
#   - 验收要跑真实服务看界面，所以要求用 8788 端口，避开实现方可能占用的 8787
dispatch_acceptance() {
  local queue
  queue=$(node bin/agentctl.mjs claim --role acceptance --json 2>/dev/null) || {
    log "  ✗ acceptance: 取队列失败"
    return 1
  }
  local num pull
  num=$(printf '%s' "$queue" | python3 -c 'import json,sys;q=json.load(sys.stdin).get("queue") or [];print(q[0]["number"] if q else "")')
  if [ -z "$num" ]; then
    log "  · acceptance: 没有待验收的"
    return 0
  fi
  pull=$(printf '%s' "$queue" | python3 -c 'import json,sys;q=json.load(sys.stdin).get("queue") or [];print(q[0]["pull"] or "")')
  local title
  title=$(printf '%s' "$queue" | python3 -c 'import json,sys;q=json.load(sys.stdin).get("queue") or [];print(q[0]["title"])')

  if [ "$DRY" = "1" ]; then
    log "  · [dry-run] 会派验收：issue #$num / PR #${pull}（worktree=${ACCEPTANCE_WT}）"
    return 0
  fi

  log "  → 验收 #${num}（PR #${pull}）$title"
  local handle
  if ! handle=$(bin/worker-up.sh "$ACCEPTANCE_WT" "verify: #$num"); then
    log "    ✗ 起验收终端失败"
    return 1
  fi

  local spec
  spec=$(printf '你是本仓库的验收 agent（worktree=%s）。

待验收：issue #%s 的 PR #%s。

步骤：
1. 用 gh api 或 bin/ghx 拉 PR 的 diff 与 body 里的证据包
2. 打开 docs/design/ACCEPTANCE.md，找到该 issue 引用的 ACC 条目
3. 逐条比对，每条给 pass/fail 并写明证据
4. 本地跑 npm run ci（注意 CI 上的 test job 会挂，本地应当全绿）
5. 需要看界面时起 npm run serve，用 8788 端口

判定：
- FAIL：在 PR 留带 <!-- agent-handback --> 的评论，必须含 item/expected/observed/repro 四件套，然后把 issue 改成 s:changes
- PASS：必须引用全部相关 ACC id 且逐条 pass，然后把 issue 改成 s:accept

禁止改实现代码、禁止自己合并 PR。用 worker_done 结束。' \
    "$ACCEPTANCE_WT" "$num" "$pull")

  local task
  task=$(orca orchestration task-create --spec "$spec" --json 2>/dev/null \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("result",{}).get("task",{}).get("id",""))')
  [ -n "$task" ] || { log "    ✗ task-create 失败"; return 1; }

  if orca orchestration worker-start --task "$task" --terminal "$handle" --worktree "$ACCEPTANCE_WT" --json >/dev/null 2>&1; then
    log "    ✓ 已派验收 task=$task"
  else
    log "    ✗ worker-start 失败"
    return 1
  fi
}

dispatch_acceptance || FAILED=1

if [ "$FAILED" = "1" ]; then
  log "本轮有派工失败，见上方 ✗"
  exit 1
fi
log "本轮完成"