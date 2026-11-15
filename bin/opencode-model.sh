#!/usr/bin/env bash
# 把 opencode 的默认模型切到指定的 DeepSeek 通道，供 Orca 原生启动的 worker 使用。
#
# 为什么需要它：`orca orchestration worker-start --agent opencode` 目前不能带 --model
# （Orca 报 capability_unsupported：无法校验 opencode 的启动时选模型），worker 用的是
# opencode 自己配置里的 `model`。所以派工前由这里把 `model` 写成探测选中的通道。
#
# 只做三件事，且都幂等：
#   1. 确保 ~/.config/opencode/opencode.json 里有 volc 这个自定义 provider
#      （密钥写成 {env:变量名}；本脚本不读、不写、不打印任何密钥的值）
#   2. 把顶层 `model` 设成 opencode 认识的 <provider>/<模型>
#   3. 确认 worker 拿得到该通道的密钥，拿不到就失败并说清楚
#
# 两个通道的密钥放在不同地方：
#   - volc：环境变量 ARKCLI_CODING_PLAN_API_KEY（当前环境或 ~/.zshrc 的 export 行）
#   - qwen：opencode 自己的凭据库（`opencode auth login` → Alibaba Token Plan (China)），
#     对应 opencode 内置 provider `alibaba-token-plan-cn`，不需要环境变量
#
# 用法：bin/opencode-model.sh <volc|qwen> [模型 id]      # stdout：生效的 <通道>/<模型>
# 环境变量：OPENCODE_CONFIG_FILE 覆盖配置文件路径（测试用）

set -euo pipefail
CHANNEL="${1:-}"
MODEL="${2:-}"
CFG="${OPENCODE_CONFIG_FILE:-$HOME/.config/opencode/opencode.json}"

die() { printf 'opencode-model: %s\n' "$1" >&2; exit 1; }

case "$CHANNEL" in
  volc) PROVIDER="volc"; MODEL="${MODEL:-deepseek-v4.1-flash}" ;;
  qwen) PROVIDER="alibaba-token-plan-cn"; MODEL="${MODEL:-deepseek-v4.1-flash-1017}" ;;
  *) die "未知通道：${CHANNEL:-<空>}（支持 volc / qwen）" ;;
esac

command -v opencode >/dev/null 2>&1 || die "找不到 opencode 命令：先 brew install opencode"

if [ "$CHANNEL" = "volc" ]; then
  # worker 终端是登录 shell，会读 ~/.zshrc；所以「当前环境有」或「~/.zshrc 有 export 行」都算拿得到。
  KEYENV="ARKCLI_CODING_PLAN_API_KEY"
  if [ -z "${!KEYENV:-}" ] && ! grep -qE "^[[:space:]]*(export[[:space:]]+)?${KEYENV}=" "$HOME/.zshrc" 2>/dev/null; then
    die "volc 通道的密钥变量 ${KEYENV} 既不在环境里也不在 ~/.zshrc 的 export 行里；opencode worker 会拿不到密钥"
  fi
else
  # 只看凭据库里有没有这一项（opencode auth list 只列名字，不显示密钥）。
  if [ "${OPENCODE_MODEL_SKIP_AUTH_CHECK:-0}" != "1" ] && ! opencode auth list 2>/dev/null | grep -q "Alibaba Token Plan (China)"; then
    die "qwen 通道没有凭据：在自己的终端运行 opencode auth login，选 Alibaba Token Plan (China) 并粘贴密钥"
  fi
fi

mkdir -p "$(dirname "$CFG")"
python3 - "$CFG" "$PROVIDER" "$MODEL" <<'PY'
import json, os, sys
path, provider, model = sys.argv[1:4]
try:
    with open(path, encoding="utf8") as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {"$schema": "https://opencode.ai/config.json"}
except Exception as e:
    print(f"opencode-model: {path} 不是合法 JSON（{e}），不敢改", file=sys.stderr)
    raise SystemExit(1)

want = {
    "volc": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "火山 Coding Plan",
        "options": {"baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3", "apiKey": "{env:ARKCLI_CODING_PLAN_API_KEY}"},
        "models": {"deepseek-v4.1-flash": {"name": "DeepSeek V4.1 Flash (火山)"}},
    },
}
# 早期版本生成过一个引用环境变量的自定义 qwen provider；千问现在走 opencode 内置的
# alibaba-token-plan-cn，旧块只有还是我们生成的样子时才清掉，用户改过的不动。
LEGACY_QWEN_KEY = "{env:QWEN_TOKEN_PLAN_CN_API_KEY}"
before = json.dumps(cfg, sort_keys=True, ensure_ascii=False)
providers = cfg.setdefault("provider", {})
for name, block in want.items():
    cur = providers.setdefault(name, block)
    # 已有的 provider 只补缺的模型，不覆盖用户自己改过的字段。
    cur.setdefault("models", {})
    for mid, mdef in block["models"].items():
        cur["models"].setdefault(mid, mdef)
legacy = providers.get("qwen")
if isinstance(legacy, dict) and (legacy.get("options") or {}).get("apiKey") == LEGACY_QWEN_KEY:
    del providers["qwen"]
if provider in want:
    providers[provider].setdefault("models", {}).setdefault(model, {"name": model})
cfg["model"] = f"{provider}/{model}"
after = json.dumps(cfg, sort_keys=True, ensure_ascii=False)
if before != after:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
print(cfg["model"])
PY
