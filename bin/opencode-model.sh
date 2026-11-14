#!/usr/bin/env bash
# 把 opencode 的默认模型切到指定的 DeepSeek 通道，供 Orca 原生启动的 worker 使用。
#
# 为什么需要它：`orca orchestration worker-start --agent opencode` 目前不能带 --model
# （Orca 报 capability_unsupported：无法校验 opencode 的启动时选模型），worker 用的是
# opencode 自己配置里的 `model`。所以派工前由这里把 `model` 写成探测选中的通道。
#
# 只做三件事，且都幂等：
#   1. 确保 ~/.config/opencode/opencode.json 里有 volc / qwen 两个 provider
#      （密钥一律写成 {env:变量名}，本脚本不读、不写、不打印任何密钥的值）
#   2. 把顶层 `model` 设成 <通道>/<模型>
#   3. 确认该通道的密钥变量能被 worker 拿到（当前环境或 ~/.zshrc 的 export 行），拿不到就失败并说清楚
#
# 用法：bin/opencode-model.sh <volc|qwen> [模型 id]      # stdout：生效的 <通道>/<模型>
# 环境变量：OPENCODE_CONFIG_FILE 覆盖配置文件路径（测试用）

set -euo pipefail
CHANNEL="${1:-}"
MODEL="${2:-}"
CFG="${OPENCODE_CONFIG_FILE:-$HOME/.config/opencode/opencode.json}"

die() { printf 'opencode-model: %s\n' "$1" >&2; exit 1; }

case "$CHANNEL" in
  volc) KEYENV="ARKCLI_CODING_PLAN_API_KEY"; MODEL="${MODEL:-deepseek-v4.1-flash}" ;;
  qwen) KEYENV="QWEN_TOKEN_PLAN_CN_API_KEY"; MODEL="${MODEL:-deepseek-v4.1-flash-1017}" ;;
  *) die "未知通道：${CHANNEL:-<空>}（支持 volc / qwen）" ;;
esac

command -v opencode >/dev/null 2>&1 || die "找不到 opencode 命令：先 brew install opencode"

# worker 终端是登录 shell，会读 ~/.zshrc；所以「当前环境有」或「~/.zshrc 有 export 行」都算拿得到。
if [ -z "${!KEYENV:-}" ] && ! grep -qE "^[[:space:]]*(export[[:space:]]+)?${KEYENV}=" "$HOME/.zshrc" 2>/dev/null; then
  die "${CHANNEL} 通道的密钥变量 ${KEYENV} 既不在环境里也不在 ~/.zshrc 的 export 行里；opencode worker 会拿不到密钥。在 ~/.zshrc 加一行 export ${KEYENV}=… 后重试"
fi

mkdir -p "$(dirname "$CFG")"
python3 - "$CFG" "$CHANNEL" "$MODEL" <<'PY'
import json, os, sys
path, channel, model = sys.argv[1:4]
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
    "qwen": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "千问 Token Plan",
        "options": {"baseURL": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "apiKey": "{env:QWEN_TOKEN_PLAN_CN_API_KEY}"},
        "models": {"deepseek-v4.1-flash-1017": {"name": "DeepSeek V4.1 Flash (千问)"}},
    },
}
before = json.dumps(cfg, sort_keys=True, ensure_ascii=False)
providers = cfg.setdefault("provider", {})
for name, block in want.items():
    cur = providers.setdefault(name, block)
    # 已有的 provider 只补缺的模型，不覆盖用户自己改过的字段。
    cur.setdefault("models", {})
    for mid, mdef in block["models"].items():
        cur["models"].setdefault(mid, mdef)
providers[channel].setdefault("models", {}).setdefault(model, {"name": model})
cfg["model"] = f"{channel}/{model}"
after = json.dumps(cfg, sort_keys=True, ensure_ascii=False)
if before != after:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
print(cfg["model"])
PY
