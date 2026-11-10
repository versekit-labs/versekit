#!/usr/bin/env bash
# 在指定 worktree 里准备一个可被 Orca 派工的 dsh 终端。
#
# 为什么需要这一步：`orca orchestration worker-start --agent dsh` 会起一个**未配置**的
# dsh profile，于是每个 worker 都停在首次引导页（"欢迎使用 dsh-TUI 第 1/4 步"），
# 注入的 prompt 被当成引导页输入吞掉，worker 永远停在 input_accepted 不干活。
# 实测走 `--terminal` 复用终端可以绕开：先自己把终端提到可对话状态，再让 Orca 往里派工。
#
# 三步都是必需的，少一步就退回到"卡在引导页"：
#   1. 用已配好的 profile 起终端（DSH_PROFILE 决定了模型与凭据）
#   2. 等 TUI 画完第一帧（太早发 Esc 会打在启动过程里，没效果）
#   3. 发 Esc 跳过 landing page（docs 明确写了 every launch lands on a landing page，
#      这是常规启动页、不是"首次"，所以每次都要跳）
#
# 用法：
#   bin/worker-up.sh <worktree-selector> [title]        # 输出终端 handle
#
# 退出码：0 成功（stdout 只有 handle）；1 失败（stderr 说清哪一步）。
# 只读外部状态：不建 worktree、不改 git、不动 issue。

set -euo pipefail

WT="${1:-current}"
TITLE="${2:-worker}"

die() { printf 'worker-up: %s\n' "$1" >&2; exit 1; }

command -v orca >/dev/null 2>&1 || die "找不到 orca 命令"

# 1. 起终端。DSH_PROFILE 已在用户 shell 里配好（dsh-tui），这里显式写出来，
#    避免依赖调用方的环境——自动化跑起来时环境不一定和交互式 shell 一致。
out=$(orca terminal create \
  --worktree "$WT" \
  --command "dsh --profile dsh-tui" \
  --title "$TITLE" \
  --json 2>&1) || die "terminate create 失败：$out"

handle=$(printf '%s' "$out" | python3 -c '
import json,sys
d=json.load(sys.stdin)
r=d.get("result",{}) or d
print(r.get("handle") or r.get("terminalHandle") or (r.get("terminal") or {}).get("handle") or "")
' 2>/dev/null)

[ -n "$handle" ] || die "拿不到终端 handle：$out"

# 2+3. 等 TUI 就绪，然后 Esc 跳过 landing page。
# 固定 sleep 不可靠：不同 worktree / 首次启动的绘制时间不同，早发 Esc 会被启动过程吃掉，
# worker 就卡在引导页。改用 Orca 的 tui-idle 条件等待，超时才报错。
if ! orca terminal wait --terminal "$handle" --for tui-idle --timeout-ms "${WORKER_UP_TIMEOUT_MS:-60000}" >/dev/null 2>&1; then
  die "等 TUI 就绪超时（终端 $handle）"
fi
esc=$(printf '\033')
orca terminal send --terminal "$handle" --text "$esc" >/dev/null 2>&1 \
  || die "发送 Esc 失败（终端 $handle）"

# Esc 之后等输入框重新空闲，再让 Orca 注入 prompt。
if ! orca terminal wait --terminal "$handle" --for tui-idle --timeout-ms "${WORKER_UP_SETTLE_MS:-15000}" >/dev/null 2>&1; then
  die "Esc 后 TUI 未回到空闲（终端 $handle）"
fi

printf '%s\n' "$handle"