#!/usr/bin/env bash
# 在指定 worktree 里准备一个可被 Orca 派工的 worker 终端。
#
# 两个通道：
#   - claude：Claude Code（`claude --model sonnet|opus --dangerously-skip-permissions`），
#     实现 / 返工默认走这里（issue #87 / ACC-harness-claude-01..05）。
#   - dsh：DeepSeek 的 dsh-TUI（volc 优先、qwen 兜底），验收固定走这里；
#     claude 不可用时实现 worker 也降级到这里。
#
# 为什么 dsh 需要下面这些步骤：`orca orchestration worker-start --agent dsh` 会起一个
# **未配置**的 dsh profile，于是每个 worker 都停在首次引导页（"欢迎使用 dsh-TUI 第 1/4 步"），
# 注入的 prompt 被当成引导页输入吞掉，worker 永远停在 input_accepted 不干活。
# 实测走 `--terminal` 复用终端可以绕开：先自己把终端提到可对话状态，再让 Orca 往里派工。
#   1. 用已配好的 profile 起终端（DSH_PROFILE 决定了模型与凭据）
#   2. 等 TUI 画完第一帧
#   3. 发 Esc 跳过 landing page
#
# claude 不需要 dsh 的一次性 HOME 隔离（那是 dsh-tui model.json 的专用处理）；
# 但它需要一次性的 Claude 配置目录：预置工作区信任与 bypass 警告跳过，避免无人值守卡在
# 确认框，同时**不写用户的 ~/.claude 或 ~/.claude.json**。凭据用软链只读共享，
# 配置目录里不落任何明文密钥。
#
# 用法：
#   bin/worker-up.sh <worktree-selector> [title]        # 输出终端 handle
#
# 环境变量：
#   WORKER_CHANNEL=claude|dsh|volc|qwen   调用方已选好的通道（cycle.sh 会传）
#   WORKER_MODEL=sonnet|opus              claude 通道的模型
#   WORKER_ROLE=engineer|rework|acceptance  未指定通道时用于自动选路（默认 engineer）
#   DSH_CHANNEL=volc|qwen                 兼容旧调用方
#   CLAUDE_BIN                            默认 claude
#   WORKER_UP_TIMEOUT_MS / WORKER_UP_SETTLE_MS  就绪等待超时
#
# 退出码：0 成功（stdout 只有 handle）；1 失败（stderr 说清哪一步）。
# 只读外部状态：不建 worktree、不改 git、不动 issue。

set -euo pipefail

WT="${1:-current}"
TITLE="${2:-worker}"
HERE="$(cd "$(dirname "$0")" && pwd)"

die() { printf 'worker-up: %s\n' "$1" >&2; exit 1; }
note() { printf 'worker-up: %s\n' "$1" >&2; }

command -v orca >/dev/null 2>&1 || die "找不到 orca 命令"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CHANNEL="${WORKER_CHANNEL:-${DSH_CHANNEL:-}}"
MODEL="${WORKER_MODEL:-}"

# 没指定通道就按角色默认选：实现/返工 claude（Sonnet），验收 DeepSeek。
# 这里调用 worker-channel.sh 会做一次低成本 claude 探测；claude 不可用会自动降级。
if [ -z "$CHANNEL" ]; then
  chosen=$("$HERE/worker-channel.sh" --role "${WORKER_ROLE:-engineer}") || die "没有可用的通道（claude 与 DeepSeek 都不可用）"
  IFS='|' read -r CHANNEL MODEL _reason <<< "$chosen"
fi

case "$CHANNEL" in
  claude) ;;
  volc|qwen) ;;
  dsh|deepseek)
    CHANNEL=$("$HERE/dsh-model.sh") || die "没有可用的 DeepSeek 通道（火山与千问都不可用）"
    ;;
  *) die "未知通道：$CHANNEL" ;;
esac

# 把终端 handle 从 orca 的 JSON 里取出来。层级随版本变，按候选键取。
read_handle() {
  printf '%s' "$1" | python3 -c '
import json,sys
d=json.load(sys.stdin)
r=d.get("result",{}) or d
print(r.get("handle") or r.get("terminalHandle") or (r.get("terminal") or {}).get("handle") or "")
' 2>/dev/null
}

# 等 TUI 就绪。固定 sleep 不可靠：不同 worktree / 首次启动的绘制时间不同。
wait_idle() {
  local handle="$1" timeout="$2" what="$3"
  orca terminal wait --terminal "$handle" --for tui-idle --timeout-ms "$timeout" >/dev/null 2>&1 \
    || die "${what}超时（终端 ${handle}）"
}

# ---------------------------------------------------------------- claude 通道
# claude 的配置目录是**一次性**的：预置工作区信任和 bypass 警告跳过，避免无人值守卡住。
# 用户自己的 ~/.claude / ~/.claude.json 一个字节都不写；凭据用软链共享，不复制、不打印。
make_claude_config() {
  local wtpath="$1" base dir
  base="${TMPDIR:-/tmp}"
  base="${base%/}"
  dir=$(mktemp -d "$base/claude-worker-cfg.XXXXXX") || return 1

  if [ -f "$HOME/.claude/.credentials.json" ]; then
    ln -s "$HOME/.claude/.credentials.json" "$dir/.credentials.json" || return 1
  fi
  if [ -f "$HOME/.claude/settings.json" ]; then
    cp "$HOME/.claude/settings.json" "$dir/settings.json" || return 1
  fi

  python3 - "$dir" "$wtpath" "$HOME" <<'PY' || return 1
import json, os, sys

cfgdir, worktree, home = sys.argv[1:4]
cfg = {"hasCompletedOnboarding": True, "projects": {}}
if worktree:
    cfg["projects"][worktree] = {"hasTrustDialogAccepted": True}

# 只复制身份/外观这类非敏感字段；不复制历史、不清单、不复制任何密钥。
real = os.path.join(home, ".claude.json")
try:
    with open(real) as f:
        src = json.load(f)
    for key in ("oauthAccount", "theme", "installMethod"):
        if key in src:
            cfg[key] = src[key]
except Exception:
    pass

json.dump(cfg, open(os.path.join(cfgdir, ".claude.json"), "w"), ensure_ascii=False, indent=2)

# 用户 settings（含 hooks / 插件 / statusline）复制一份；在副本上打开 bypass 警告跳过，
# 用户的 settings.json 保持原样。
settings_path = os.path.join(cfgdir, "settings.json")
try:
    with open(settings_path) as f:
        settings = json.load(f)
except Exception:
    settings = {}
if not isinstance(settings, dict):
    settings = {}
settings["skipDangerousModePermissionPrompt"] = True
json.dump(settings, open(settings_path, "w"), ensure_ascii=False, indent=2)
PY

  # 只读共享用户记忆、状态栏、插件与技能；不链 projects/sessions（避免污染会话历史）。
  local entry
  for entry in CLAUDE.md statusline.sh skills agents commands plugins; do
    if [ -e "$HOME/.claude/$entry" ]; then
      ln -s "$HOME/.claude/$entry" "$dir/$entry" || return 1
    fi
  done
  printf '%s\n' "$dir"
}

resolve_worktree_path() {
  local out
  out=$(orca worktree show --worktree "$WT" --json 2>/dev/null) || return 1
  printf '%s' "$out" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    raise SystemExit
root=d.get("result",{}) or d
w=root.get("worktree",{}) if isinstance(root,dict) else {}
p=w.get("path") or root.get("path") or ""
print(p)
' 2>/dev/null
}

# 防御性兜底：配置目录没生效时，信任/绕过权限确认仍可能弹出来。
# 只按 TUI 的固定选项顺序（默认停在 No，Down 一次到 Yes）确认，写的是本次性配置目录。
settle_claude_dialogs() {
  local handle="$1" screen
  local i
  for i in 1 2 3; do
    screen=$(orca terminal read --terminal "$handle" --screen --limit 200 2>/dev/null || true)
    case "$screen" in
      *"Yes, I trust this folder"*|*"Yes, I accept"*)
        note "Claude 仍在确认页，自动选 Yes（只写本次性配置目录）"
        orca terminal send --terminal "$handle" --text "$(printf '\033[B')" >/dev/null 2>&1 \
          || die "发送 Down 失败（终端 ${handle}）"
        sleep 0.4
        orca terminal send --terminal "$handle" --text "$(printf '\r')" >/dev/null 2>&1 \
          || die "发送 Enter 失败（终端 ${handle}）"
        wait_idle "$handle" "${WORKER_UP_SETTLE_MS:-15000}" "确认后 TUI 未回到空闲"
        ;;
      *) return 0 ;;
    esac
  done
  return 0
}

if [ "$CHANNEL" = "claude" ]; then
  case "${MODEL:-sonnet}" in
    sonnet|opus) MODEL="${MODEL:-sonnet}" ;;
    *) die "claude 通道的模型只支持 sonnet|opus，收到：${MODEL}" ;;
  esac
  command -v "$CLAUDE_BIN" >/dev/null 2>&1 || die "找不到 ${CLAUDE_BIN} 命令"

  wtpath=$(resolve_worktree_path) || wtpath=""
  cfg=$(make_claude_config "$wtpath") || die "建 claude 的一次性配置目录失败"

  note "通道 claude → 模型 ${MODEL}"
  out=$(orca terminal create \
    --worktree "$WT" \
    --command "CLAUDE_CONFIG_DIR=$(printf '%q' "$cfg") $(printf '%q' "$CLAUDE_BIN") --model $(printf '%q' "$MODEL") --dangerously-skip-permissions" \
    --title "$TITLE" \
    --json 2>&1) || die "terminal create 失败：${out}"
  handle=$(read_handle "$out")
  [ -n "$handle" ] || die "拿不到终端 handle：${out}"

  wait_idle "$handle" "${WORKER_UP_TIMEOUT_MS:-60000}" "等 Claude TUI 就绪"
  settle_claude_dialogs "$handle"

  printf '%s\n' "$handle"
  exit 0
fi

# ---------------------------------------------------------------- dsh 通道
case "$CHANNEL" in
  volc) MODEL="deepseek-v4.1-flash" ;;
  qwen) MODEL="deepseek-v4.1-flash-1017" ;;
esac
PATCH="$HERE/dsh/$CHANNEL-flash.patch.yml"
[ -f "$PATCH" ] || die "缺少补丁文件：${PATCH}"

# 给这个终端一份隔离的 TUI 偏好目录（ACC-harness-model-06 的根因）。
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

note "通道 ${CHANNEL} → 模型 ${MODEL}"
out=$(orca terminal create \
  --worktree "$WT" \
  --command "${TUI_PREFS_ENV}dsh --profile dsh-tui --patch $(printf '%q' "$PATCH")" \
  --title "$TITLE" \
  --json 2>&1) || die "terminal create 失败：${out}"
handle=$(read_handle "$out")
[ -n "$handle" ] || die "拿不到终端 handle：${out}"

# 等 TUI 就绪，然后 Esc 跳过 landing page。
wait_idle "$handle" "${WORKER_UP_TIMEOUT_MS:-60000}" "等 TUI 就绪"
esc=$(printf '\033')
orca terminal send --terminal "$handle" --text "$esc" >/dev/null 2>&1 \
  || die "发送 Esc 失败（终端 ${handle}）"

# Esc 之后等输入框重新空闲，再让 Orca 注入 prompt。
wait_idle "$handle" "${WORKER_UP_SETTLE_MS:-15000}" "Esc 后 TUI 未回到空闲"

printf '%s\n' "$handle"
