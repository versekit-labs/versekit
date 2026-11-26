#!/usr/bin/env bash
# 在 seoul-vps 由协调器于 R7 切换前后运行，只做只读检查。
set -euo pipefail
[[ $# == 0 ]] || { echo "用法：check-rename.sh（从 seoul-vps 运行）" >&2; exit 1; }
systemctl is-active --quiet hifabu-cloud.service
systemctl is-active --quiet nginx.service
check() {
  local url="$1" expected="$2" status
  status="$(curl --noproxy '*' --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "$url")"
  if [[ "$status" != "$expected" ]]; then
    printf '%s：HTTP %s，预期 %s\n' "$url" "$status" "$expected" >&2
    return 1
  fi
  printf '%s：HTTP %s\n' "$url" "$status"
}
check 'http://127.0.0.1:8791/login' 200
check 'https://hifabu.com/login' 200
check 'https://vk.fangyouxi.cn/v1/ping' 401
check 'https://assurelane.ai/' 200
