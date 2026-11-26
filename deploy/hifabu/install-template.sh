#!/usr/bin/env bash
# Hifabu 正式版安装器。发布脚本把版本、地址和 SHA-256 嵌入这一行。
HIFABU_RELEASE_MANIFEST=@HIFABU_RELEASE_MANIFEST@

# 整个脚本包在 main 里、最后一行才调用：下载被截断时不会执行半截脚本；
# 也避免子命令读 stdin 把管道里后面的脚本吃掉。
main() {
  set -euo pipefail

  # 兼容旧终端配置和旧版自动更新器。导出新名，子进程沿用相同值。
  legacy_env() {
    local name="$1" legacy="$2"
    if [ -z "${!name+x}" ] && [ -n "${!legacy+x}" ]; then
      printf '%s 已改名为 %s，请更新环境变量。\n' "$legacy" "$name" >&2
      export "$name=${!legacy}"
    fi
  }
  legacy_env HIFABU_HOME VK_HOME
  legacy_env HIFABU_PREFIX VERSEKIT_PREFIX
  legacy_env HIFABU_PORT VERSEKIT_PORT
  legacy_env HIFABU_SERVICE_LABEL VERSEKIT_SERVICE_LABEL
  legacy_env HIFABU_SERVICE_MANAGER VERSEKIT_SERVICE_MANAGER
  legacy_env HIFABU_APP_URL VERSEKIT_APP_URL
  legacy_env HIFABU_APP_SHA256 VERSEKIT_APP_SHA256
  legacy_env HIFABU_OFFLINE VERSEKIT_OFFLINE
  legacy_env HIFABU_NO_OPEN VERSEKIT_NO_OPEN
  legacy_env HIFABU_APP_COMMIT VERSEKIT_APP_COMMIT
  legacy_env HIFABU_UPDATE VERSEKIT_UPDATE

  # 下面这些是全局变量（不加 local）：EXIT trap 在 main 返回之后才触发，那时 local 已经没了。
  PREFIX="${HIFABU_PREFIX:-$HOME/.versekit}"
  PREFIX="${PREFIX%/}"
  local WANT_PORT LEGACY=0
  local UPDATING=0; [ "${HIFABU_UPDATE:-}" = 1 ] && UPDATING=1
  if [ "${HIFABU_RELEASE_MANIFEST:0:1}" = @ ]; then LEGACY=1; fi
  STEP="准备"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/versekit-install.XXXXXX")"
  BIN_FILES=(hifabu vk) LOCK=""
  APP_BACKED_UP=0 APP_REPLACED=0 PREV_BACKED_UP=0 NODE_REPLACED=0 BIN_TOUCHED=0 STAGE=""
  HAD_APP=0 SERVICE_STOPPED=0 SERVICE_TOUCHED=0 SERVICE_INSTALLED=0 DONE=0
  OLD_PORT="" OLD_SERVICE_LABEL="" OLD_MANAGER="" OLD_OFFLINE="" FAIL_REASON=""
  META="${HIFABU_HOME:-$HOME}/.local/state/versekit/service.json"

  # ------------------------------------------------------------ 输出与失败处理
  say() { printf '▸ %s\n' "$*"; }
  die() { # die <原因> <怎么办>
    FAIL_REASON="$1"
    printf '\n✗ 安装失败 [install_failed]：在「%s」这一步\n  原因：%s\n  怎么办：%s\n' "$STEP" "$1" "$2" >&2
    exit 1
  }
  cleanup() {
    local code=$? keep_backup=0
    if [ "$DONE" != 1 ]; then
      if [ "$code" = 0 ]; then code=1; fi
      if [ -z "$FAIL_REASON" ]; then
        printf '安装失败 [install_failed]：在「%s」这一步（退出码 %s）。\n' "$STEP" "$code" >&2
      fi
      if ! rollback; then
        keep_backup=1
        printf '  未能恢复升级前的后台服务，请查看上方错误。安装备份保留在 %s。\n' "$TMP" >&2
        if [ -n "$STAGE" ]; then printf '  程序文件备份位于 %s。\n' "$STAGE" >&2; fi
      fi
      if [ "$HAD_APP" = 1 ] && [ "${HIFABU_UPDATE:-}" != 1 ]; then
        local reason="${FAIL_REASON:-「${STEP}」执行失败（退出码 ${code}）}"
        "$PREFIX/node/bin/node" --no-warnings --input-type=module -e '
          import { pathToFileURL } from "node:url";
          const [core, reason] = process.argv.slice(1);
          const { emit } = await import(pathToFileURL(core));
          emit({ type: "update.failed", severity: "warn",
            payload: { error_code: "install_update_failed", reason, message: "安装升级失败：" + reason } });
        ' "$PREFIX/app/packages/core/src/index.mjs" "$reason" ||
          printf '  写入升级失败事件未成功。\n' >&2
      fi
    fi
    if [ "$keep_backup" = 0 ]; then
      rm -rf "$TMP"
      [ -z "$STAGE" ] || rm -rf "$STAGE"
    fi
    [ -z "$LOCK" ] || rmdir "$LOCK" || true
    exit "$code"
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  installed_cli() {
    if [ -x "$PREFIX/bin/hifabu" ]; then printf '%s\n' "$PREFIX/bin/hifabu"
    else printf '%s\n' "$PREFIX/bin/vk"; fi
  }

  # 停止或恢复升级前的服务时，旧程序可能只认旧变量名。
  previous_cli() (
    if [ -n "${HIFABU_HOME+x}" ]; then export VK_HOME="$HIFABU_HOME"; fi
    export HIFABU_PREFIX="$PREFIX" VERSEKIT_PREFIX="$PREFIX"
    export HIFABU_SERVICE_LABEL="$OLD_SERVICE_LABEL" VERSEKIT_SERVICE_LABEL="$OLD_SERVICE_LABEL"
    export HIFABU_SERVICE_MANAGER="$OLD_MANAGER" VERSEKIT_SERVICE_MANAGER="$OLD_MANAGER"
    export HIFABU_OFFLINE="$OLD_OFFLINE" VERSEKIT_OFFLINE="$OLD_OFFLINE"
    "$@"
  )

  # 失败时回到安装前：旧程序放回去（升级）或把服务卸掉（首次），绝不留下半启动的服务。
  rollback() {
    local cli file failed=0 removed=0
    cli="$(installed_cli)"
    if [ "$SERVICE_TOUCHED" = 1 ] && {
      [ "$SERVICE_INSTALLED" = 1 ] || [ ! -f "$TMP/service.prev" ] || ! cmp -s "$TMP/service.prev" "$META"
    }; then
      "$cli" service uninstall --service-only --human >&2 && removed=1 || failed=1
    fi
    if [ "$APP_REPLACED" = 1 ]; then rm -rf "$PREFIX/app" || failed=1; fi
    if [ "$APP_BACKED_UP" = 1 ] && [ -d "$PREFIX/app.prev" ]; then mv "$PREFIX/app.prev" "$PREFIX/app" || failed=1; fi
    if [ "$PREV_BACKED_UP" = 1 ]; then mv "$STAGE/app.prev" "$PREFIX/app.prev" || failed=1; fi
    if [ "$NODE_REPLACED" = 1 ] || { [ -n "$STAGE" ] && [ -d "$STAGE/node.prev" ]; }; then
      rm -rf "$PREFIX/node" || failed=1
      if [ -d "$STAGE/node.prev" ]; then mv "$STAGE/node.prev" "$PREFIX/node" || failed=1; fi
    fi
    if [ "$BIN_TOUCHED" = 1 ]; then
      for file in "${BIN_FILES[@]}"; do
        rm -f "$PREFIX/bin/$file" "$PREFIX/bin/$file.new" || failed=1
        if [ -e "$STAGE/bin.prev/$file" ] || [ -L "$STAGE/bin.prev/$file" ]; then
          mv "$STAGE/bin.prev/$file" "$PREFIX/bin/$file" || failed=1
        fi
      done
    fi
    if [ "$SERVICE_STOPPED" = 1 ]; then
      cli="$(installed_cli)"
      cp -p "$TMP/service.prev" "$META" || failed=1
      if [ "$removed" = 1 ]; then
        # 新服务已提交后才失败；此时旧定义可能已经删除，需要旧版重新生成。
        previous_cli "$cli" service install --port "$OLD_PORT" --human >&2 || failed=1
      else
        previous_cli "$cli" service start --human >&2 || failed=1
      fi
      curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$OLD_PORT/today" || failed=1
      curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$OLD_PORT/api/now" || failed=1
      if [ "$failed" = 0 ]; then printf '  已恢复升级前的后台服务。\n' >&2; fi
    fi
    [ "$failed" = 0 ]
  }

  # ------------------------------------------------------------ 平台
  STEP="检查系统"
  local OS ARCH PLATFORM
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
  PLATFORM="$OS-$ARCH"
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
    curl -q $flags --proto-redir '=https' --retry 2 --connect-timeout 15 -o "$2" -- "$1" </dev/null ||
      die "下载失败：$1" "检查网络（需要能访问该地址）后重新运行；这条命令可以反复运行"
  }
  sha_of() { $SHA "$1" | awk '{print $1}'; }

  # 用户看得到的版本号 = <package.json 版本>+<短提交号>（ACC-update-06；JS 侧是 update.mjs 的 displayVersion）。
  version_label() { # version_label <版本> <40 位提交号或空>
    local c="${2:-}"
    if [ -n "$c" ]; then printf '%s+%s' "${1:-未知}" "$(printf '%s' "$c" | cut -c1-7)"; else printf '%s+未知提交' "${1:-未知}"; fi
  }
  STEP="锁定安装目录"
  mkdir -p "$(dirname "$PREFIX")"
  if mkdir "$PREFIX.install.lock" 2>/dev/null; then
    LOCK="$PREFIX.install.lock"
  else
    die "无法锁定安装目录：$PREFIX.install.lock" "等其他安装完成，或检查安装目录的写权限"
  fi
  local OLD_VERSION="" OLD_COMMIT="" OLD_RELEASE=""
  if [ -f "$PREFIX/app/package.json" ]; then
    HAD_APP=1
    OLD_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PREFIX/app/package.json" | head -1)"
    OLD_RELEASE="$(sed -n 's/.*"release": *"\([^"]*\)".*/\1/p' "$PREFIX/app/.versekit-build.json" 2>/dev/null | head -1 || true)"
    OLD_COMMIT="$(sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' "$PREFIX/app/.versekit-build.json" 2>/dev/null | head -1 || true)"
  fi
  if [ -f "$META" ]; then
    cp -p "$META" "$TMP/service.prev"
    OLD_PORT="$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$TMP/service.prev" | head -1)"
    OLD_SERVICE_LABEL="$(sed -n 's/.*"label": *"\([^"]*\)".*/\1/p' "$TMP/service.prev" | head -1)"
    OLD_MANAGER="$(sed -n 's/.*"manager": *"\([^"]*\)".*/\1/p' "$TMP/service.prev" | head -1)"
    if grep -q '"offline": *true' "$TMP/service.prev"; then OLD_OFFLINE=1; fi
    # R4 的自动更新器把已安装的标签传回安装脚本，识别并转换这个旧默认值。
    if [ "$OLD_SERVICE_LABEL" = com.versekit.daemon ] && [ "${HIFABU_SERVICE_LABEL:-}" = com.versekit.daemon ]; then
      export HIFABU_SERVICE_LABEL=com.hifabu.daemon
    elif [ -n "$OLD_SERVICE_LABEL" ] && [ "$OLD_SERVICE_LABEL" != com.versekit.daemon ] && [ -z "${HIFABU_SERVICE_LABEL+x}" ]; then
      export HIFABU_SERVICE_LABEL="$OLD_SERVICE_LABEL"
    fi
  fi
  WANT_PORT="${HIFABU_PORT:-${OLD_PORT:-8787}}"

  # 清单是发布脚本生成的 JSON，安装前还没有私有 Node，用系统 Perl 解析。
  manifest_fields() {
    printf '%s' "$HIFABU_RELEASE_MANIFEST" | perl -MJSON::PP -e '
      my ($platform, $test, @components) = @ARGV;
      my $m = decode_json(do { local $/; <STDIN> });
      die "清单格式错误\n" unless $m->{schema} eq "hifabu.release/1"
        && $m->{version} =~ /\A[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?\z/
        && $m->{commit} =~ /\A[0-9a-f]{40}\z/
        && $m->{node}{version} =~ /\Av[0-9]+\.[0-9]+\.[0-9]+\z/;
      print "$m->{version}\n$m->{commit}\n$m->{node}{version}\n";
      for my $file ($m->{app}, $m->{node}{files}{$platform},
        map { $m->{components}{$_}{files}{$platform} } @components) {
        die "清单缺少该平台的下载地址或 SHA-256\n" unless ref $file eq "HASH"
          && $file->{sha256} =~ /\A[0-9a-f]{64}\z/;
        my $url = $file->{url};
        die "清单中的下载地址必须使用 HTTPS\n" unless $url =~ m{\Ahttps://[^\s]+\z}
          || ($test eq "1" && $url =~ m{\A(?:http://127\.0\.0\.1:[0-9]+/|file:///)[^\s]+\z});
        print "$file->{url}\n$file->{sha256}\n";
      }
    ' "$PLATFORM" "${HIFABU_INSTALL_TEST:-}" "$@"
  }

  verified_download() {
    local url="$1" file="$2" want="$3" got
    fetch "$url" "$file"
    got="$(sha_of "$file")"
    [ "$got" = "$want" ] ||
      die "${url##*/} 的 SHA-256 校验不通过（锁定值 ${want}，实际 ${got}）" "重新下载该版本；持续失败请联系发布方"
  }

  local APP_URL APP_SHA APP_COMMIT RELEASE="" NODE_VERSION NODE_URL NODE_SHA
  local -a COMPONENTS=() COMPONENT_BINS=()
  local file url sum
  if [ "$LEGACY" = 1 ]; then
    STEP="检查旧更新程序"
    [ "$UPDATING" = 1 ] && [[ "${HIFABU_APP_URL:-}" = file:///* ]] &&
      [ "$HAD_APP" = 1 ] && [ -x "$PREFIX/node/bin/node" ] ||
      die "旧更新需要已有安装、私有 Node 与本地源码包" "请使用正式版安装命令"
    APP_URL="$HIFABU_APP_URL"
    APP_SHA="${HIFABU_APP_SHA256:-}"
    APP_COMMIT="${HIFABU_APP_COMMIT:-${HIFABU_SOURCE_COMMIT:-}}"
    say "旧更新程序提供了本地源码包，沿用现有 Node 和组件"
  else
    STEP="读取锁定清单"
    # 只升级已经装在该安装目录里的组件。
    for file in biliup lark-cli; do
      if [ -e "$PREFIX/bin/$file" ] || [ -L "$PREFIX/bin/$file" ]; then COMPONENTS+=("$file"); fi
    done
    if ! manifest_fields ${COMPONENTS[@]+"${COMPONENTS[@]}"} >"$TMP/fields"; then
      die "无法读取内嵌版本清单" "确认 Perl 与 JSON::PP 可用，并重新下载正式版安装脚本"
    fi
    {
      IFS= read -r RELEASE
      IFS= read -r APP_COMMIT
      IFS= read -r NODE_VERSION
      IFS= read -r APP_URL
      IFS= read -r APP_SHA
      IFS= read -r NODE_URL
      IFS= read -r NODE_SHA

      STEP="下载与校验 Node"
      say "下载 Node ${NODE_VERSION}……"
      verified_download "$NODE_URL" "$TMP/node.tar.gz" "$NODE_SHA"
      say "校验通过，解压 Node……"
      mkdir "$TMP/node-x"
      tar -xzf "$TMP/node.tar.gz" -C "$TMP/node-x" --strip-components=1 ||
        die "Node 解压失败" "检查磁盘空间并重新运行"
      [ "$("$TMP/node-x/bin/node" -v)" = "$NODE_VERSION" ] ||
        die "Node 包中 bin/node 版本不符或无法运行" "确认安装包与系统架构相符"

      for file in ${COMPONENTS[@]+"${COMPONENTS[@]}"}; do
        IFS= read -r url
        IFS= read -r sum
        STEP="下载与校验 $file"
        say "升级已安装的 ${file}……"
        verified_download "$url" "$TMP/$file.pkg" "$sum"
        mkdir "$TMP/$file-x"
        tar -xf "$TMP/$file.pkg" -C "$TMP/$file-x" ||
          die "$file 压缩包解压失败" "检查磁盘空间并重新运行"
        local binary
        binary="$(find "$TMP/$file-x" -type f -name "$file" -print -quit)"
        [ -n "$binary" ] || die "压缩包里没有 $file 可执行文件" "请联系发布方"
        COMPONENT_BINS+=("$binary")
        BIN_FILES+=("$file")
      done
    } <"$TMP/fields"
  fi

  STEP="下载与校验 Hifabu 程序"
  say "准备 Hifabu 程序……"
  if [ -n "$APP_SHA" ]; then verified_download "$APP_URL" "$TMP/app.tar.gz" "$APP_SHA"
  else fetch "$APP_URL" "$TMP/app.tar.gz"; fi
  STEP="解压 Hifabu 程序"
  say "解压 Hifabu 程序……"
  mkdir "$TMP/app-x"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/app-x" --strip-components=1 ||
    die "Hifabu 程序包解压失败" "检查磁盘空间并重新运行"
  [ -f "$TMP/app-x/packages/cli/src/vk.mjs" ] && [ -f "$TMP/app-x/package.json" ] ||
    die "程序包缺少 Hifabu CLI 或 package.json" "重新下载安装包"
  local NEW_VERSION STAGED_NODE="$TMP/node-x/bin/node"
  if [ "$LEGACY" = 1 ]; then STAGED_NODE="$PREFIX/node/bin/node"; fi
  NEW_VERSION="$("$STAGED_NODE" -e '
    const { version } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) process.exit(1);
    console.log(version);
  ' "$TMP/app-x/package.json")" || die "程序包版本无效" "重新下载安装包"
  if [ "$LEGACY" = 1 ]; then
    [ -n "$APP_COMMIT" ] || APP_COMMIT="$(sed -n "s/^APP_COMMIT_STAMP='\([0-9a-f]\{40\}\)'.*/\1/p" "$TMP/app-x/install.sh" 2>/dev/null | head -1 || true)"
    if ! [[ "$APP_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then APP_COMMIT=""; fi
  else
    [ "$NEW_VERSION" = "$RELEASE" ] ||
      die "程序包版本 $NEW_VERSION 与锁定清单版本 $RELEASE 不符" "请联系发布方"
    # P1 嵌入时移除了 JSON 文件末尾的换行，写回时补上原来的换行。
    printf '%s\n' "$HIFABU_RELEASE_MANIFEST" >"$TMP/app-x/release-manifest.json"
  fi
  printf '{\n  "commit": "%s",\n  "version": "%s",\n  "release": "%s",\n  "installed_at": "%s"\n}\n' \
    "$APP_COMMIT" "$NEW_VERSION" "$RELEASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$TMP/app-x/.versekit-build.json"

  # ------------------------------------------------------------ 换上新程序
  STEP="安装程序文件"
  # 下载和校验都过了才动已安装的东西：任何一步失败都不会破坏现有版本。
  local OLD_CLI file
  OLD_CLI="$(installed_cli)"
  mkdir -p "$PREFIX/bin"
  STAGE="$(mktemp -d "$PREFIX/.install.XXXXXX")"
  mkdir "$STAGE/bin.prev"
  mv "$TMP/app-x" "$STAGE/app"
  if [ "$LEGACY" = 0 ]; then mv "$TMP/node-x" "$STAGE/node"; fi
  for file in "${BIN_FILES[@]}"; do
    if [ -e "$PREFIX/bin/$file" ] || [ -L "$PREFIX/bin/$file" ]; then
      cp -pP "$PREFIX/bin/$file" "$STAGE/bin.prev/$file"
    fi
  done
  if [ -x "$OLD_CLI" ] && [ -d "$PREFIX/app" ] && [ -n "$OLD_PORT" ]; then
    SERVICE_STOPPED=1
    local STOP_OUT STOP_REASON
    if ! STOP_OUT="$(previous_cli "$OLD_CLI" service stop 2>"$TMP/service-stop.err")"; then
      STOP_REASON="$("$PREFIX/node/bin/node" -e '
        try { console.log(JSON.parse(process.argv[1]).error.message); } catch {}
      ' "$STOP_OUT")"
      die "不能停止旧服务：${STOP_REASON:-$(cat "$TMP/service-stop.err")}" "检查 hifabu service status 后重试"
    fi
    # 旧版 CLI 在服务停止失败时也可能退出 0，必须核对进程和端口状态。
    if ! "$PREFIX/node/bin/node" -e '
      const status = JSON.parse(process.argv[1]);
      process.exit(status.ok && !status.loaded && !status.running && !status.reachable ? 0 : 1);
    ' "$STOP_OUT"; then
      die "旧服务仍在运行或状态无法确认：$OLD_SERVICE_LABEL" "检查 hifabu service status 后重试"
    fi
  fi
  if [ "$LEGACY" = 0 ]; then
    if [ -d "$PREFIX/node" ]; then mv "$PREFIX/node" "$STAGE/node.prev"; fi
    NODE_REPLACED=1
    mv "$STAGE/node" "$PREFIX/node"
  fi
  local NODE="$PREFIX/node/bin/node"
  BIN_TOUCHED=1
  local index=0
  for file in ${COMPONENTS[@]+"${COMPONENTS[@]}"}; do
    cp "${COMPONENT_BINS[$index]}" "$PREFIX/bin/$file.new"
    chmod +x "$PREFIX/bin/$file.new"
    mv -f "$PREFIX/bin/$file.new" "$PREFIX/bin/$file"
    index=$((index + 1))
  done
  if [ -e "$PREFIX/app.prev" ]; then
    mv "$PREFIX/app.prev" "$STAGE/app.prev"
    PREV_BACKED_UP=1
  fi
  if [ -d "$PREFIX/app" ]; then
    mv "$PREFIX/app" "$PREFIX/app.prev"
    APP_BACKED_UP=1
  fi
  APP_REPLACED=1
  mv "$STAGE/app" "$PREFIX/app"
  local HIFABU="$PREFIX/bin/hifabu"
  cat >"$HIFABU.new" <<'EOF'
#!/bin/sh
if [ "${0##*/}" = vk ]; then printf '%s\n' 'vk 已改名为 hifabu' >&2; fi
bin="$(CDPATH= cd "$(dirname "$0")" && pwd -P)" || exit 1
PATH="$bin:$PATH"; export PATH
exec "$bin/../node/bin/node" --no-warnings "$bin/../app/packages/cli/src/vk.mjs" "$@"
EOF
  chmod +x "$HIFABU.new"
  mv -f "$HIFABU.new" "$HIFABU"
  ln -sfn hifabu "$PREFIX/bin/vk"
  export PATH="$PREFIX/bin:$PATH"

  # ------------------------------------------------------------ 4. init + 服务
  STEP="初始化（hifabu init）"
  say "初始化数据库（hifabu init）……"
  local INIT_OUT
  if ! INIT_OUT="$("$HIFABU" init --human 2>&1)"; then
    die "hifabu init 失败：$INIT_OUT" "运行 $HIFABU init --human 看具体报错"
  fi

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
    [ -n "$PORT" ] || die "端口 $WANT_PORT 被占用，附近也没有空闲端口" "用 HIFABU_PORT=<空闲端口> 重新运行"
    say "端口 $WANT_PORT 被别的程序占用，改用 $PORT"
  fi

  STEP="注册后台服务"
  "$NODE" --no-warnings --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const { describeInstall } = await import(pathToFileURL(process.argv[1]));
    console.log(describeInstall());
  ' "$PREFIX/app/packages/cli/src/service.mjs" ||
    die "无法预告服务注册信息" "请联系发布方"
  say "注册后台服务并启动（端口 ${PORT}）"
  local extra=(); [ "${HIFABU_OFFLINE-$OLD_OFFLINE}" = 1 ] && extra=(--offline)
  SERVICE_TOUCHED=1
  local SVC_OUT
  if ! SVC_OUT="$("$HIFABU" service install --port "$PORT" ${extra[@]+"${extra[@]}"} --human 2>&1)"; then
    local LOGF="${HIFABU_HOME:-$HOME}/.local/state/versekit/vk.log"
    printf '%s\n' "$SVC_OUT" >&2
    [ -f "$LOGF" ] && { printf '  日志最后几行（%s）：\n' "$LOGF" >&2; tail -n 8 "$LOGF" >&2 || true; }
    local CAUSE
    CAUSE="$(sed -n 's/^出错：//p' <<<"$SVC_OUT" | tail -1)"
    die "${CAUSE:-后台服务未能启动（端口 ${PORT}）}" "看上面的日志；修好后重新运行安装命令"
  fi
  SERVICE_INSTALLED=1
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
  if [ "${HIFABU_NO_OPEN:-}" != 1 ] && [ "$UPDATING" != 1 ]; then
    if [ "$OS" = darwin ]; then open "$URL" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
  fi

  # 后台更新要在「新版本起来后自检」通过之后才丢掉旧程序，所以那种情况留给更新程序清。
  [ "$UPDATING" = 1 ] || rm -rf "$PREFIX/app.prev"
  if [ "$HAD_APP" = 1 ] && [ "$LEGACY" = 0 ] && [ -z "$OLD_RELEASE" ]; then
    "$NODE" --no-warnings --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const { recordReleaseTransition } = await import(pathToFileURL(process.argv[1]));
      console.log(recordReleaseTransition());
    ' "$PREFIX/app/packages/cli/src/service.mjs" || printf '  记录正式版本切换失败，请查看日志目录权限。\n' >&2
  fi
  DONE=1
  local OLD_LABEL NEW_LABEL
  OLD_LABEL="$(version_label "$OLD_VERSION" "$OLD_COMMIT")"
  NEW_LABEL="${RELEASE:-$(version_label "$NEW_VERSION" "$APP_COMMIT")}"
  OLD_LABEL="${OLD_RELEASE:-$OLD_LABEL}"
  if [ "$HAD_APP" = 1 ] && [ -n "$APP_COMMIT" ] && [ "$OLD_COMMIT" = "$APP_COMMIT" ]; then
    say "已是最新（$(printf '%s' "$APP_COMMIT" | cut -c1-7)），重新装了一遍（数据、账号、登录都保留）"
  elif [ "$HAD_APP" = 1 ]; then say "已升级 ${OLD_LABEL} → ${NEW_LABEL}（数据、账号、登录都保留）"
  else say "已安装 ${NEW_LABEL}"; fi
  say "新开的终端里可以直接用 hifabu；日常管理：hifabu service status | restart | stop | uninstall"
  printf '装好了，控制台地址 %s，终端可以关了\n' "$URL"
}

main "$@"
