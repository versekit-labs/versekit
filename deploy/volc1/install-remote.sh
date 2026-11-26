#!/usr/bin/env bash
# 在 volc1 上以 root 运行（由 deploy.sh 通过 ssh 调用）。可重复执行。
# 只新增：versekit 用户、/opt/versekit、/var/lib/versekit-relay、versekit-relay.service、
# Caddyfile 里 vk.fangyouxi.cn 一个站点块。不碰 radar 和其他任何已有服务/站点。
set -euo pipefail

SRC=/opt/versekit
DATA=/var/lib/versekit-relay
CADDYFILE=/etc/caddy/Caddyfile
MARK_BEGIN="# >>> versekit relay (managed by deploy/volc1) >>>"
MARK_END="# <<< versekit relay <<<"

id versekit >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin versekit
install -d -o versekit -g versekit -m 700 "$DATA"
chown -R root:root "$SRC"

install -m 644 "$SRC/deploy/volc1/versekit-relay.service" /etc/systemd/system/versekit-relay.service
systemctl daemon-reload
systemctl enable versekit-relay.service >/dev/null
systemctl restart versekit-relay.service

# 等服务起来（首次启动会在 $DATA/.config/versekit/config.json 生成两个 token，权限 600）
for _ in $(seq 1 20); do
  curl -s -o /dev/null --max-time 2 -w '%{http_code}' http://127.0.0.1:8790/ 2>/dev/null | grep -q '^[1-5]' && break  # 无 token 返回 401 也算起来了
  sleep 1
done
systemctl is-active --quiet versekit-relay.service

# Caddy：先备份，合并站点块，validate 通过才 reload；失败就还原
if grep -qF "$MARK_BEGIN" "$CADDYFILE"; then
  echo "[caddy] versekit 站点块已存在，跳过"
else
  backup="$CADDYFILE.bak-versekit-$(date +%Y%m%d%H%M%S)"
  cp -p "$CADDYFILE" "$backup"
  { echo; echo "$MARK_BEGIN"; cat "$SRC/deploy/volc1/Caddyfile.vk.snippet"; echo "$MARK_END"; } >> "$CADDYFILE"
  if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy
    echo "[caddy] 已加站点块并 reload（备份 $backup）"
  else
    cp -p "$backup" "$CADDYFILE"
    echo "[caddy] validate 未通过，已还原 $CADDYFILE" >&2
    exit 1
  fi
fi
echo "[ok] 部署完成。取 token：ssh volc1 'sudo -u versekit HIFABU_HOME=$DATA node $SRC/packages/cli/src/vk.mjs relay token push|pull'"
