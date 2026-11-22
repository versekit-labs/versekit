// ACC-update-07：发布机换了版本后，已打开的页面跟着换新。
// shell.js 是浏览器脚本：这里用最小的假 window/document 载入它，只测检测与提示的逻辑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

function loadShell(fields = []) {
  const window = {};
  const document = {
    readyState: "loading",
    body: { dataset: {}, prepend() {} },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => fields,
    createElement: () => ({ content: { firstElementChild: null } }),
  };
  const ctx = vm.createContext({ window, document, location: { reload() {} }, EventSource: undefined, console });
  vm.runInContext(readFileSync(new URL("../../web/public/shell.js", import.meta.url), "utf8"), ctx);
  return { shell: window.VKShell, document };
}

const field = (props) => ({ tagName: "INPUT", type: "text", value: "", defaultValue: "", closest: () => null, ...props });

test("提交号变了、没有编辑中的内容：自动刷新一次，不出提示", () => {
  const { shell } = loadShell();
  const calls = { reload: 0, banner: [] };
  const watch = shell.makeBuildWatcher({ reload: () => calls.reload++, banner: (v) => calls.banner.push(v), dirty: () => false });
  watch({ commit: "a".repeat(40), version: "0.1.0+aaaaaaa" }); // 载入时的基线
  watch({ commit: "a".repeat(40), version: "0.1.0+aaaaaaa" });
  assert.equal(calls.reload, 0, "提交号没变不刷新");
  watch({ commit: "b".repeat(40), version: "0.1.0+bbbbbbb" });
  watch({ commit: "b".repeat(40), version: "0.1.0+bbbbbbb" });
  assert.equal(calls.reload, 1, "只刷新一次");
  assert.deepEqual(calls.banner, []);
});

test("提交号变了、有未保存的输入：只出提示，不刷新，输入还在", () => {
  const typed = field({ value: "写到一半的标题", defaultValue: "" });
  const { shell } = loadShell([typed]);
  assert.equal(shell.hasUnsavedInput(), true);
  const calls = { reload: 0, banner: [] };
  const watch = shell.makeBuildWatcher({ reload: () => calls.reload++, banner: (v) => calls.banner.push(v) });
  watch({ commit: "a".repeat(40), version: "0.1.0+aaaaaaa" });
  watch({ commit: "b".repeat(40), version: "0.1.0+bbbbbbb" });
  assert.equal(calls.reload, 0);
  assert.equal(calls.banner[0], "0.1.0+bbbbbbb");
  assert.equal(typed.value, "写到一半的标题", "输入不丢");
});

test("没改过的输入框不算编辑中；缺提交号的帧忽略", () => {
  const { shell } = loadShell([field({ value: "原值", defaultValue: "原值" }), field({ type: "hidden", value: "x" })]);
  assert.equal(shell.hasUnsavedInput(), false);
  const calls = { reload: 0 };
  const watch = shell.makeBuildWatcher({ reload: () => calls.reload++, banner() {}, dirty: () => false });
  watch(undefined);
  watch({ commit: null });
  watch({ commit: "a".repeat(40) });
  assert.equal(calls.reload, 0);
});

test("/api/stream 的帧带当前提交号（来自 buildInfo）", async () => {
  process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-live-"));
  const core = await import("../src/index.mjs");
  core.migrate();
  const { startDaemon } = await import("../src/daemon.mjs");
  const { buildInfo, displayVersion } = await import("../src/update.mjs");
  const daemon = await startDaemon({ runQueue: false, port: 0, socketPath: join(process.env.VK_HOME, "vk.sock"), handlers: {} });
  try {
    const frame = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: daemon.port, path: "/api/stream" }, (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          const m = buf.match(/data: (.*)\n\n/);
          if (m) {
            req.destroy();
            resolve(JSON.parse(m[1]));
          }
        });
      });
      req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
      req.end();
    });
    assert.equal(frame.build.commit, buildInfo().commit);
    assert.equal(frame.build.version, displayVersion());
  } finally {
    await daemon.close?.();
  }
});
