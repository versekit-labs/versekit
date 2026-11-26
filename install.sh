#!/usr/bin/env bash
# 旧安装地址的兼容入口。正式版安装脚本由发布流程生成。
# git archive 写入提交号，供仍在运行的旧更新器使用。
APP_COMMIT_STAMP='$Format:%H$'

# 从管道运行时，读到最后一行才开始安装。
main() {
  set -euo pipefail

  # 旧更新器从本地源码包运行这份脚本，并在安装后负责自检和退回。
  if [ "${HIFABU_UPDATE-${VERSEKIT_UPDATE:-}}" = 1 ] &&
    [[ "${HIFABU_APP_URL-${VERSEKIT_APP_URL:-}}" = file:///* ]]; then
    local source="${BASH_SOURCE[0]:-}"
    local template="${source%/*}/deploy/hifabu/install-template.sh"
    if [ "${source%/*}" = "$source" ]; then template="./deploy/hifabu/install-template.sh"; fi
    [ -f "$template" ] || { printf '安装失败：旧更新程序的源码包缺少安装模板。\n' >&2; return 1; }
    export HIFABU_SOURCE_COMMIT="$APP_COMMIT_STAMP"
    exec bash "$template" "$@"
  fi

  printf '安装地址已改为 hifabu.com/download\n'
  local base=https://hifabu.com/download
  if [ "${HIFABU_INSTALL_TEST:-}" = 1 ]; then
    base="${HIFABU_DOWNLOAD_URL:-}"
    base="${base%/}"
    if ! [[ "$base" =~ ^http://127\.0\.0\.1:[0-9]+(/[^[:space:]]*)?$ || "$base" = file:///* ]]; then
      printf '安装失败 [install_failed]：测试下载源必须是本地 HTTP 或文件目录。\n' >&2
      return 1
    fi
  elif [ -n "${HIFABU_DOWNLOAD_URL:-}" ]; then
    printf '安装失败 [install_failed]：仅离线测试可设置测试下载源。\n' >&2
    return 1
  fi
  DOWNLOAD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/hifabu-download.XXXXXX")"
  trap 'rm -rf "$DOWNLOAD_TMP"' EXIT
  trap 'exit 130' INT TERM

  fail() { printf '安装失败 [install_failed]：%s\n' "$*" >&2; exit 1; }
  fetch() {
    curl -q -fsSL --proto-redir '=https' --retry 2 --connect-timeout 15 -o "$2" -- "$base/$1" </dev/null ||
      fail "下载 $1 失败，请检查网络后重试"
  }
  sha_of() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"
    elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"
    else fail "缺少 shasum 或 sha256sum"; fi | awk '{print $1}'
  }

  fetch latest.json "$DOWNLOAD_TMP/latest.json"
  local version manifest_sha
  if ! perl -MJSON::PP -e '
    my $latest = decode_json(do { local $/; <STDIN> });
    my $v = $latest->{version};
    die "版本指针格式错误\n" unless $v =~ /\A[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?\z/
      && $latest->{manifest} eq "$v/manifest.json" && $latest->{sha256} =~ /\A[0-9a-f]{64}\z/;
    print "$v\n$latest->{sha256}\n";
  ' <"$DOWNLOAD_TMP/latest.json" >"$DOWNLOAD_TMP/pointer"; then
    fail "无法读取 latest.json，请确认系统有 Perl 与 JSON::PP"
  fi
  { IFS= read -r version; IFS= read -r manifest_sha; } <"$DOWNLOAD_TMP/pointer"

  fetch "$version/SHA256SUMS" "$DOWNLOAD_TMP/SHA256SUMS"
  fetch "$version/manifest.json" "$DOWNLOAD_TMP/manifest.json"
  sum_entry() {
    awk -v name="$1" 'NF==2 && $2==name { sum=$1; count++ } END { if (count==1) print sum }' "$DOWNLOAD_TMP/SHA256SUMS"
  }
  verify() {
    local got
    got="$(sha_of "$DOWNLOAD_TMP/$1")"
    [ "$got" = "$2" ] || fail "$version/$1 的 SHA-256 校验不通过（期望 ${2}，实际 ${got}）"
  }
  local listed_manifest install_sha
  listed_manifest="$(sum_entry manifest.json)"
  [ "$listed_manifest" = "$manifest_sha" ] ||
    fail "$version/SHA256SUMS 中 manifest.json 的 SHA-256 与 latest.json 不符（期望 ${manifest_sha}，实际 ${listed_manifest:-缺少唯一哈希}）"
  verify manifest.json "$manifest_sha"
  install_sha="$(sum_entry install.sh)"
  [[ "$install_sha" =~ ^[0-9a-f]{64}$ ]] ||
    fail "$version/SHA256SUMS 中 install.sh 的 SHA-256 无效（期望唯一的 64 位十六进制哈希，实际 ${install_sha:-缺少唯一哈希}）"
  fetch "$version/install.sh" "$DOWNLOAD_TMP/install.sh"
  verify install.sh "$install_sha"
  bash "$DOWNLOAD_TMP/install.sh" "$@"
}

main "$@"
