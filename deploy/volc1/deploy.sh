#!/usr/bin/env bash
# 在制作机/Mac mini 上运行：把当前仓库代码同步到 volc1 并安装中转。可重复执行（升级也是它）。
# 用法：deploy/volc1/deploy.sh [ssh 主机别名，默认 volc1]
set -euo pipefail
HOST="${1:-volc1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

ssh "$HOST" '
  if [ -e /etc/systemd/system/versekit-relay.service ] || [ -d /opt/versekit ] ||
     { [ -e /var/lib/versekit-relay ] && [ ! -L /var/lib/versekit-relay ]; }; then
    echo "发现旧中转部署，请先在维护窗口执行 deploy/cutover-rename。" >&2
    exit 1
  fi
  mkdir -p /opt/hifabu
'
# 中转只需要 vk.mjs 的依赖闭包；整个 packages + 部署文件都带上，无运行时依赖不用 npm install
rsync -az --delete --exclude node_modules --exclude '*.db' --exclude test \
  "$ROOT/packages" "$ROOT/package.json" "$ROOT/deploy" "$HOST:/opt/hifabu/"
ssh "$HOST" 'bash /opt/hifabu/deploy/volc1/install-remote.sh'
