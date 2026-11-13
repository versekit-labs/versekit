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
HERE="$(cd "$(dirname "$0")" && pwd)"

die() { printf 'worker-up: %s\n' "$1" >&2; exit 1; }

command -v orca >/dev/null 2>&1 || die "找不到 orca 命令"

# 0. 选模型通道：火山 V4.1 Flash 优先，不可用切千问（见 bin/dsh-model.sh）。
#    调用方（cycle.sh）已选好就传 DSH_CHANNEL，避免重复探测。
CHANNEL="${DSH_CHANNEL:-$("$HERE/dsh-model.sh")}" || die "没有可用的模型通道（火山与千问都不可用）"
case "$CHANNEL" in
  volc|qwen) ;;
  *) die "未知模型通道：$CHANNEL" ;;
esac
PATCH="$HERE/dsh/$CHANNEL-flash.patch.yml"
[ -f "$PATCH" ] || die "缺少补丁文件：$PATCH"

# 0.5 给这个终端一份隔离的 TUI 偏好目录（ACC-harness-model-06 的根因）。
#
# 为什么 --patch 单独不够：TUI 的启动路由优先级是
#   ~/.dsh-tui/model.json（上次 /model 选择）> cordis.yml 的 provider+model
#   > agent-default-model
# （modelRoute.ts 的 resolveModelRoute；TUI 的 `/model` 每次切换都写 model.json）。
# 用户在自己的终端里切过千问后，这份全局偏好一直是
# qwen-token-plan-cn/deepseek-v4.1-flash-1017，于是 worker 的 --patch 只改了
# 最低优先级那层：--dump-config 显示火山，运行时却仍走千问。
#
# TUI 数据目录固定为 $HOME/.dsh-tui，不跟 $DSH_HOME 走，所以这里用一次性 HOME
# 把它挪开：新 HOME 里除 .dsh-tui 外全部软链回真实 home（git/gh/zsh/凭据等行为
# 不变）；.dsh-tui 软链真实条目，但**唯独不链 model.json**——没有这份偏好，
# 启动路由就回落到 --patch 的 agent-default-model，正是本通道该用的模型。
# 不改用户任何文件；worker 内 /model 的新选择也只落在自己的目录里。
#
# 目录留在 TMPDIR（终端进程还要继续用它），系统会清理长期不访问的临时目录。
make_worker_home() {
  local real="$HOME" base dir entry name
  base="${TMPDIR:-/tmp}"
  base="${base%/}"
  dir=$(mktemp -d "$base/dsh-worker-home.XXXXXX") || return 1
  for entry in "$real"/* "$real"/.[!.]* "$real"/..?*; do
    { [ -e "$entry" ] || [ -L "$entry" ]; } || continue
    name=${entry##*/}
    [ "$name" = ".dsh-tui" ] && continue
    ln -s "$entry" "$dir/$name" || return 1
  done
  mkdir -p "$dir/.dsh-tui" || return 1
  if [ -d "$real/.dsh-tui" ]; then
    for entry in "$real/.dsh-tui"/* "$real/.dsh-tui"/.[!.]*; do
      { [ -e "$entry" ] || [ -L "$entry" ]; } || continue
      name=${entry##*/}
      # 唯一的例外：不继承上次的 /model 选择。
      [ "$name" = "model.json" ] && continue
      ln -s "$entry" "$dir/.dsh-tui/$name" || return 1
    done
  fi
  printf '%s\n' "$dir"
}

# 没有 ~/.dsh-tui 就没有可继承的 /model 偏好，也不需要隔离：照旧直启，
# 免得在首次运行的机器上把 TUI 带进引导页。
WORKER_HOME=""
if [ -d "$HOME/.dsh-tui" ]; then
  WORKER_HOME=$(make_worker_home) || die "建 worker 的隔离 TUI 偏好目录失败"
fi
TUI_PREFS_ENV=""
if [ -n "$WORKER_HOME" ]; then
  TUI_PREFS_ENV="HOME=$(printf '%q' "$WORKER_HOME") DSH_HOME=$(printf '%q' "$HOME/.dsh") "
fi

# 1. 起终端。DSH_PROFILE 已在用户 shell 里配好（dsh-tui），这里显式写出来，
#    避免依赖调用方的环境——自动化跑起来时环境不一定和交互式 shell 一致。
#    DSH_HOME 显式指向真实 home，profile/会话/凭据仍用用户那一份，只有 TUI 的
#    ~/.dsh-tui 被上面的一次性 HOME 隔离。
out=$(orca terminal create \
  --worktree "$WT" \
  --command "${TUI_PREFS_ENV}dsh --profile dsh-tui --patch $(printf '%q' "$PATCH")" \
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
  die "等 TUI 就绪超时（终端 ${handle}）"
fi
esc=$(printf '\033')
orca terminal send --terminal "$handle" --text "$esc" >/dev/null 2>&1 \
  || die "发送 Esc 失败（终端 ${handle}）"

# Esc 之后等输入框重新空闲，再让 Orca 注入 prompt。
if ! orca terminal wait --terminal "$handle" --for tui-idle --timeout-ms "${WORKER_UP_SETTLE_MS:-15000}" >/dev/null 2>&1; then
  die "Esc 后 TUI 未回到空闲（终端 ${handle}）"
fi

printf '%s\n' "$handle"