#!/usr/bin/env bash
# 端到端：制作机 push → volc1 中转 → 发布机拉取入库。全程在本机用两个临时 VK_HOME 模拟，
# 发布机 VERSEKIT_OFFLINE=1，不碰任何平台账号。token 现取现用，不打印、不落仓库。
# 用法：deploy/volc1/e2e.sh [ssh 别名，默认 volc1] [中转地址，默认 https://vk.fangyouxi.cn]
# 结束（含失败）时清理：本机临时目录、两个守护进程、中转上本次的测试投递。
set -euo pipefail
HOST="${1:-volc1}"
URL="${2:-https://vk.fangyouxi.cn}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VK="node $ROOT/packages/cli/src/vk.mjs"
T="$(mktemp -d)"
MAKER="$T/maker"; PUB="$T/pub"
mkdir -p "$MAKER" "$PUB"
export VERSEKIT_OFFLINE=1
DELIVERY=""

cleanup() {
  set +e
  [ -n "${PUB_PID:-}" ] && kill "$PUB_PID" 2>/dev/null
  [ -n "${MAKER_PID:-}" ] && kill "$MAKER_PID" 2>/dev/null
  # 清掉中转上的测试投递（删投递文件和它独占的成片；只动这一个投递 id）
  if [ -n "$DELIVERY" ]; then
    ssh "$HOST" "bash -s" -- "$DELIVERY" <<'REMOTE'
set -e
d=/var/lib/versekit-relay/.local/state/versekit/relay
id="$1"
case "$id" in dl_*) ;; *) exit 0;; esac
f="$d/deliveries/$id.json"
if [ -f "$f" ]; then
  for sha in $(grep -o '"sha256": *"[0-9a-f]\{64\}"' "$f" | grep -o '[0-9a-f]\{64\}'); do rm -f "$d/blobs/$sha" "$d/blobs/$sha".*; done
  rm -f "$f"
fi
REMOTE
  fi
  rm -rf "$T"
}
trap cleanup EXIT

tok() { ssh "$HOST" "runuser -u versekit -- env VK_HOME=/var/lib/versekit-relay node /opt/versekit/packages/cli/src/vk.mjs relay token $1"; }

echo "[1/6] 测试视频"
ffmpeg -loglevel error -f lavfi -i testsrc=duration=2:size=320x240:rate=15 -pix_fmt yuv420p "$T/e2e-test.mp4"
cat > "$T/manifest.json" <<JSON
{"title":"中转端到端测试","cuts":[{"title":"长片","copy":{"bilibili":{"title":"B站标题","body":"B站正文","tags":["中转"]},"xiaohongshu":{"title":"小红书标题","body":"小红书正文","tags":["中转"]}},"versions":[{"language":"zh","asset":"e2e-test.mp4"}]}]}
JSON

echo "[2/6] 发布机（临时 HOME、VERSEKIT_OFFLINE=1）起守护进程，建组和账号"
VK_HOME="$PUB" $VK init >/dev/null
# 发布机不能用 serve --offline：离线模式不加载适配器，入库时一条平台稿都生成不了（见 docs/deploy-relay.md）。
# 拉取入库只生成待确认稿，不发、不采，没有账号凭证也就碰不到平台；VERSEKIT_OFFLINE=1 是约定标记。
VK_HOME="$PUB" $VK serve --port 18787 >"$T/pub.log" 2>&1 & PUB_PID=$!
sleep 3
VK_HOME="$PUB" $VK group add 测试组 >/dev/null
VK_HOME="$PUB" $VK account add bilibili --group 测试组 --name b-e2e >/dev/null
VK_HOME="$PUB" $VK account add xiaohongshu --group 测试组 --name x-e2e >/dev/null
tok pull | VK_HOME="$PUB" xargs -I{} $VK relay connect "$URL" --token {} >/dev/null

echo "[3/6] 制作机（临时 HOME）连中转并 push"
VK_HOME="$MAKER" $VK init >/dev/null
VK_HOME="$MAKER" $VK serve --offline --port 18788 >"$T/maker.log" 2>&1 & MAKER_PID=$!
sleep 3
tok push | VK_HOME="$MAKER" xargs -I{} $VK relay connect "$URL" --token {} --push >/dev/null
OUT="$(VK_HOME="$MAKER" $VK work push "$T/manifest.json" --group 测试组)"
DELIVERY="$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
echo "      投递 $DELIVERY"

echo "[4/6] 发布机拉取入库"
VK_HOME="$PUB" $VK relay pull --human

echo "[5/6] 核对：作品入库、平台稿待确认"
VK_HOME="$PUB" $VK work list --group 测试组 --human | tee "$T/list.txt"
grep -q "中转端到端测试" "$T/list.txt"
VK_HOME="$PUB" $VK relay status --human

echo "[6/6] 清理测试投递与临时目录（trap）"
echo "[ok] 端到端通过"
