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

MAX=0   # 0 = 用满所有 engineer worktree
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

# 工程师可以有好几个 worktree：同一 worktree 不能同时跑两个 worker（会抢同一个 git 分支），
# 所以并发数 = worktree 数。列表用逗号分隔，按顺序轮转分配。
ENGINEER_WTS="${ENGINEER_WTS:-${ENGINEER_WT:-current}}"
IFS=',' read -ra ENG_WT_ARR <<< "$ENGINEER_WTS"
[ "${#ENG_WT_ARR[@]}" -gt 0 ] || ENG_WT_ARR=(current)
ENGINEER_WT="${ENG_WT_ARR[0]}"
ACCEPTANCE_WT="${ACCEPTANCE_WT:-current}"
FAILED=0

log() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------- Run 绑定
# orchestration 的 task-create / worker-start 必须带一个 Run。
# 交互式终端里 Orca 会自动解析"当前绑定"，但 automation 起的新终端没有绑定，
# 不加 --run 就会静默失败——错误信息还只会说"task-create 失败"，非常难查。
# 用文件持有 run id：跨轮次复用同一个 Run，派工历史才连得起来。
RUN_FILE="$HOME/.orca/versekit-run-id"
if [ -s "$RUN_FILE" ]; then
  RUN_ID=$(cat "$RUN_FILE")
else
  RUN_ID=$(orca orchestration run-create --objective "versekit 多 agent 协作" --json 2>/dev/null \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("result",{}).get("run",{}).get("id",""))' 2>/dev/null)
  [ -n "$RUN_ID" ] && mkdir -p "$(dirname "$RUN_FILE")" && printf '%s' "$RUN_ID" > "$RUN_FILE"
fi
if [ -z "${RUN_ID:-}" ]; then
  log "拿不到 Run id，无法派工"
  exit 1
fi
log "Run: $RUN_ID"

# Run 绑定的是"某一个 coordinator 终端"，换终端就会 consumer_fenced（task-create 被拒）。
# automation 每次都起新终端，所以每轮开头必须 run-use 重新绑定（generation+1，旧终端失效）。
# 这才是 HANDOFF-ORCA.md 里 worker-start/task-create 失败的根因，不是 --run 没传。
if ! bind_out=$(orca orchestration run-use --id "$RUN_ID" --json 2>&1); then
  log "run-use 绑定失败：$(printf '%s' "$bind_out" | head -c 300)"
  exit 1
fi

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
  local clm_err
  if ! claimed=$(node bin/agentctl.mjs claim --role "$role" --json 2>&1); then
    log "  ✗ $role: claim 失败：$(printf '%s' "$claimed" | head -2 | tr '\n' ' ')"
    return 1
  fi
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

  local task tc_out
  if ! tc_out=$(orca orchestration task-create --run "$RUN_ID" --spec "$spec" --json 2>&1); then
    log "    ✗ task-create 失败：$(printf "%s" "$tc_out" | python3 -c 'import json,sys;d=json.load(sys.stdin);print((d.get("error") or {}).get("message",""))' 2>/dev/null)"
    return 1
  fi
  task=$(printf '%s' "$tc_out" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("result",{}).get("task",{}).get("id",""))' 2>/dev/null)
  if [ -z "$task" ]; then
    log "    ✗ task-create 无 id：$(printf '%s' "$tc_out" | head -2 | tr '\n' ' ')"
    return 1
  fi

  if ws_out=$(orca orchestration worker-start --run "$RUN_ID" --task "$task" --terminal "$handle" --worktree "$wt" --json 2>&1); then
    log "    ✓ 已派工 task=$task"
  else
    log "    ✗ worker-start 失败：$(printf '%s' "$ws_out" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    print((d.get("error") or {}).get("message") or d.get("message") or "unknown")
except Exception:
    print(sys.stdin.read()[:160])
' 2>/dev/null)"
    return 1
  fi
  return 0
}

if [ "$MAX" -le 0 ] || [ "$MAX" -gt "${#ENG_WT_ARR[@]}" ]; then
  MAX="${#ENG_WT_ARR[@]}"
fi
for i in $(seq 1 "$MAX"); do
  wt="${ENG_WT_ARR[$(( (i - 1) % ${#ENG_WT_ARR[@]} ))]}"
  dispatch_one engineer "$wt" || FAILED=1
done

# ---------------------------------------------------------------- 3. 验收派工
log "== 3/3 验收派工 =="

# 验收与实现的差异：
#   - 不抢单（多个验收方看同一 PR 只是浪费，不会损坏状态）
#   - spec 必须带上 PR 号和"逐条引用 ACC id"的硬要求，否则 verdict 无法核对
#   - 验收要跑真实服务看界面，所以要求用 8788 端口，避开实现方可能占用的 8787
dispatch_acceptance() {
  local queue
  if ! queue=$(node bin/agentctl.mjs claim --role acceptance --json 2>&1); then
    log "  ✗ acceptance: 取队列失败：$(printf '%s' "$queue" | head -2 | tr '\n' ' ')"
    return 1
  fi
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

  local task tc_out
  if ! tc_out=$(orca orchestration task-create --run "$RUN_ID" --spec "$spec" --json 2>&1); then
    log "    ✗ task-create 失败：$(printf "%s" "$tc_out" | python3 -c 'import json,sys;d=json.load(sys.stdin);print((d.get("error") or {}).get("message",""))' 2>/dev/null)"
    return 1
  fi
  task=$(printf '%s' "$tc_out" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("result",{}).get("task",{}).get("id",""))' 2>/dev/null)
  [ -n "$task" ] || { log "    ✗ task-create 无 id：$(printf '%s' "$tc_out" | head -2 | tr '\n' ' ')"; return 1; }

  if ws_out=$(orca orchestration worker-start --run "$RUN_ID" --task "$task" --terminal "$handle" --worktree "$ACCEPTANCE_WT" --json 2>&1); then
    log "    ✓ 已派验收 task=$task"
  else
    log "    ✗ worker-start 失败：$(printf '%s' "$ws_out" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    print((d.get("error") or {}).get("message") or d.get("message") or "unknown")
except Exception:
    print(sys.stdin.read()[:160])
' 2>/dev/null)"
    return 1
  fi
}

dispatch_acceptance || FAILED=1

# ---------------------------------------------------------------- 4. 合并
# 合并是唯一不可逆的动作，所以只做一件事：**s:accept 的 issue，去合它的 PR**。
# 不做"顺手重试""自动 rebase"——那些失败要么是门禁没过，要么是冲突，都需要人看。
log "== 4/4 合并 s:accept =="
node bin/agentctl.mjs tick --json 2>/dev/null | python3 -c '
import json,re,sys
d=json.load(sys.stdin)
for r in d.get("rows",[]):
    if r.get("state") != "accept": continue
    m = re.search(r"PR #(\d+)", r.get("why",""))
    if m: print(m.group(1))
' | sort -u | while read -r PR; do
  [ -n "$PR" ] || continue
  if [ "$DRY" = "1" ]; then
    log "  · [dry-run] 会合并 PR #$PR"
    continue
  fi
  if bin/ghx pr merge "$PR" --squash --delete-branch >/dev/null 2>&1; then
    log "  ✓ 已合并 PR #$PR"
  else
    log "  · PR #$PR 合不了（门禁未过或有冲突），留给下一轮"
  fi
done

if [ "$FAILED" = "1" ]; then
  log "本轮有派工失败，见上方 ✗"
  exit 1
fi
log "本轮完成"
