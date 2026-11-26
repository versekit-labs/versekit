// 后台自动更新（#217）的内核部分：程序知道自己是哪个提交、检查有没有新版本、只在空闲时更新、开关与状态。
// 只用临时 HIFABU_HOME 与本机假 GitHub；不联网、不碰真实服务。
// 真的下载 + 跑 install.sh + 自检 + 退回在 packages/cli/test/update.test.mjs。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-update-"));
process.env.HIFABU_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const updates = await import("../src/update.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { findCommand } = await import("../src/commands.mjs");

const A = "a".repeat(40);
const B = "b".repeat(40);
const seen = [];
let server;
let latest = B;
let behindTitles = ["修一处", "再修一处"];
let down = false;

before(async () => {
  core.migrate();
  server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (down) { res.statusCode = 503; return res.end("{}"); }
    res.setHeader("content-type", "application/json");
    if (req.url === "/commits/main") return res.end(JSON.stringify({ sha: latest }));
    if (req.url.startsWith("/compare/")) {
      const [from, to] = req.url.slice("/compare/".length).split("...");
      if (from === to) return res.end(JSON.stringify({ status: "identical", ahead_by: 0, commits: [] }));
      // GitHub 的 compare 是旧的在前
      return res.end(JSON.stringify({ status: "ahead", ahead_by: behindTitles.length, commits: behindTitles.slice().reverse().map((t) => ({ commit: { message: `${t}\n\n正文` } })) }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.HIFABU_UPDATE_API = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  server?.closeAllConnections?.();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const cur = (commit) => ({ version: "0.1.0", commit, short: updates.shortCommit(commit) });
const setState = (id, state) => core.open().prepare("UPDATE publish SET state=? WHERE id=?").run(state, id);
function pub(state, scheduledAt = null) {
  const g = store.addGroup({ name: `组 ${Math.random()}` });
  const a = store.addAccount({ platform: "bilibili", handle: `@u${Math.random()}`, groupId: g.id });
  const w = store.createWork({ title: "作品", assetPath: "/tmp/a.mp4" });
  const p = store.createPublish({ workId: w.id, accountId: a.id, scheduledAt });
  setState(p.id, state);
  return p.id;
}
const clearPublishes = () => core.open().exec("DELETE FROM publish");

// ── ACC-update-01：程序知道自己是哪个提交 ──────────────────────────────────

test("ACC-update-01 装好的程序读 .versekit-build.json：版本 + 提交 + 安装时间；没有就是「提交号未知」", () => {
  const root = mkdtempSync(join(tmpdir(), "vk-build-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  let b = updates.buildInfo({ root: `${root}/` });
  assert.deepEqual([b.version, b.commit, b.short], ["1.2.3", null, null]);
  assert.equal(updates.displayVersion(b), "1.2.3+未知提交");
  assert.match(updates.versionLine(b), /^1\.2\.3\+未知提交/);

  writeFileSync(join(root, ".versekit-build.json"), JSON.stringify({ commit: A, installed_at: "2026-11-17T01:02:03Z" }));
  b = updates.buildInfo({ root: `${root}/` });
  assert.deepEqual([b.version, b.commit, b.short, b.installedAt, b.fromInstall], ["1.2.3", A, "aaaaaaa", "2026-11-17T01:02:03Z", true]);
  assert.equal(updates.versionLine(b), "1.2.3+aaaaaaa · 安装于 2026-11-17T01:02:03Z");

  // 不同提交 → 不同的版本号（package.json 版本不变）
  writeFileSync(join(root, ".versekit-build.json"), JSON.stringify({ commit: "b".repeat(40) }));
  assert.notEqual(updates.displayVersion(updates.buildInfo({ root: `${root}/` })), "1.2.3+aaaaaaa");
  assert.equal(updates.displayVersion(updates.buildInfo({ root: `${root}/` })), "1.2.3+bbbbbbb");

  // 没被 export-subst 替换的占位符 / 乱写的提交号不算数
  writeFileSync(join(root, ".versekit-build.json"), JSON.stringify({ commit: "$Format:%H$" }));
  assert.equal(updates.buildInfo({ root: `${root}/` }).commit, null);
  rmSync(root, { recursive: true, force: true });
});

test("ACC-update-01 .gitattributes 让 install.sh 带上提交号（export-subst）", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("../../../", import.meta.url);
  assert.match(readFileSync(new URL(".gitattributes", root), "utf8"), /^install\.sh export-subst$/m);
  assert.match(readFileSync(new URL("install.sh", root), "utf8"), /^APP_COMMIT_STAMP='\$Format:%H\$'$/m);
});

test("ACC-update-01/05 update.status 是命令表里的只读命令，带版本与自动更新状态", () => {
  const c = findCommand("update.status");
  assert.equal(c.http.method, "GET");
  const v = createCoreHandlers({})["update.status"]();
  for (const k of ["version", "commit", "short", "installedAt", "auto", "intervalHours", "lastCheckAt", "lastUpdate", "lastFailure"]) assert.ok(k in v, `缺 ${k}`);
  assert.equal(v.auto, true, "默认开");
  assert.equal(v.intervalHours, 6, "默认 6 小时");
});

// ── ACC-update-02：--check 说人话 ─────────────────────────────────────────

test("ACC-update-02 检查：已是最新 / 有新版本：N 个提交（带最多 5 条标题，新的在前）；请求不带任何个人信息", async () => {
  seen.length = 0;
  latest = A;
  assert.equal((await updates.checkLatest({ current: cur(A) })).message, "已是最新");

  latest = B;
  behindTitles = ["一", "二", "三", "四", "五", "六", "七"]; // 新的在前
  const r = await updates.checkLatest({ current: cur(A) });
  assert.equal(r.message, "有新版本：7 个提交");
  assert.equal(r.behind, 7);
  assert.deepEqual(r.commits, ["一", "二", "三", "四", "五"]);

  for (const s of seen) {
    assert.equal(s.headers.authorization, undefined, "不带 token");
    assert.equal(s.headers.cookie, undefined);
    assert.equal(s.headers["user-agent"], "versekit-updater", "固定的通用 UA，不含主机名/用户名");
  }
  const flat = JSON.stringify(seen);
  assert.ok(!flat.includes(HOME) && !flat.includes(process.env.USER ?? "\u0000"));
});

test("ACC-update-02 本机提交号未知：照样能说有新版本，只是数不出差几个", async () => {
  latest = B;
  const r = await updates.checkLatest({ current: cur(null) });
  assert.match(r.message, /^有新版本/);
  assert.equal(r.behind, null);
});

test("ACC-update-02 handler：update --check 走同一份检查；联网失败说人话", async () => {
  const h = createCoreHandlers({});
  latest = B; down = false;
  const r = await h.update({ check: true });
  assert.ok(r.latest === B && r.message.startsWith("有新版本"));
  assert.ok(updates.readState().last_check_at, "记下上次检查时间");
  down = true;
  await assert.rejects(() => h.update({ check: true }), /没能查到最新版本.*网络/);
  down = false;
});

// ── ACC-update-03：空闲才更新 ─────────────────────────────────────────────

test("ACC-update-03 空闲判断：正在发布 / 登录窗口开着 / 15 分钟内有要发的 → 不空闲；一小时后才发的不挡", () => {
  clearPublishes();
  const now = Date.now();
  assert.equal(updates.idleState({ now }).idle, true);

  pub("queued", now + 60 * 60e3);
  assert.equal(updates.idleState({ now }).idle, true, "一小时后才发：空闲");

  const soon = pub("queued", now + 10 * 60e3);
  let s = updates.idleState({ now });
  assert.equal(s.idle, false);
  assert.match(s.reason, /接下来 15 分钟内有 1 条要发/);
  setState(soon, "canceled");

  const run = pub("auto_running");
  s = updates.idleState({ now });
  assert.equal(s.idle, false);
  assert.match(s.reason, /正在发布/);
  setState(run, "published");
  assert.equal(updates.idleState({ now }).idle, true);

  s = updates.idleState({ now, loginsOpen: 2 });
  assert.equal(s.idle, false);
  assert.match(s.reason, /2 个登录窗口/);

  // 待确认的不挡：没确认的到时间也不会发
  pub("pending_confirm", now);
  assert.equal(updates.idleState({ now }).idle, true);
  clearPublishes();
});

test("ACC-update-03 定时检查：不空闲就推迟不打断；空闲才更新；网络失败只记日志；关掉就不查；失败过的提交不重试", async () => {
  clearPublishes();
  const logs = [];
  const applied = [];
  const run = async ({ busy, waitForApply = false } = {}) => {
    // tick 要等本机 HTTP 和写库。等这一轮的日志或 apply 回调，再停止调度器。
    const { promise, resolve, reject } = Promise.withResolvers();
    const deadline = setTimeout(() => reject(new Error("等待自动更新检查结果超时")), 20_000);
    const stop = updates.startAutoUpdate({
      busy,
      startDelayMs: 5,
      log: (message) => {
        logs.push(message);
        if (!waitForApply) resolve();
      },
      apply: async (args) => {
        applied.push(args);
        resolve();
      },
    });
    try {
      await promise;
    } finally {
      clearTimeout(deadline);
      stop();
    }
  };
  latest = B; down = false;
  core.open().prepare("DELETE FROM meta WHERE key='update.state'").run();
  // buildInfo 在测试里读的是仓库根：没有 .versekit-build.json、提交号未知，不影响（只要不是最新）

  // 1) 不空闲：登录窗口开着
  await run({ busy: () => 1 });
  assert.equal(applied.length, 0, "不空闲不更新");
  assert.ok(logs.some((l) => /不空闲.*登录窗口.*推迟到下一次检查/.test(l)), logs.join("\n"));
  assert.ok(updates.readState().last_check_at, "照样记下检查时间");

  // 2) 空闲：更新，目标是最新提交
  await run({ waitForApply: true });
  assert.deepEqual(applied, [{ latest: B }]);

  // 3) 网络失败：只记日志，不更新、不抛
  applied.length = 0; logs.length = 0; down = true;
  await run();
  assert.equal(applied.length, 0);
  assert.ok(logs.some((l) => /检查更新没成功.*下一轮再试/.test(l)));
  down = false;

  // 4) 这个提交上次自动更新失败过：不再自动重试
  updates.patchState({ last_failure: { at: Date.now(), to: B, message: "x" } });
  await run();
  assert.equal(applied.length, 0);
  assert.ok(logs.some((l) => /不再自动重试/.test(l)));
  updates.patchState({ last_failure: null });

  // 5) 自动更新关掉：连检查都不做
  seen.length = 0;
  createCoreHandlers({}).update({ auto: "off" });
  await run();
  assert.equal(applied.length, 0);
  assert.equal(seen.length, 0, "关了就不联网");
  createCoreHandlers({}).update({ auto: "on" });
});

test("ACC-update-03 interval_hours 可改，非法值退回 6", async () => {
  const { updateConfig } = await import("../src/config.mjs");
  updateConfig({ update: { interval_hours: 2 } });
  assert.equal(updates.autoConfig().intervalHours, 2);
  for (const bad of [0, -1, "abc", null]) {
    updateConfig({ update: { interval_hours: bad } });
    assert.equal(updates.autoConfig().intervalHours, 6, `interval_hours=${bad}`);
  }
});

// ── ACC-update-05：开关与手动更新的红线 ───────────────────────────────────

test("ACC-update-05 开关：update --auto off|on 落到 config.json 的 update.auto，status 立刻反映；乱写会被拒", async () => {
  const h = createCoreHandlers({});
  const off = await h.update({ auto: "off" });
  assert.equal(off.auto, false);
  assert.equal(h["update.status"]().auto, false);
  assert.equal(JSON.parse(readFileSync(core.paths().configFile, "utf8")).update.auto, false);
  assert.equal((await h.update({ auto: "on" })).auto, true);
  assert.equal(h["update.status"]().auto, true);
  await assert.rejects(async () => h.update({ auto: "maybe" }), /开或关/);
});

test("ACC-update-05 状态里有上次更新（最多 5 条标题）与上次失败，系统页读的就是这份", async () => {
  updates.patchState({
    last_update: { at: Date.now(), version: "0.1.0", commits: ["一", "二"] },
    last_failure: { at: Date.now(), message: "自动更新失败，已回到 0.1.0：x" },
  });
  const v = createCoreHandlers({})["update.status"]();
  assert.deepEqual(v.lastUpdate.commits, ["一", "二"]);
  assert.match(v.lastFailure.message, /^自动更新失败，已回到/);
  // update.failed 是登记过的事件类型（ACC-update-04 留事件用）
  core.emit({ type: "update.failed", severity: "warn", payload: { message: "x" } });
});

test("红线：手动更新也不打断正在发的发布和登录；--now 才强制；没有 updater 的进程不能自己更新", async () => {
  clearPublishes();
  pub("auto_running");
  const calls = [];
  const h = createCoreHandlers({ updater: { apply: async (a) => (calls.push(a), { started: true }) } });
  await assert.rejects(() => h.update({}), /现在不适合更新：有 1 条正在发布/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await h.update({ now: true }), { started: true });
  clearPublishes();

  const withLogin = createCoreHandlers({ updater: { apply: async () => ({ started: true }) }, loginsOpen: () => 1 });
  await assert.rejects(() => withLogin.update({}), /登录窗口/);
  assert.deepEqual(await h.update({}), { started: true }, "空闲时直接更新");
  await assert.rejects(() => createCoreHandlers({}).update({}), /不能自己更新/);
});
