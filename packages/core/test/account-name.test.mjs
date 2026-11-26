// 账号名（#374）：名字是 VerseKit 里给自己看的名字，不影响平台。
//   · 规则只在 core 一处：去掉首尾空格后非空、≤40 字；可以等于组名，两个平台可以同名；
//   · account.rename 只改显示名：id / 平台 / handle / 登录状态 / 凭据 / 平台稿都不变，写一条事件；
//   · 网页所有「回车即提交」的输入框在输入法组字时（isComposing / keyCode 229）不提交。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-acc-name-"));
process.env.HIFABU_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { findCommand } = await import("../src/commands.mjs");
const { startDaemon } = await import("../src/daemon.mjs");
const driver = await import("../../driver-browser/src/index.mjs");

const h = createCoreHandlers();

before(() => core.migrate());
after(() => core.close());

test("名字 = 组名、两个平台同名都能加；空名与超长被拒并说人话", () => {
  const g = h["group.add"]({ name: "AssureLane" });
  const a = h["account.add"]({ platform: "tiktok", name: "AssureLane", group: g.id });
  const b = h["account.add"]({ platform: "bilibili", name: "AssureLane", group: g.id });
  assert.notEqual(a.id, b.id);
  assert.equal(a.existed, false);
  assert.equal(b.existed, false);

  assert.throws(() => h["account.add"]({ platform: "douyin", name: "   ", group: g.id }), /账号名不能为空/);
  assert.throws(() => h["account.add"]({ platform: "douyin", name: "", group: g.id }), /账号名不能为空/);
  assert.throws(() => h["account.add"]({ platform: "douyin", name: "长".repeat(41), group: g.id }), /最多 40 个字/);
  const ok = h["account.add"]({ platform: "douyin", name: `  ${"长".repeat(40)}  `, group: g.id });
  assert.equal(core.open().prepare("SELECT display_name FROM account WHERE id = ?").get(ok.id).display_name, "长".repeat(40), "首尾空格去掉后再算长度");
  assert.equal(core.open().prepare("SELECT COUNT(*) n FROM account WHERE group_id = ? AND removed_at IS NULL").get(g.id).n, 3, "被拒的没有留下半个账号");
});

test("account.rename：命令表定义一次（HTTP + CLI 派生），改名前后 id / 平台 / handle / 登录状态 / 凭据不变，写事件", () => {
  const cmd = findCommand("account.rename");
  assert.equal(cmd.http.path, "/api/accounts/:accountId/rename");
  assert.match(cmd.cli.usage, /hifabu account rename <账号 id> --name/);

  const g = h["group.add"]({ name: "改名组" });
  const { id } = h["account.add"]({ platform: "xiaohongshu", name: "旧名", group: g.id, credentialRef: "cred/xhs-1" });
  core.open().prepare("UPDATE account SET state = 'expired', last_ok_at = 123 WHERE id = ?").run(id);
  const row = () => core.open().prepare("SELECT * FROM account WHERE id = ?").get(id);
  const before_ = row();

  const r = h["account.rename"]({ accountId: id, name: "  新名字 " });
  assert.deepEqual({ changed: r.changed, name: r.name, previous: r.previous }, { changed: true, name: "新名字", previous: "旧名" });
  const after_ = row();
  assert.equal(after_.display_name, "新名字");
  assert.deepEqual({ ...after_, display_name: null }, { ...before_, display_name: null }, "除显示名外整行不变（id、平台、handle、状态、凭据、分组）");

  const ev = core.open().prepare("SELECT payload_json AS payload FROM event WHERE type = 'account.renamed' ORDER BY rowid DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(ev.payload), { accountId: id, from: "旧名", to: "新名字" });

  // 改成同名：不报错，不再写事件
  const n = core.open().prepare("SELECT COUNT(*) n FROM event WHERE type = 'account.renamed'").get().n;
  assert.equal(h["account.rename"]({ accountId: id, name: "新名字" }).changed, false);
  assert.equal(core.open().prepare("SELECT COUNT(*) n FROM event WHERE type = 'account.renamed'").get().n, n);

  // 名字规则同添加：可以等于组名、可以和同组别的平台同名；空名被拒
  const other = h["account.add"]({ platform: "bilibili", name: "别的号", group: g.id });
  assert.equal(h["account.rename"]({ accountId: other.id, name: "改名组" }).changed, true);
  assert.equal(h["account.rename"]({ accountId: other.id, name: "新名字" }).changed, true);
  assert.throws(() => h["account.rename"]({ accountId: id, name: "  " }), /账号名不能为空/);
  assert.equal(row().display_name, "新名字", "被拒的改名没有改动");
  assert.throws(() => h["account.rename"]({ accountId: "acc_nope", name: "x" }), /没有这个账号/);
  h["account.remove"]({ accountId: other.id });
  assert.throws(() => h["account.rename"]({ accountId: other.id, name: "x" }), /已经移除/);
});

test("账号名规则只在 core：网页不再另加「不许同组名 / 不许同名」，组字回车不提交（静态）", () => {
  const html = readFileSync(new URL("../../web/public/system.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /别把账号组名当账号名|两个平台同名会分不清/);
  assert.match(html, /data-accrename=/, "账号行有「改名」");
  assert.match(html, /e\.isComposing \|\| e\.keyCode === 229/, "回车提交前判输入法组字");
  // 判断必须在任何「回车即提交」分支之前。
  const kd = html.slice(html.indexOf('main.addEventListener("keydown"'));
  assert.ok(kd.indexOf("isComposing") < kd.indexOf('id === "add-name"'));
});

const missing = driver.browserReady();
const skipBrowser = missing ?? (process.env.CI === "true" ? "CI 不跑真浏览器用例（实例竞态）" : false);

test("系统页（真浏览器）：组字中的回车不提交；改名就地保存、不刷新页面", { skip: skipBrowser, timeout: 90e3 }, async () => {
  const g = store.addGroup({ name: "AssureLane" });
  store.useGroup(g.id);
  const keep = h["account.add"]({ platform: "bilibili", name: "AssureLane", group: g.id });
  store.recordHeartbeat();
  const adapters = ["xiaohongshu", "douyin", "bilibili"].map((platform) => ({ platform, adapter: { ready: () => null } }));
  const seen = [];
  const handlers = { ...createCoreHandlers({ adapters, log: () => {} }) };
  const orig = handlers["account.add"];
  handlers["account.add"] = (a) => { seen.push(a); return orig(a); };
  handlers["account.login.qr"] = async () => ({ mode: "qr", state: "waiting", qr: null });
  handlers["account.login.status"] = async () => ({ mode: "qr", state: "waiting", qr: null });
  const daemon = await startDaemon({ handlers, runQueue: false, port: 0, socketPath: join(HOME, "n.sock"), log: () => {} });
  let tab = null;
  try {
    tab = await driver.openAccount({ accountId: `acc-name-${process.pid}`, url: `http://127.0.0.1:${daemon.port}/system`, headless: process.env.CI === "true" });
    await tab.waitFor(`document.querySelector("#add-name")`, [], { timeout: 25e3, what: "添加账号表单" });
    await tab.eval(`window.__marker = "same-document"`);

    const press = (id, init) => tab.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: "Enter", bubbles: true, cancelable: true }, ${JSON.stringify(init)}))); return true; })()`);
    const typeInto = (id, v) => tab.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

    // 组字中的回车（isComposing、以及 keyCode 229 两种）：不提交。
    await tab.eval(`(() => { const s = document.getElementById("add-platform"); s.value = "douyin"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await typeInto("add-name", "AssureLane");
    await press("add-name", { isComposing: true });
    await press("add-name", { keyCode: 229 });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(seen.length, 0, "组字回车没有提交");

    // 同一个输入框，正常回车才提交；名字 = 组名也能加。
    await press("add-name", {});
    await tab.waitFor(`true`, [], { timeout: 100 });
    for (let i = 0; i < 40 && !seen.length; i++) await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 1, "正常回车提交了一次");
    assert.equal(seen[0].name, "AssureLane");

    // 改名：就地编辑；组字回车不保存，正常回车保存，页面没刷新。
    await tab.waitFor(`document.querySelector('tr[data-acc="${keep.id}"] [data-accrename]')`, [], { timeout: 15e3, what: "改名按钮" });
    await tab.eval(`document.querySelector('tr[data-acc="${keep.id}"] [data-accrename]').click()`);
    await tab.waitFor(`document.getElementById("acc-rename-input")`, [], { timeout: 5e3, what: "改名输入框" });
    await typeInto("acc-rename-input", "主号");
    await press("acc-rename-input", { isComposing: true });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(core.open().prepare("SELECT display_name FROM account WHERE id = ?").get(keep.id).display_name, "AssureLane", "组字回车没有保存改名");
    await press("acc-rename-input", {});
    await tab.waitFor(`/主号/.test(document.querySelector('tr[data-acc="${keep.id}"]')?.innerText ?? "")`, [], { timeout: 15e3, what: "新名字显示" });
    assert.equal(await tab.eval(`window.__marker`), "same-document", "没有刷新页面");
    assert.equal(core.open().prepare("SELECT display_name FROM account WHERE id = ?").get(keep.id).display_name, "主号");
  } finally {
    await tab?.close?.().catch(() => {});
    await daemon.close();
  }
});

test("改名后今天页、排期、作品页、飞书卡片都用新名字（accountName），handle 不变", async () => {
  const { buildToday } = await import("../src/overview.mjs");
  const { listSchedule } = await import("../src/schedule.mjs");
  const { getPublishRow } = await import("../src/publish-flow.mjs");
  const { buildEventCard } = await import("../src/cards.mjs");
  const g = h["group.add"]({ name: "展示组" });
  const { id } = h["account.add"]({ platform: "tiktok", name: "旧展示名", group: g.id, handle: "@demo_show" });
  const db = core.open();
  const now = Date.now();
  const w = store.createWork({ title: "展示作品", assetPath: "/tmp/x.mp4" });
  db.prepare("INSERT INTO publish (id, work_id, account_id, state, scheduled_at, created_at, updated_at) VALUES ('pub_show', ?, ?, 'queued', ?, ?, ?)").run(w.id ?? w, id, now + 3600e3, now, now);

  h["account.rename"]({ accountId: id, name: "TikTok主号" });

  const today = JSON.stringify(buildToday({ groupId: g.id }));
  assert.match(today, /TikTok主号/);
  const sched = listSchedule({ group: g.id, from: now, to: now + 7 * 864e5, now });
  const hit = JSON.stringify(sched);
  assert.match(hit, /"accountName":"TikTok主号"/);
  assert.match(hit, /"handle":"@demo_show"/, "handle 不变");
  const row = getPublishRow("pub_show");
  assert.equal(row.account_name, "TikTok主号");
  const card = JSON.stringify(buildEventCard({ type: "publish.failed", severity: "error", payload: {} }, { publish: row, now }) ?? "");
  assert.match(card, /TikTok主号/);
  assert.doesNotMatch(card, /@demo_show/);
});
