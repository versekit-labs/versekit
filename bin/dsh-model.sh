#!/usr/bin/env bash
# 选 dsh worker 用哪条模型通道：火山 V4.1 Flash 优先，不可用就切千问 V4.1 Flash。
#
# 输出（stdout）：`volc` 或 `qwen`。退出码 1 = 两条都不可用（stderr 说清原因）。
#
# 为什么要探测而不是等 dsh 自己失败：dsh 的 retryPolicy 只在同一个 provider 内重试，
# 额度用尽（429/403）时不会换 provider，worker 会卡住重试——静默失败。
# 所以派工前先用 1 token 的请求探一下，不可用就换通道。
#
# 结果缓存 5 分钟（DSH_MODEL_TTL_S），避免每次派工都探。
# 已知边界：只管"派工那一刻"。worker 跑到一半额度用尽，这里看不到。
#
# 用法：bin/dsh-model.sh [--force]     # --force 忽略缓存

set -uo pipefail
STATE_DIR="${STATE_DIR:-$HOME/.orca/versekit-state}"
TTL="${DSH_MODEL_TTL_S:-300}"
CACHE="$STATE_DIR/dsh-model.choice"
mkdir -p "$STATE_DIR"

if [ "${1:-}" != "--force" ] && [ -f "$CACHE" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$CACHE" 2>/dev/null || stat -c %Y "$CACHE") ))
  if [ "$age" -lt "$TTL" ]; then cat "$CACHE"; exit 0; fi
fi

# 取密钥：先看环境变量，没有再读 dsh 自己的凭据文件（~/.dsh/.credentials.yaml 的 refs）。
# 千问的 key 只存在后者——dsh 能用它，探测脚本也必须能用，否则"备用通道"形同虚设。
# 只在内存里用，绝不打印。refs 里是 uuid 形状的值说明它指向别处的存储，这里解不开，当作没有。
get_key() {
  local env="$1" v
  v="${!env:-}"
  if [ -z "$v" ] && [ -f "$HOME/.dsh/.credentials.yaml" ]; then
    v=$(sed -n "s/^  $env: *//p" "$HOME/.dsh/.credentials.yaml" | head -1 | tr -d "\"' ")
    case "$v" in *-*-*-*-*) [ "${#v}" -eq 36 ] && v="" ;; esac
  fi
  printf '%s' "$v"
}

# probe <name> <baseURL> <key-env> <model> → 0 可用；非 0 = 不可用，原因写 stderr。
probe() {
  local name="$1" url="$2" keyenv="$3" model="$4" key code
  key=$(get_key "$keyenv")
  if [ -z "$key" ]; then echo "dsh-model: $name 不可用：密钥 $keyenv 既不在环境变量也不在 ~/.dsh/.credentials.yaml" >&2; return 2; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    "$url/chat/completions" 2>/dev/null) || code=000
  case "$code" in
    2??) return 0 ;;
    429) echo "dsh-model: $name 不可用：HTTP 429（限流或额度用尽）" >&2 ;;
    000) echo "dsh-model: $name 不可用：网络不通或超时" >&2 ;;
    *)   echo "dsh-model: $name 不可用：HTTP $code" >&2 ;;
  esac
  return 1
}

choice=""
if probe volc "https://ark.cn-beijing.volces.com/api/coding/v3" ARKCLI_CODING_PLAN_API_KEY deepseek-v4.1-flash; then
  choice=volc
elif probe qwen "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" QWEN_TOKEN_PLAN_CN_API_KEY deepseek-v4.1-flash-1017; then
  choice=qwen
  echo "dsh-model: 火山不可用，已切到千问备用通道" >&2
fi

if [ -z "$choice" ]; then echo "dsh-model: 火山与千问都不可用，本轮不派工" >&2; exit 1; fi
printf '%s\n' "$choice" | tee "$CACHE"
