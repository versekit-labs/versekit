#!/usr/bin/env bash
# 选 worker 的通道与模型（issue #87 / ACC-harness-claude-01..05）。
#
# 口径：
#   - 实现 / 返工 worker 默认 claude 通道（Sonnet）。
#   - Opus **只认显式 model:opus label**（额度原因，2026-11-14）；返工轮次不再自动升 Opus。
#   - issue 带 model:deepseek label（简单活）：实现与返工 round 1 直接走 DeepSeek 通道
#     （bin/dsh-model.sh：volc 优先、qwen 兜底），**不探测、不调用 claude**；
#     返工 round >= 2 仍未过 → 单升 Sonnet（claude 通道）；仍不自动升 Opus。
#     DeepSeek 两个通道都不可用时退出码 1、本轮不派，**绝不自动改用 claude**。
#   - 同时带 model:opus 与 model:deepseek 时，显式 Opus 优先。
#   - 验收 worker **始终**走 DeepSeek 通道（bin/dsh-model.sh：volc 优先、qwen 兜底），
#     绝不选 claude。实现与验收用不同模型，彼此独立，验收不看实现方的思考过程。
#   - claude 不可用（命令不存在 / 额度用尽 / 限流 / 网络不通）时，实现 worker 自动降级到
#     DeepSeek 通道照常派工；探测只做一次低成本请求，只输出判断结论，不打印任何凭据。
#   - IMPL_CHANNEL / IMPL_MODEL 显式覆盖照旧生效（优先于 label），便于演练与紧急回退。
#
# 输出（stdout，单行）：<通道>|<模型>|<原因>
#   通道：claude / volc / qwen
#   模型：sonnet / opus / deepseek-v4.1-flash / deepseek-v4.1-flash-1017
#   原因：给日志用的人话，不含 `|`
# 退出码：0 选中；1 没有任何可用通道（stderr 说清原因）。
#
# 用法：
#   bin/worker-channel.sh --role engineer|rework|acceptance [--labels a,b] [--round N]
#                         [--no-probe] [--force-probe]
#
# 环境变量：
#   IMPL_CHANNEL=claude|dsh   强制实现 worker 的通道（显式 claude 时跳过探测）
#   IMPL_MODEL=sonnet|opus    强制实现 worker 的模型
#   CLAUDE_BIN                默认 claude
#   CLAUDE_PROBE=0            跳过 claude 探测（假定可用；仅演练/离线用）
#   CLAUDE_PROBE_TTL_S        探测结果缓存秒数（默认 300）
#   CLAUDE_PROBE_TIMEOUT_S    探测超时秒数（默认 45）
#   STATE_DIR                 缓存目录（默认 ~/.orca/versekit-state）
#
# 探测只用一次最小请求（print 模式、1 个短 prompt、max-budget 兜底），
# 结果缓存到 STATE_DIR/claude-probe.result；不写用户配置、不打印密钥。

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

ROLE=""
LABELS=""
ROUND=""
NO_PROBE=0
FORCE_PROBE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --labels) LABELS="${2:-}"; shift 2 ;;
    --round) ROUND="${2:-}"; shift 2 ;;
    --no-probe) NO_PROBE=1; shift ;;
    --force-probe) FORCE_PROBE=1; shift ;;
    *) printf 'worker-channel: 未知参数 %s\n' "$1" >&2; exit 1 ;;
  esac
done

[ -n "$ROLE" ] || { printf 'worker-channel: 需要 --role engineer|rework|acceptance\n' >&2; exit 1; }

STATE_DIR="${STATE_DIR:-$HOME/.orca/versekit-state}"
mkdir -p "$STATE_DIR" 2>/dev/null || true
CACHE="$STATE_DIR/claude-probe.result"
TTL="${CLAUDE_PROBE_TTL_S:-300}"
case "$TTL" in ''|*[!0-9]*) TTL=300 ;; esac
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

# 实现/返工共用的模型选择。ROUND 只对 rework 有意义。
labels_has_opus() {
  case ",${LABELS}," in
    *",model:opus,"*) return 0 ;;
  esac
  return 1
}

labels_has_deepseek() {
  case ",${LABELS}," in
    *",model:deepseek,"*) return 0 ;;
  esac
  return 1
}

# 用现有 DeepSeek 选路：volc 优先，qwen 兜底。结果写 DSH_CHANNEL / DSH_MODEL。
DSH_CHANNEL=""
DSH_MODEL=""
dsh_choice() {
  local ch
  ch=$("$HERE/dsh-model.sh") || return 1
  case "$ch" in
    volc) DSH_MODEL="deepseek-v4.1-flash" ;;
    qwen) DSH_MODEL="deepseek-v4.1-flash-1017" ;;
    *) printf 'worker-channel: dsh-model.sh 返回未知通道 %s\n' "$ch" >&2; return 1 ;;
  esac
  DSH_CHANNEL="$ch"
  return 0
}

# claude 探测：0 = 可用；1 = 不可用（原因在 PROBE_REASON）。
PROBE_REASON=""
probe_claude() {
  PROBE_REASON=""
  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    PROBE_REASON="找不到 ${CLAUDE_BIN} 命令"
    return 1
  fi

  # 探测进程不会经过 Orca 的终端代理注入：环境里没有代理时，读一次 macOS 系统代理，
  # 只传给这次探测（不改全局环境、不影响后续 DeepSeek 选路）。
  local probe_proxy=""
  if [ -z "${HTTPS_PROXY:-}" ] && [ -z "${https_proxy:-}" ] && command -v scutil >/dev/null 2>&1; then
    probe_proxy=$(scutil --proxy 2>/dev/null | python3 -c '
import re, sys
t = sys.stdin.read()
h = re.search(r"HTTPSProxy\s*:\s*(\S+)", t)
p = re.search(r"HTTPSPort\s*:\s*(\d+)", t)
print("http://%s:%s" % (h.group(1), p.group(1)) if h and p else "")
' 2>/dev/null) || probe_proxy=""
  fi

  local out
  out=$(CLAUDE_PROBE_PROXY="$probe_proxy" python3 - "$CLAUDE_BIN" "sonnet" "${CLAUDE_PROBE_TIMEOUT_S:-45}" <<'PY' 2>/dev/null
import json, os, subprocess, sys, tempfile

binary, model, timeout = sys.argv[1], sys.argv[2], float(sys.argv[3])
env = dict(os.environ)
proxy = env.pop("CLAUDE_PROBE_PROXY", "")
if proxy and not env.get("HTTPS_PROXY") and not env.get("https_proxy"):
    env["HTTPS_PROXY"] = proxy
    env["HTTP_PROXY"] = proxy

cmd = [
    binary, "-p", "Reply with exactly: ok",
    "--model", model,
    "--output-format", "json",
    "--max-budget-usd", "0.10",
    "--no-session-persistence",
]

def reason_of(data, rc):
    status = data.get("api_error_status")
    text = str(data.get("result") or "").lower()
    if status == 429:
        return "限流或额度用尽（HTTP 429）"
    if status in (401, 403):
        return "凭据或网络不可用（HTTP %s）" % status
    if "usage limit" in text or "quota" in text or "credit" in text:
        return "额度用尽"
    if "not logged in" in text or "login" in text:
        return "未登录"
    if status:
        return "API 返回错误（HTTP %s）" % status
    return "执行失败（exit %s）" % rc

try:
    with tempfile.TemporaryDirectory(prefix="claude-probe-") as cwd:
        # 探测也用一次性配置目录：只软链凭据、预置 onboarding，绝不写用户的 ~/.claude*。
        cfgdir = os.path.join(cwd, ".claude")
        os.makedirs(cfgdir)
        cred = os.path.expanduser("~/.claude/.credentials.json")
        try:
            if os.path.exists(cred):
                os.symlink(cred, os.path.join(cfgdir, ".credentials.json"))
        except OSError:
            pass
        try:
            src = json.load(open(os.path.expanduser("~/.claude.json")))
        except Exception:
            src = {}
        json.dump(
            {"hasCompletedOnboarding": True, "oauthAccount": src.get("oauthAccount")},
            open(os.path.join(cfgdir, ".claude.json"), "w"),
        )
        env["CLAUDE_CONFIG_DIR"] = cfgdir
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
except subprocess.TimeoutExpired:
    print("down|探测超时")
    sys.exit(0)
except (FileNotFoundError, PermissionError, OSError):
    print("down|无法执行 claude 命令")
    sys.exit(0)

raw = (proc.stdout or "").strip()
data = None
try:
    data = json.loads(raw)
except Exception:
    for line in reversed(raw.splitlines()):
        try:
            data = json.loads(line)
            break
        except Exception:
            continue

if not isinstance(data, dict):
    blob = (raw + "\n" + (proc.stderr or "")).lower()
    if "429" in blob or "rate limit" in blob or "rate_limit" in blob:
        print("down|限流或额度用尽（HTTP 429）")
    elif "quota" in blob or "usage limit" in blob or "credit" in blob:
        print("down|额度用尽")
    elif "401" in blob or "403" in blob:
        print("down|凭据或网络不可用")
    elif "not logged in" in blob or "login" in blob:
        print("down|未登录")
    else:
        print("down|探测输出无法解析（exit %s）" % proc.returncode)
    sys.exit(0)
if not data.get("is_error"):
    print("ok" if data.get("result") else "down|模型没有返回内容")
    sys.exit(0)
print("down|" + reason_of(data, proc.returncode))
PY
) || out="down|探测脚本执行失败"

  case "$out" in
    ok) PROBE_REASON=""; return 0 ;;
    down\|*)
      PROBE_REASON=${out#down|}
      # 原因只留在内存/缓存里，去掉分隔符与换行，避免把原始输出带进日志。
      PROBE_REASON=$(printf '%s' "$PROBE_REASON" | tr -d '\n|' | head -c 160)
      [ -n "$PROBE_REASON" ] || PROBE_REASON="探测失败"
      return 1
      ;;
    *)
      PROBE_REASON="探测脚本输出异常"
      return 1
      ;;
  esac
}

# 缓存里是 ok 或 down|<原因>。只信任 TTL 内的结果。
cache_fresh() {
  [ -s "$CACHE" ] || return 1
  local age
  age=$(( $(date +%s) - $(stat -f %m "$CACHE" 2>/dev/null || stat -c %Y "$CACHE") ))
  [ "$age" -lt "$TTL" ]
}

cache_read() {
  local line
  line=$(cat "$CACHE" 2>/dev/null || true)
  case "$line" in
    ok) PROBE_REASON=""; return 0 ;;
    down\|*) PROBE_REASON=${line#down|}; return 1 ;;
  esac
  return 1
}

cache_write() {
  local value="$1"
  printf '%s\n' "$value" > "$CACHE" 2>/dev/null || true
}

# ---------------------------------------------------------------- 验收：固定 DeepSeek
if [ "$ROLE" = "acceptance" ]; then
  if ! dsh_choice; then
    printf 'worker-channel: 验收固定 DeepSeek，但火山与千问都不可用\n' >&2
    exit 1
  fi
  printf '%s|%s|%s\n' "$DSH_CHANNEL" "$DSH_MODEL" "验收固定 DeepSeek（与实现模型独立）"
  exit 0
fi

case "$ROLE" in
  engineer|rework) ;;
  *) printf 'worker-channel: 未知角色 %s（只支持 engineer / rework / acceptance）\n' "$ROLE" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------- 实现/返工：模型
MODEL="sonnet"
MODEL_REASON="默认 Sonnet"
DEEPSEEK_LABEL=0   # 1 = 按 model:deepseek label 走 DeepSeek 通道（不碰 claude）
local_round=0
case "$ROUND" in
  ''|*[!0-9]*) ;;
  *) local_round="$ROUND" ;;
esac
if [ -n "${IMPL_MODEL:-}" ]; then
  case "$IMPL_MODEL" in
    sonnet|opus) MODEL="$IMPL_MODEL"; MODEL_REASON="IMPL_MODEL=${IMPL_MODEL} 覆盖" ;;
    *) printf 'worker-channel: IMPL_MODEL 只支持 sonnet|opus\n' >&2; exit 1 ;;
  esac
else
  if labels_has_opus; then
    MODEL="opus"
    MODEL_REASON="issue 带 model:opus label"
  elif labels_has_deepseek; then
    if [ "$ROLE" = "rework" ] && [ "$local_round" -ge 2 ]; then
      MODEL="sonnet"
      MODEL_REASON="DeepSeek 第 ${local_round} 轮仍未过 → 升 Sonnet"
    else
      DEEPSEEK_LABEL=1
    fi
  fi
fi

# ---------------------------------------------------------------- 实现/返工：通道
CHANNEL="claude"
CHANNEL_FORCED=0
FORCE_REASON=""
if [ -n "${IMPL_CHANNEL:-}" ]; then
  case "$IMPL_CHANNEL" in
    claude) CHANNEL="claude"; CHANNEL_FORCED=1; FORCE_REASON="IMPL_CHANNEL=claude 强制" ;;
    dsh|deepseek) CHANNEL="dsh"; CHANNEL_FORCED=1; FORCE_REASON="IMPL_CHANNEL=${IMPL_CHANNEL} 强制" ;;
    *) printf 'worker-channel: IMPL_CHANNEL 只支持 claude|dsh\n' >&2; exit 1 ;;
  esac
elif [ "$DEEPSEEK_LABEL" = "1" ]; then
  # 简单活直走 DeepSeek：不进入 claude 分支，所以不会探测、不会调用 claude。
  CHANNEL="dsh"
  FORCE_REASON="issue 带 model:deepseek label → DeepSeek"
fi

if [ "$CHANNEL" = "claude" ]; then
  PROBE_OK=0
  if [ "$CHANNEL_FORCED" = "1" ]; then
    PROBE_OK=1
    PROBE_REASON="显式指定，跳过探测"
  elif [ "${CLAUDE_PROBE:-1}" = "0" ]; then
    PROBE_OK=1
    PROBE_REASON="CLAUDE_PROBE=0，跳过探测"
  elif [ "$NO_PROBE" = "1" ]; then
    PROBE_OK=1
    PROBE_REASON="dry-run/未探测，假定可用"
  elif [ "$FORCE_PROBE" = "0" ] && cache_fresh; then
    if cache_read; then
      PROBE_OK=1
      PROBE_REASON="探测缓存可用"
    fi
    # 缓存是 down：直接用缓存原因走降级，不在 TTL 内反复探测。
  else
    if probe_claude; then
      PROBE_OK=1
      cache_write "ok"
      PROBE_REASON="探测可用"
    else
      cache_write "down|${PROBE_REASON}"
    fi
  fi

  if [ "$PROBE_OK" = "1" ]; then
    printf 'claude|%s|%s\n' "$MODEL" "${MODEL_REASON}；${FORCE_REASON:-${PROBE_REASON}}"
    exit 0
  fi

  # claude 不可用：实现 worker 自动退回 DeepSeek，不让整轮停派。
  CHANNEL="dsh"
  FORCE_REASON="claude 不可用（${PROBE_REASON}），降级 DeepSeek"
fi

if ! dsh_choice; then
  if [ "$DEEPSEEK_LABEL" = "1" ] || [ "$CHANNEL_FORCED" = "1" ]; then
    printf 'worker-channel: %s，但火山与千问都不可用，本轮不派工（不会改用 claude）\n' "$FORCE_REASON" >&2
  else
    printf 'worker-channel: claude 不可用（%s），DeepSeek 通道也不可用，本轮不派工\n' "$PROBE_REASON" >&2
  fi
  exit 1
fi

DSH_REASON="${FORCE_REASON}"
if [ -n "${IMPL_MODEL:-}" ]; then
  DSH_REASON="${DSH_REASON}；IMPL_MODEL 只对 claude 通道生效"
fi
printf '%s|%s|%s\n' "$DSH_CHANNEL" "$DSH_MODEL" "$DSH_REASON"
