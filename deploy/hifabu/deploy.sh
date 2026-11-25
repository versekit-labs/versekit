#!/usr/bin/env bash
set +x
set -euo pipefail

source_dir="$(dirname "${BASH_SOURCE[0]}")"
SOURCE="$(cd "$source_dir" && pwd)"
ROOT="$(cd "$SOURCE/../.." && pwd)"
APP=/opt/hifabu-cloud
CONFIG=/etc/hifabu-cloud
ENV_FILE=$CONFIG/cloud.env
KEY=$CONFIG/machine-signing-key.pem
NGINX=/etc/nginx/conf.d/hifabu.conf
UNIT=hifabu-cloud.service
UNIT_FILE=/etc/systemd/system/$UNIT
NODE=/usr/local/bin/node
KEY_URL=/.well-known/hifabu-machine-key.pem

if [[ ${1:-} == --dry-run && $# == 1 ]]; then
  cat <<PLAN
Hifabu 部署预览
  读取：${SOURCE}/cloud.env.example、${SOURCE}/nginx-account.conf.snippet、${SOURCE}/${UNIT}、${NGINX}
  预检：${NODE} -e 检查版本（至少 22.13）；nginx -t
  目录与互斥锁：install -d ${CONFIG} ${APP} ${APP}/releases；flock -n ${CONFIG}/deploy.lock；mktemp -d 建立暂存目录
  服务用户：id hifabu-cloud；缺失时 useradd --system --user-group --home-dir /var/lib/hifabu-cloud --shell /usr/sbin/nologin hifabu-cloud
  配置：cp 模板或已有 ${ENV_FILE} 到暂存目录；chown root:root 和 chmod 600；grep 检查密钥
  缺密钥时在服务器终端 read -rs，用 sed 和 printf 更新 600 临时文件，再 mv 到 ${ENV_FILE}
  签名私钥（缺失时）：openssl genpkey -algorithm ED25519，先写 ${CONFIG} 下的临时文件，再 chown hifabu-cloud:hifabu-cloud、chmod 600、mv 到 ${KEY}
  发布目录：git -C "${ROOT}" rev-parse HEAD；在 ${APP}/releases 下 mktemp -d；git archive <SHA> packages/cloud/src packages/core/src/commands.mjs packages/core/src/routes.mjs | tar -xf -；chmod 755 后 mv 到 ${APP}/releases/<SHA>
  systemd：cp -p 备份已有 ${UNIT_FILE}；install -m 644 ${SOURCE}/${UNIT} ${UNIT_FILE}；readlink 记录旧版本；ln -s + mv -Tf 切换 ${APP}/current
  systemctl daemon-reload；systemctl restart ${UNIT}；curl http://127.0.0.1:8791${KEY_URL}，按需 sleep 1 重试
  nginx：cp -p ${NGINX} 到暂存目录，再用 ${NODE} ${SOURCE}/render-nginx.mjs 和 ${SOURCE}/nginx-account.conf.snippet 生成新配置
  cmp 检查站点配置；如有改动，mktemp + cp -p 备份为 ${NGINX}.pre-hifabu.*，用 cat 写候选文件并 mv；nginx -t；systemctl reload nginx
  自检：${NODE} ${SOURCE}/verify.mjs ${KEY}
    GET https://assurelane.ai/ 和 https://hifabu.com/ → 200
    GET https://hifabu.com${KEY_URL} → 与私钥对应的公钥
    GET https://hifabu.com/login → 200；POST https://hifabu.com/login/google → 303
    Location 指向 https://accounts.google.com，redirect_uri=https://hifabu.com/login/google/callback
  systemctl enable ${UNIT}；systemd 在 /var/lib/hifabu-cloud 保存账号库与日志
  若失败：用备份还原 ${NGINX} 和 ${UNIT_FILE}，恢复 ${APP}/current，重载 nginx / systemd 并重启旧版本；首次部署则停止服务
  临时文件：${CONFIG} 下的 deploy.*，${NGINX} 旁的 next.*，${APP} 下的 current.next 和 releases/staging.*，由 trap 调用 rm 清理
PLAN
  exit 0
fi

fail() { printf '部署失败：%s\n' "$*" >&2; exit 1; }
[[ $# == 0 ]] || fail "用法：$0 [--dry-run]"
[[ $EUID == 0 ]] || fail "请在 seoul-vps 的 root 终端运行此脚本。"
[[ -f "$NGINX" && ! -L "$NGINX" ]] || fail "找不到常规文件 $NGINX。"
"$NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)' ||
  fail "需要 $NODE（Node ≥ 22.13）。"
nginx -t

umask 077
install -d -o root -g root -m 0711 "$CONFIG"
exec 9>"$CONFIG/deploy.lock"
flock -n 9 || fail "另一个 Hifabu 部署正在运行。"
scratch="$(mktemp -d "$CONFIG/deploy.XXXXXX")"
nginx_next=
nginx_backup=
nginx_changed=false
app_changed=false
unit_changed=false
old_release=
release=
staged_release=

cleanup() {
  local status=$?
  if (( status )); then
    set +e
    if $nginx_changed; then
      if cp -p "$nginx_backup" "$nginx_next" && mv -f "$nginx_next" "$NGINX" && nginx -t; then
        systemctl reload nginx || printf '请手动重载 nginx。\n' >&2
      else
        printf '请从 %s 手动恢复 nginx。\n' "$nginx_backup" >&2
      fi
    fi
    if $app_changed; then
      if [[ -n "$old_release" ]]; then
        ln -sfn "$old_release" "$APP/current.next" && mv -Tf "$APP/current.next" "$APP/current"
      else
        systemctl stop "$UNIT"
        rm -f "$APP/current"
      fi
    fi
    if $unit_changed; then
      if [[ -f "$scratch/previous.service" ]]; then
        cp -p "$scratch/previous.service" "$UNIT_FILE"
      else
        systemctl disable "$UNIT"
        rm -f "$UNIT_FILE"
      fi
      systemctl daemon-reload
    fi
    if $app_changed && [[ -n "$old_release" ]]; then
      systemctl restart "$UNIT" || printf '请手动启动原 Hifabu 版本。\n' >&2
    fi
    printf 'Hifabu 部署中断，账号库与签名私钥保留。\n' >&2
  fi
  rm -f -- ${nginx_next:+"$nginx_next"} "$APP/current.next"
  if [[ -n "$staged_release" ]]; then rm -rf -- "$staged_release"; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp -p "$NGINX" "$scratch/original.conf"
"$NODE" "$SOURCE/render-nginx.mjs" "$scratch/original.conf" "$SOURCE/nginx-account.conf.snippet" > "$scratch/hifabu.conf"
id hifabu-cloud >/dev/null 2>&1 ||
  useradd --system --user-group --home-dir /var/lib/hifabu-cloud --shell /usr/sbin/nologin hifabu-cloud
[[ ! -L "$ENV_FILE" && ! -L "$KEY" ]] || fail "环境文件或签名私钥不能是符号链接。"

if [[ -e "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || fail "环境文件必须是普通文件。"
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  cp "$ENV_FILE" "$scratch/cloud.env"
else
  cp "$SOURCE/cloud.env.example" "$scratch/cloud.env"
fi
secret_assignment='^[[:blank:]]*HIFABU_GOOGLE_CLIENT_SECRET='
if [[ "$(grep -c "$secret_assignment" "$scratch/cloud.env" || true)" -gt 1 ]]; then
  fail "环境文件中有多条 HIFABU_GOOGLE_CLIENT_SECRET，请在服务器上整理为一条。"
fi
if ! grep -qE "${secret_assignment}[[:blank:]]*([A-Za-z0-9_-]+|\"[A-Za-z0-9_-]+\"|'[A-Za-z0-9_-]+')[[:blank:]]*$" "$scratch/cloud.env"; then
  unset google_secret
  read -rs -p "Google OAuth 客户端密钥：" google_secret </dev/tty || fail "请在服务器终端输入密钥。"
  printf '\n' >&2
  [[ "$google_secret" =~ ^[A-Za-z0-9_-]+$ ]] || fail "Google 客户端密钥为空或格式无效。"
  sed "/$secret_assignment/d" "$scratch/cloud.env" > "$scratch/cloud.env.next"
  printf 'HIFABU_GOOGLE_CLIENT_SECRET=%s\n' "$google_secret" >> "$scratch/cloud.env.next"
  unset google_secret
  mv -f "$scratch/cloud.env.next" "$ENV_FILE"
fi

if [[ ! -e "$KEY" ]]; then
  openssl genpkey -algorithm ED25519 -out "$scratch/signing-key.pem"
  chown hifabu-cloud:hifabu-cloud "$scratch/signing-key.pem"
  chmod 0600 "$scratch/signing-key.pem"
  mv -f "$scratch/signing-key.pem" "$KEY"
fi
[[ -f "$KEY" ]] || fail "签名私钥必须是普通文件。"
chown hifabu-cloud:hifabu-cloud "$KEY"
chmod 0600 "$KEY"

install -d -o root -g root -m 0755 "$APP" "$APP/releases"
revision="$(git -C "$ROOT" rev-parse HEAD)"
release="$APP/releases/$revision"
if [[ ! -d "$release" ]]; then
  staged_release="$(mktemp -d "$APP/releases/staging.XXXXXX")"
  git -C "$ROOT" archive "$revision" packages/cloud/src packages/core/src/commands.mjs packages/core/src/routes.mjs |
    (umask 022; tar -xf - -C "$staged_release" --no-same-owner)
  chmod 0755 "$staged_release"
  mv -T "$staged_release" "$release"
  staged_release=
fi
if [[ -L "$APP/current" ]]; then
  old_release="$(readlink "$APP/current")"
  printf '原 Hifabu 版本：%s\n' "$old_release"
elif [[ -e "$APP/current" ]]; then
  fail "$APP/current 必须是符号链接。"
fi

if [[ -f "$UNIT_FILE" ]]; then cp -p "$UNIT_FILE" "$scratch/previous.service"; fi
unit_changed=true
install -m 0644 "$SOURCE/$UNIT" "$UNIT_FILE"
ln -s "$release" "$APP/current.next"
mv -Tf "$APP/current.next" "$APP/current"
app_changed=true
systemctl daemon-reload
systemctl restart "$UNIT"
for ((attempt=1; attempt<=15; attempt++)); do
  if curl --noproxy '*' --fail --silent --output /dev/null --max-time 2 "http://127.0.0.1:8791$KEY_URL"; then
    break
  fi
  (( attempt < 15 )) || fail "账号服务未就绪，请查看 journalctl -u $UNIT。"
  sleep 1
done

cmp -s "$NGINX" "$scratch/original.conf" || fail "$NGINX 在部署过程中发生变化，请重新部署。"
if ! cmp -s "$NGINX" "$scratch/hifabu.conf"; then
  nginx_backup="$(mktemp "$NGINX.pre-hifabu.XXXXXX")"
  nginx_next="$(mktemp "$NGINX.next.XXXXXX")"
  cp -p "$NGINX" "$nginx_backup"
  cp -p "$NGINX" "$nginx_next"
  cat "$scratch/hifabu.conf" > "$nginx_next"
  nginx_changed=true
  mv -f "$nginx_next" "$NGINX"
  nginx -t
  systemctl reload nginx
  printf 'nginx 备份：%s\n' "$nginx_backup"
else
  nginx -t
fi
"$NODE" "$SOURCE/verify.mjs" "$KEY"
systemctl enable "$UNIT"
printf 'Hifabu 版本目录：%s\n' "$release"
