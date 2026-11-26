#!/usr/bin/env bash
# versekit 一键安装 / 升级（ACC-install-01..06）
#
#   curl -fsSL https://raw.githubusercontent.com/versekit-labs/versekit/main/install.sh | bash
#
# 做的事：私有 Node（不动系统里的）→ versekit 程序 → biliup → 飞书组件 lark-cli → hifabu init → 后台服务 → 打开控制台。
# 全程不用 sudo、不问问题。再运行一次就是升级：数据库、配置、凭证、账号、浏览器登录都保留。
#
# 可用环境变量覆盖（开发机上验证用）：
#   VERSEKIT_PREFIX          安装目录               默认 ~/.versekit
#   VERSEKIT_PORT            控制台端口             默认 8787（被占用时自动换空闲端口）
#   VERSEKIT_SERVICE_LABEL   服务名                 默认 com.versekit.daemon
#   VERSEKIT_SERVICE_MANAGER 强制 launchd|systemd|detach
#   VERSEKIT_NODE_VERSION    Node 版本（写死，不用 latest-*）    默认 v26.13.1（Node 26 LTS）
#   VERSEKIT_NODE_URL        Node 下载目录（含 SHASUMS256.txt）  默认 https://nodejs.org/dist/<Node 版本>
#   VERSEKIT_APP_URL         versekit tarball 地址   VERSEKIT_APP_SHA256 可选校验
#   VERSEKIT_BILIUP_URL      biliup-rs 压缩包地址    VERSEKIT_BILIUP_VERSION 默认 v0.2.4
#   VERSEKIT_LARK_VERSION    飞书组件 lark-cli 版本（写死）   默认 1.0.97
#   VERSEKIT_LARK_URL        lark-cli 下载目录（含 checksums.txt）  默认 https://github.com/larksuite/cli/releases/download/v<版本>
#   VERSEKIT_OFFLINE=1       服务以 --offline 启动（不访问任何平台）
#   VERSEKIT_NO_OPEN=1       不自动打开浏览器
#   VERSEKIT_APP_COMMIT      这份程序对应的提交号（40 位）；不给就用 tarball 里 install.sh 被 export-subst 写入的那个
#   VERSEKIT_UPDATE=1        后台自动更新（hifabu update）用：不动 PATH 配置、不开浏览器，升完保留 app.prev
#                            给更新程序做「起来后自检、不行就退回」，由它自己清掉
#   VK_HOME                  数据目录的 HOME（和 hifabu 本身一致）

# 提交号：GitHub 源码包（git archive）会把这一行的占位符替换成 40 位提交号（见 .gitattributes 的 export-subst）。
# 直接从 raw 地址拿到的脚本里它没被替换，下面只认 40 位十六进制，所以不会误读。
APP_COMMIT_STAMP='$Format:%H$'

# 整个脚本包在 main 里、最后一行才调用：下载被截断时不会执行半截脚本；
# 也避免子命令读 stdin 把管道里后面的脚本吃掉。
main() {
  set -euo pipefail

  # 下面这些是全局变量（不加 local）：EXIT trap 在 main 返回之后才触发，那时 local 已经没了。
  PREFIX="${VERSEKIT_PREFIX:-$HOME/.versekit}"
  local WANT_PORT
  # Node 版本号写死（升级 Node 时改这一行并过一遍测试），不用 latest-* 这类会漂的地址：
  # 同一份脚本任何时候装出来的 Node 都一样，SHASUMS256 校验的也是这个确定的版本。
  local NODE_VERSION="${VERSEKIT_NODE_VERSION:-v26.13.1}"
  local NODE_URL="${VERSEKIT_NODE_URL:-https://nodejs.org/dist/$NODE_VERSION}"
  local APP_URL="${VERSEKIT_APP_URL:-https://codeload.github.com/versekit-labs/versekit/tar.gz/refs/heads/main}"
  local BILIUP_VERSION="${VERSEKIT_BILIUP_VERSION:-v0.2.4}"
  # lark-cli：飞书官方命令行（larksuite/cli）。官方发布渠道是 GitHub Releases，每个版本附 checksums.txt
  # （与 npm 包 @larksuite/cli 里自带的那份逐字相同），按它校验。版本写死，升级时改这一行并过测试。
  local LARK_VERSION="${VERSEKIT_LARK_VERSION:-1.0.97}"
  local LARK_URL="${VERSEKIT_LARK_URL:-https://github.com/larksuite/cli/releases/download/v$LARK_VERSION}"
  local STEP="准备"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/versekit-install.XXXXXX")"
  SWAPPED=0 HAD_APP=0 SERVICE_TOUCHED=0 DONE=0 OLD_PORT=""

  # ------------------------------------------------------------ 输出与失败处理
  say() { printf '▸ %s\n' "$*"; }
  die() { # die <原因> <怎么办>
    printf '\n✗ 安装失败：在「%s」这一步\n  原因：%s\n  怎么办：%s\n' "$STEP" "$1" "$2" >&2
    exit 1
  }
  cleanup() {
    local code=$?
    if [ "$DONE" != 1 ]; then rollback || true; fi
    rm -rf "$TMP"
    return $code
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  installed_cli() {
    if [ -x "$PREFIX/bin/hifabu" ]; then printf '%s\n' "$PREFIX/bin/hifabu"
    else printf '%s\n' "$PREFIX/bin/vk"; fi
  }

  # 失败时回到安装前：旧程序放回去（升级）或把服务卸掉（首次），绝不留下半启动的服务。
  rollback() {
    [ "$SERVICE_TOUCHED" = 1 ] || [ "$SWAPPED" = 1 ] || return 0
    local cli
    cli="$(installed_cli)"
    if [ -x "$cli" ] && [ -d "$PREFIX/app" ]; then "$cli" service uninstall --service-only >/dev/null 2>&1 || true; fi
    if [ "$SWAPPED" = 1 ]; then
      rm -rf "$PREFIX/app"
      if [ "$HAD_APP" = 1 ] && [ -d "$PREFIX/app.prev" ]; then
        mv "$PREFIX/app.prev" "$PREFIX/app"
        if [ -x "$cli" ] && [ -n "${OLD_PORT:-}" ]; then
          local extra=(); [ "${VERSEKIT_OFFLINE:-}" = 1 ] && extra=(--offline)
          "$cli" service install --port "$OLD_PORT" ${extra[@]+"${extra[@]}"} >/dev/null 2>&1 || true
          printf '  已回到升级前的版本并尝试恢复旧服务。\n' >&2
        fi
      fi
    fi
  }

  # ------------------------------------------------------------ 平台
  STEP="检查系统"
  local OS ARCH NODE_PLAT BILIUP_PLAT
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    *) die "不支持这个系统：$(uname -s)" "目前只支持 macOS 与 Linux（Windows 请用 WSL）" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) ARCH=arm64 ;;
    x86_64|amd64) ARCH=x64 ;;
    *) die "不支持这个 CPU：$(uname -m)" "目前只支持 arm64 与 x86_64" ;;
  esac
  NODE_PLAT="$OS-$ARCH"
  local LARK_PLAT="$OS-amd64"; [ "$ARCH" = arm64 ] && LARK_PLAT="$OS-arm64"
  if [ "$OS" = darwin ]; then
    [ "$ARCH" = arm64 ] && BILIUP_PLAT="aarch64-macos" || BILIUP_PLAT="x86_64-macos"
  else
    [ "$ARCH" = arm64 ] && BILIUP_PLAT="aarch64-linux" || BILIUP_PLAT="x86_64-linux"
  fi
  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || die "缺少系统自带工具 $tool" "先安装 $tool 再重新运行"
  done
  local SHA
  if command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
  elif command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
  else die "缺少 shasum / sha256sum，没法校验下载" "安装 coreutils 后重新运行"; fi

  # 终端是 tty 时显示 curl 进度条（stderr），否则（管道、CI、日志）静默，不刷屏。
  fetch() { # fetch <url> <输出文件>
    local flags=-fsSL
    [ -t 2 ] && flags="-fL --progress-bar"
    # shellcheck disable=SC2086
    curl $flags --retry 2 --connect-timeout 15 -o "$2" "$1" </dev/null ||
      die "下载失败：$1" "检查网络（需要能访问该地址）后重新运行；这条命令可以反复运行"
  }
  sha_of() { $SHA "$1" | awk '{print $1}'; }

  mkdir -p "$PREFIX/bin"
  # 用户看得到的版本号 = <package.json 版本>+<短提交号>（ACC-update-06；JS 侧是 update.mjs 的 displayVersion）。
  version_label() { # version_label <版本> <40 位提交号或空>
    local c="${2:-}"
    if [ -n "$c" ]; then printf '%s+%s' "${1:-未知}" "$(printf '%s' "$c" | cut -c1-7)"; else printf '%s+未知提交' "${1:-未知}"; fi
  }
  local OLD_VERSION="" OLD_COMMIT=""
  if [ -f "$PREFIX/app/package.json" ]; then
    HAD_APP=1
    OLD_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PREFIX/app/package.json" | head -1)"
    OLD_COMMIT="$(sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' "$PREFIX/app/.versekit-build.json" 2>/dev/null | head -1 || true)"
  fi
  local META="${VK_HOME:-$HOME}/.local/state/versekit/service.json"
  if [ -f "$META" ]; then OLD_PORT="$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$META" | head -1)"; fi
  WANT_PORT="${VERSEKIT_PORT:-${OLD_PORT:-8787}}"

  # ------------------------------------------------------------ 1. 私有 Node
  STEP="下载 Node"
  say "准备 Node（装在 $PREFIX/node，不动系统里已有的 Node）"
  fetch "$NODE_URL/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  local NODE_FILE="node-$NODE_VERSION-$NODE_PLAT.tar.gz"
  local NODE_VER="${NODE_VERSION#v}"
  grep -q "  $NODE_FILE\$" "$TMP/SHASUMS256.txt" || die "$NODE_URL/SHASUMS256.txt 里没有 $NODE_FILE" "确认 VERSEKIT_NODE_VERSION（$NODE_VERSION）和 VERSEKIT_NODE_URL 指向同一个官方版本目录"
  local HAVE_NODE="" NODE_STAGED=0
  if [ -x "$PREFIX/node/bin/node" ]; then HAVE_NODE="$("$PREFIX/node/bin/node" -v 2>/dev/null || true)"; fi
  if [ "$HAVE_NODE" = "v$NODE_VER" ]; then
    say "Node v$NODE_VER 已经在了，跳过下载"
  else
    say "下载 Node ${NODE_VERSION}（约 40MB，视网速十几秒到一两分钟）"
    fetch "$NODE_URL/$NODE_FILE" "$TMP/$NODE_FILE"
    STEP="校验 Node"
    say "校验并解压 Node……"
    local WANT GOT
    WANT="$(awk -v f="$NODE_FILE" '$2==f {print $1; exit}' "$TMP/SHASUMS256.txt")"
    GOT="$(sha_of "$TMP/$NODE_FILE")"
    [ "$WANT" = "$GOT" ] || die "Node 压缩包校验不通过（官方 ${WANT}，实际 ${GOT}）" "多半是下载被截断或被劫持，重新运行；反复出现就换一个网络"
    mkdir -p "$TMP/node-x"
    tar -xzf "$TMP/$NODE_FILE" -C "$TMP/node-x" --strip-components=1 || die "Node 解压失败" "重新运行；磁盘空间不足也会这样"
    [ -x "$TMP/node-x/bin/node" ] || die "Node 包里没有 bin/node" "确认 VERSEKIT_NODE_URL 指向官方 dist 目录"
    NODE_STAGED=1 # 先放在临时目录，等所有下载校验都过了再换（下面「安装程序文件」）
  fi

  # ------------------------------------------------------------ 2. versekit 程序
  STEP="下载 versekit"
  say "下载 versekit 程序（约 1MB）"
  fetch "$APP_URL" "$TMP/app.tar.gz"
  if [ -n "${VERSEKIT_APP_SHA256:-}" ]; then
    STEP="校验 versekit"
    [ "$(sha_of "$TMP/app.tar.gz")" = "$VERSEKIT_APP_SHA256" ] || die "versekit 压缩包校验不通过" "重新运行；确认 VERSEKIT_APP_SHA256 对应这个地址"
  fi
  STEP="解压 versekit"
  say "解压 versekit……"
  mkdir -p "$TMP/app-x"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/app-x" --strip-components=1 || die "versekit 压缩包解压失败" "重新运行"
  [ -f "$TMP/app-x/packages/cli/src/vk.mjs" ] && [ -f "$TMP/app-x/package.json" ] ||
    die "下载下来的不是 versekit（没有 packages/cli/src/vk.mjs）" "确认 VERSEKIT_APP_URL 指向仓库的源码 tarball"
  local NEW_VERSION
  NEW_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TMP/app-x/package.json" | head -1)"
  # 程序知道自己是哪个提交（ACC-update-01）：写进程序目录，hifabu version / 系统页读它。
  local APP_COMMIT="${VERSEKIT_APP_COMMIT:-}"
  [ -n "$APP_COMMIT" ] || APP_COMMIT="$(sed -n "s/^APP_COMMIT_STAMP='\([0-9a-f]\{40\}\)'.*/\1/p" "$TMP/app-x/install.sh" 2>/dev/null | head -1 || true)"
  printf '{\n  "commit": "%s",\n  "version": "%s",\n  "installed_at": "%s"\n}\n' "$APP_COMMIT" "$NEW_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$TMP/app-x/.versekit-build.json"

  # ------------------------------------------------------------ 3. biliup
  STEP="下载 biliup"
  say "下载 biliup（约 5MB，装在 $PREFIX/bin）"
  local BILIUP_URL="${VERSEKIT_BILIUP_URL:-https://github.com/biliup/biliup-rs/releases/download/$BILIUP_VERSION/biliupR-$BILIUP_VERSION-$BILIUP_PLAT.tar.xz}"
  fetch "$BILIUP_URL" "$TMP/biliup.pkg"
  STEP="解压 biliup"
  mkdir -p "$TMP/biliup-x"
  tar -xf "$TMP/biliup.pkg" -C "$TMP/biliup-x" || die "biliup 压缩包解压失败（.tar.xz 需要系统带 xz）" "重新运行；Linux 上先装 xz-utils"
  local BILIUP_BIN
  BILIUP_BIN="$(find "$TMP/biliup-x" -type f -name biliup | head -1)"
  [ -n "$BILIUP_BIN" ] || die "biliup 压缩包里没有 biliup 可执行文件" "确认 VERSEKIT_BILIUP_URL 指向 biliup-rs 的发布包"

  # ------------------------------------------------------------ 3b. 飞书组件 lark-cli
  # 装在 $PREFIX/bin（不碰系统里已有的 lark-cli）。已经是这个版本就跳过；先下载校验、暂存，换程序时才落盘。
  # 飞书组件是可选件：下载/校验/解压任何一步失败都只记下原因、跳过它，不拖垮 versekit 本体的安装；
  # 装完会在末尾说清原因和怎么补装（重新运行这一行安装命令即可），系统页「通知」也会提示。
  local LARK_FILE="lark-cli-$LARK_VERSION-$LARK_PLAT.tar.gz" LARK_STAGED="" HAVE_LARK="" LARK_FAIL="" LARK_WANT LARK_GOT
  if [ -x "$PREFIX/bin/lark-cli" ]; then HAVE_LARK="$("$PREFIX/bin/lark-cli" --version 2>/dev/null || true)"; fi
  lark_stage() { # 成功返回 0 并设 LARK_STAGED；失败返回 1 并设 LARK_FAIL
    curl -fsSL --retry 2 --connect-timeout 15 -o "$TMP/lark-checksums.txt" "$LARK_URL/checksums.txt" </dev/null ||
      { LARK_FAIL="下载失败：$LARK_URL/checksums.txt"; return 1; }
    grep -q "  $LARK_FILE\$" "$TMP/lark-checksums.txt" ||
      { LARK_FAIL="${LARK_URL}/checksums.txt 里没有 ${LARK_FILE}"; return 1; }
    curl -fsSL --retry 2 --connect-timeout 15 -o "$TMP/$LARK_FILE" "$LARK_URL/$LARK_FILE" </dev/null ||
      { LARK_FAIL="下载失败：$LARK_URL/$LARK_FILE"; return 1; }
    LARK_WANT="$(awk -v f="$LARK_FILE" '$2==f {print $1; exit}' "$TMP/lark-checksums.txt")"
    LARK_GOT="$(sha_of "$TMP/$LARK_FILE")"
    [ "$LARK_WANT" = "$LARK_GOT" ] ||
      { LARK_FAIL="校验不通过（官方 ${LARK_WANT}，实际 ${LARK_GOT}），多半是下载被截断或被劫持"; return 1; }
    mkdir -p "$TMP/lark-x"
    tar -xzf "$TMP/$LARK_FILE" -C "$TMP/lark-x" || { LARK_FAIL="压缩包解压失败"; return 1; }
    LARK_STAGED="$(find "$TMP/lark-x" -type f -name lark-cli | head -1)"
    [ -n "$LARK_STAGED" ] || { LARK_FAIL="压缩包里没有 lark-cli 可执行文件"; return 1; }
  }
  case "$HAVE_LARK" in
    *"version $LARK_VERSION"|*" $LARK_VERSION") say "飞书组件 lark-cli ${LARK_VERSION} 已经在了，跳过下载" ;;
    *)
      say "下载飞书组件 lark-cli ${LARK_VERSION}（约 10MB，装在 ${PREFIX}/bin，接飞书要用）"
      lark_stage || { LARK_STAGED=""; say "飞书组件没装上（${LARK_FAIL}），先跳过，不影响 versekit 其余部分"; }
      ;;
  esac

  # ------------------------------------------------------------ 换上新程序
  STEP="安装程序文件"
  # 下载和校验都过了才动已安装的东西：任何一步失败都不会破坏现有版本。
  local OLD_CLI
  OLD_CLI="$(installed_cli)"
  if [ -x "$OLD_CLI" ] && [ -d "$PREFIX/app" ]; then "$OLD_CLI" service stop >/dev/null 2>&1 || true; fi
  if [ "$NODE_STAGED" = 1 ]; then rm -rf "$PREFIX/node"; mv "$TMP/node-x" "$PREFIX/node"; fi
  local NODE="$PREFIX/node/bin/node"
  cp "$BILIUP_BIN" "$PREFIX/bin/biliup.new" && chmod +x "$PREFIX/bin/biliup.new" && mv "$PREFIX/bin/biliup.new" "$PREFIX/bin/biliup"
  if [ -n "$LARK_STAGED" ]; then cp "$LARK_STAGED" "$PREFIX/bin/lark-cli.new" && chmod +x "$PREFIX/bin/lark-cli.new" && mv "$PREFIX/bin/lark-cli.new" "$PREFIX/bin/lark-cli"; fi
  rm -rf "$PREFIX/app.prev"
  if [ "$HAD_APP" = 1 ]; then mv "$PREFIX/app" "$PREFIX/app.prev"; elif [ -d "$PREFIX/app" ]; then rm -rf "$PREFIX/app"; fi
  mv "$TMP/app-x" "$PREFIX/app"
  SWAPPED=1
  local HIFABU="$PREFIX/bin/hifabu"
  cat >"$HIFABU.new" <<EOF
#!/bin/sh
# Hifabu 启动器（install.sh 生成）：用私有 Node，并保证 PATH 里有 biliup。
if [ "\${0##*/}" = vk ]; then printf '%s\n' 'vk 已改名为 hifabu' >&2; fi
PATH="$PREFIX/bin:\$PATH"; export PATH
exec "$PREFIX/node/bin/node" --no-warnings "$PREFIX/app/packages/cli/src/vk.mjs" "\$@"
EOF
  chmod +x "$HIFABU.new"
  mv -f "$HIFABU.new" "$HIFABU"
  ln -sfn hifabu "$PREFIX/bin/vk"
  export PATH="$PREFIX/bin:$PATH"

  # ------------------------------------------------------------ 4. init + 服务
  STEP="初始化（hifabu init）"
  say "初始化数据库（hifabu init）……"
  "$HIFABU" init >/dev/null || die "hifabu init 失败" "运行 $HIFABU init 看具体报错"

  STEP="选端口"
  local PORT="$WANT_PORT"
  port_free() { "$NODE" -e 'const s=require("node:net").createServer();s.on("error",()=>process.exit(1));s.listen(+process.argv[1],"127.0.0.1",()=>s.close(()=>process.exit(0)))' "$1" 2>/dev/null; }
  if ! port_free "$PORT"; then
    local n=0 cand
    PORT=""
    while [ $n -lt 30 ]; do
      n=$((n + 1)); cand=$((WANT_PORT + n))
      if port_free "$cand"; then PORT="$cand"; break; fi
    done
    [ -n "$PORT" ] || die "端口 $WANT_PORT 被占用，附近也没有空闲端口" "用 VERSEKIT_PORT=<空闲端口> 重新运行"
    say "端口 $WANT_PORT 被别的程序占用，改用 $PORT"
  fi

  STEP="注册后台服务"
  say "注册后台服务并启动（端口 ${PORT}）"
  local extra=(); [ "${VERSEKIT_OFFLINE:-}" = 1 ] && extra=(--offline)
  SERVICE_TOUCHED=1
  local SVC_OUT
  if ! SVC_OUT="$("$HIFABU" service install --port "$PORT" ${extra[@]+"${extra[@]}"} --human 2>&1)"; then
    local LOGF="${VK_HOME:-$HOME}/.local/state/versekit/vk.log"
    printf '%s\n' "$SVC_OUT" >&2
    [ -f "$LOGF" ] && { printf '  日志最后几行（%s）：\n' "$LOGF" >&2; tail -n 8 "$LOGF" >&2 || true; }
    die "后台服务没能在 30 秒内起来（端口 ${PORT}）" "看上面的日志；修好后重新运行安装命令即可，没有留下半启动的服务"
  fi
  printf '%s\n' "$SVC_OUT" | sed 's/^/  /'

  STEP="等控制台起来"
  say "等控制台起来（最多 30 秒）……"
  local i=0 code=""
  while [ $i -lt 60 ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/today" </dev/null || true)"
    [ "$code" = 200 ] && break
    i=$((i + 1)); sleep 0.5
  done
  [ "$code" = 200 ] || die "控制台 http://127.0.0.1:$PORT/today 没有返回 200（拿到 ${code:-无响应}）" "运行 hifabu service status 与查看 vk.log 排查；修好后重新运行安装命令"

  # ------------------------------------------------------------ 5. PATH 与收尾
  STEP="配置 PATH"
  local UPDATING=0; [ "${VERSEKIT_UPDATE:-}" = 1 ] && UPDATING=1
  add_path_block() { # add_path_block <rc 文件>
    local rc="$1"
    mkdir -p "$(dirname "$rc")"
    if [ -f "$rc" ] && grep -qF '# >>> versekit >>>' "$rc"; then return 0; fi
    {
      [ -s "$rc" ] && printf '\n'
      printf '# >>> versekit >>>\n# 由 versekit 安装脚本添加；hifabu service uninstall 会删掉这一段\nexport PATH="%s/bin:$PATH"\n# <<< versekit <<<\n' "$PREFIX"
    } >>"$rc"
  }
  local SHELL_NAME; SHELL_NAME="$(basename "${SHELL:-}")"
  local RC_FILE
  case "$SHELL_NAME" in
    zsh) RC_FILE="$HOME/.zshrc" ;;
    bash) if [ "$OS" = darwin ]; then RC_FILE="$HOME/.bash_profile"; else RC_FILE="$HOME/.bashrc"; fi ;;
    fish)
      RC_FILE=""
      [ "$UPDATING" = 1 ] || { mkdir -p "$HOME/.config/fish/conf.d"
      printf '# 由 versekit 安装脚本添加；hifabu service uninstall 会删掉这个文件\nfish_add_path "%s/bin"\n' "$PREFIX" >"$HOME/.config/fish/conf.d/versekit.fish"; }
      ;;
    *) RC_FILE="$HOME/.profile" ;;
  esac
  [ -z "$RC_FILE" ] || [ "$UPDATING" = 1 ] || add_path_block "$RC_FILE"

  STEP="打开控制台"
  local URL="http://127.0.0.1:$PORT"
  if [ "${VERSEKIT_NO_OPEN:-}" != 1 ] && [ "$UPDATING" != 1 ]; then
    if [ "$OS" = darwin ]; then open "$URL" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
  fi

  # 后台更新要在「新版本起来后自检」通过之后才丢掉旧程序，所以那种情况留给更新程序清。
  [ "$UPDATING" = 1 ] || rm -rf "$PREFIX/app.prev"
  DONE=1
  local OLD_LABEL NEW_LABEL
  OLD_LABEL="$(version_label "$OLD_VERSION" "$OLD_COMMIT")"
  NEW_LABEL="$(version_label "$NEW_VERSION" "$APP_COMMIT")"
  if [ "$HAD_APP" = 1 ] && [ -n "$APP_COMMIT" ] && [ "$OLD_COMMIT" = "$APP_COMMIT" ]; then
    say "已是最新（$(printf '%s' "$APP_COMMIT" | cut -c1-7)），重新装了一遍（数据、账号、登录都保留）"
  elif [ "$HAD_APP" = 1 ]; then say "已升级 ${OLD_LABEL} → ${NEW_LABEL}（数据、账号、登录都保留）"
  else say "已安装 ${NEW_LABEL}"; fi
  say "新开的终端里可以直接用 hifabu；日常管理：hifabu service status | restart | stop | uninstall"
  if [ -n "$LARK_FAIL" ]; then
    printf '⚠ 飞书组件没装上：%s\n  versekit 其余部分已装好；要接飞书，网络通了以后重新运行这一行安装命令即可（可以反复运行，数据、账号、登录都保留）。\n' "$LARK_FAIL" >&2
  fi
  printf '装好了，控制台地址 %s，终端可以关了\n' "$URL"
}

main "$@"
