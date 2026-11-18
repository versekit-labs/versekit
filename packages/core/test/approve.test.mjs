// 发布前必须人确认（#146，ACC-v2-confirm-01…05）。
//
// 红线：平台稿不经人同意不会发出去。这里只用 stub 适配器和 fixture，不碰任何真实平台。
// 第一道防线：新建的平台稿停在 pending_confirm，不排 run；第二道防线：队列领到一条不在可发
// 状态的平台稿时，publish 处理器（白名单）不调用适配器，并留下 publish.not_runnable 事件。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "vk-approve-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { buildHandlers, RUNNABLE_PUBLISH_STATES } = await import("../src/adapters.mjs");
const { validateAdapter } = await import("../src/contract.mjs");
const { createRunner } = await import("../src/runner.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { COMMANDS, findCommand } = await import("../src/commands.mjs");
const { matchRoute } = await import("../src/routes.mjs");
const { startDaemon } = await import("../src/daemon.mjs");
const { signApproval, applyApproval } = await import("../src/approval.mjs");

const db = () => core.open();
const H = 3600e3;

// ---------------------------------------------------------------- stub 适配器：只计数，不碰网络

const calls = [];
function stub(platform) {
  return validateAdapter(
    {
      platform,
      capabilities: { publish: "web", collect: "web" },
      ready: () => null,
      async publish({ publishId }) {
        const row = store.getPublish(publishId);
        calls.push({ platform, publishId, overrides: row.overrides_json ? JSON.parse(row.overrides_json) : {} });
        return { id: `ext_${publishId}`, url: `https://stub.test/${publishId}`, visibility: "public", state: "published" };
      },
      async collect() {
        return {};
      },
    },
    `adapter-${platform}`,
  );
}

const PLATFORMS = ["tiktok", "bilibili", "xiaohongshu"];
const adapters = PLATFORMS.map(stub);
const runHandlers = buildHandlers(adapters, { log: () => {} });
const h = createCoreHandlers({ adapters: PLATFORMS.map((platform) => ({ platform })), log: () => {} });
const runner = () => createRunner({ handlers: runHandlers, log: () => {} });
const callsFor = (publishId) => calls.filter((c) => c.publishId === publishId).length;
const stateOf = (publishId) => store.getPublish(publishId).state;
const runsOf = (publishId) => db().prepare("SELECT * FROM run WHERE kind='publish' AND target_id=?").all(publishId);

let seq = 0;
/** 一个账号组 + 三个平台账号 + 一个作品一支成片，每个平台一条平台稿。 */
function fixture({ scheduledAt = Date.now() + 2 * H } = {}) {
  const groupId = store.addGroup({ name: `确认组 ${++seq}` }).id;
  const acc = Object.fromEntries(PLATFORMS.map((p) => [p, store.addAccount({ platform: p, handle: `@${p}${seq}`, groupId }).id]));
  const work = store.createWork({ title: `作品 ${seq}`, assetPath: "/tmp/a.mp4" });
  const pub = Object.fromEntries(PLATFORMS.map((p) => [p, store.createPublish({ workId: work.id, accountId: acc[p], scheduledAt })]));
  return { groupId, acc, work, cutId: pub.tiktok.cutId, pub: Object.fromEntries(PLATFORMS.map((p) => [p, pub[p].id])) };
}

before(() => {
  core.migrate();
});

// ---------------------------------------------------------------- ACC-v2-confirm-01（红线）

test("ACC-v2-confirm-01 红线：到点但未确认的平台稿，跑一轮队列也没有任何发布尝试", async () => {
  const f = fixture({ scheduledAt: Date.now() - H }); // 建议时间早就过了
  for (const p of PLATFORMS) {
    assert.equal(stateOf(f.pub[p]), "pending_confirm", `${p} 新建即待确认`);
    assert.equal(runsOf(f.pub[p]).length, 0, `${p} 未确认不排 run`);
  }
  const before = calls.length;
  await runner().tick();
  await runner().tick();
  assert.equal(calls.length, before, "没有任何适配器调用");
  for (const p of PLATFORMS) assert.equal(stateOf(f.pub[p]), "pending_confirm");

  // 人确认之后才发——证明上面不是因为队列坏了才没发。
  const res = h["publish.approve"]({ cutId: f.cutId });
  // 过期的建议时间在确认时按平台规则顺延到将来（ACC-v3-time-03），不会因为过期失败；
  // 这里把它们提前到「到点」，只验证确认之后队列确实会发。
  assert.ok(res.approved.every((a) => a.shifted && a.scheduledAt > Date.now()), "过期的建议时间顺延到将来");
  db().prepare("UPDATE run SET run_after = ? WHERE kind='publish'").run(Date.now() - 1);
  await runner().tick();
  assert.equal(callsFor(f.pub.tiktok), 1);
  assert.equal(callsFor(f.pub.bilibili), 1);
  assert.equal(stateOf(f.pub.tiktok), "published");
  assert.equal(callsFor(f.pub.xiaohongshu), 0, "小红书没被整支确认带上，仍然不发");
  assert.equal(stateOf(f.pub.xiaohongshu), "pending_confirm");
});

test("红线第二道防线：给待确认 / 先不发 / 已取消的平台稿手工排 run，处理器不调适配器并留事件", async () => {
  const f = fixture();
  h["publish.skip"]({ cutId: f.cutId }); // 三条都 skipped
  const g = fixture();
  core.transitionPublish(g.pub.bilibili, "canceled", { reason: "test" });
  const targets = [
    { publishId: g.pub.tiktok, state: "pending_confirm" },
    { publishId: f.pub.tiktok, state: "skipped" },
    { publishId: f.pub.xiaohongshu, state: "skipped" },
    { publishId: g.pub.bilibili, state: "canceled" },
  ];
  db().prepare("DELETE FROM run").run();
  for (const t of targets) core.enqueue({ kind: "publish", targetType: "publish", targetId: t.publishId, lane: t.publishId });

  const before = calls.length;
  await runner().tick();
  await runner().tick();
  assert.equal(calls.length, before, "stub 适配器的 publish 调用次数为 0");
  for (const t of targets) {
    assert.equal(stateOf(t.publishId), t.state, "状态不被推进");
    const [run] = runsOf(t.publishId);
    assert.equal(run.state, "done", "这个 run 结束，不留着反复领");
    const ev = db().prepare("SELECT severity, payload_json FROM event WHERE type='publish.not_runnable' AND publish_id=?").get(t.publishId);
    assert.ok(ev, `${t.state} 要留事件，不能静默返回`);
    const payload = JSON.parse(ev.payload_json);
    assert.equal(payload.error_code, "not_runnable");
    assert.equal(payload.state, t.state);
    assert.match(payload.message, /没有调用适配器/);
  }
  assert.deepEqual(RUNNABLE_PUBLISH_STATES, ["queued", "auto_running", "draft_running"], "白名单，不是黑名单");
});

test("重排 run 的旧路径不能把待确认推进队列：publish.retry、审批链接都拒绝", () => {
  const f = fixture();
  assert.throws(() => h["publish.retry"]({ publishId: f.pub.tiktok }), /不能重试/);
  const token = signApproval({ publishId: f.pub.tiktok });
  assert.throws(() => applyApproval(token, "retry"), /不能重试/);
  assert.equal(stateOf(f.pub.tiktok), "pending_confirm");
  assert.equal(runsOf(f.pub.tiktok).length, 0);
});

// ---------------------------------------------------------------- ACC-v2-confirm-02

test("ACC-v2-confirm-02：按成片确认，所有非小红书的待确认平台稿进队列；小红书不被带上", () => {
  const f = fixture();
  const res = h["publish.approve"]({ cutId: f.cutId });
  assert.deepEqual(res.approved.map((a) => a.platform).sort(), ["bilibili", "tiktok"]);
  assert.deepEqual(res.perItem.map((x) => x.platform), ["xiaohongshu"], "回执里列出要逐条决定的小红书");
  for (const p of ["tiktok", "bilibili"]) {
    assert.equal(stateOf(f.pub[p]), "queued");
    const [run] = runsOf(f.pub[p]);
    assert.equal(run.state, "queued");
    assert.equal(run.run_after, store.getPublish(f.pub[p]).scheduled_at, "按建议时间发");
  }
  assert.equal(stateOf(f.pub.xiaohongshu), "pending_confirm", "小红书不会被这次确认带上");
  assert.equal(runsOf(f.pub.xiaohongshu).length, 0);

  // 再按成片确认一次：只剩小红书，明确告诉人逐条决定，不假装确认成功。
  assert.throws(() => h["publish.approve"]({ cutId: f.cutId }), /逐条决定/);
  assert.equal(stateOf(f.pub.xiaohongshu), "pending_confirm");

  assert.throws(() => h["publish.approve"]({}), /二选一/);
  assert.throws(() => h["publish.approve"]({ cutId: f.cutId, publishId: f.pub.tiktok }), /二选一/);
  assert.throws(() => h["publish.approve"]({ cutId: "cut_nope" }), /没有这支成片/);
  assert.throws(() => h["publish.approve"]({ publishId: f.pub.tiktok }), /不在等确认/, "已确认的不能再确认");
});

test("ACC-v2-confirm-02：被移除账号的平台稿不会被确认进队列", () => {
  const f = fixture();
  store.removeAccount(f.acc.bilibili); // 待确认不算「在队列里」，可以移除
  assert.throws(() => h["publish.approve"]({ publishId: f.pub.bilibili }), /已从账号组移除/);
  const res = h["publish.approve"]({ cutId: f.cutId });
  assert.deepEqual(res.approved.map((a) => a.platform), ["tiktok"]);
  assert.deepEqual(res.removed.map((r) => r.platform), ["bilibili"], "不静默跳过");
  assert.equal(stateOf(f.pub.bilibili), "pending_confirm");
  assert.equal(runsOf(f.pub.bilibili).length, 0);
});

// ---------------------------------------------------------------- ACC-v2-confirm-03

test("ACC-v2-confirm-03：小红书「按建议时间发」——逐条确认，按建议时间排队", () => {
  const f = fixture();
  const at = store.getPublish(f.pub.xiaohongshu).scheduled_at;
  const res = h["publish.approve"]({ publishId: f.pub.xiaohongshu });
  assert.equal(res.approved[0].platform, "xiaohongshu");
  assert.equal(stateOf(f.pub.xiaohongshu), "queued");
  assert.equal(runsOf(f.pub.xiaohongshu)[0].run_after, at);
  assert.equal(stateOf(f.pub.tiktok), "pending_confirm", "逐条确认只动这一条");
});

test("ACC-v2-confirm-03：小红书「现在发」——确认并把时间改成现在，立刻可领", async () => {
  const f = fixture({ scheduledAt: Date.now() + 5 * H });
  const t0 = Date.now();
  const res = h["publish.now"]({ publishId: f.pub.xiaohongshu });
  assert.equal(res.state, "queued");
  const row = store.getPublish(f.pub.xiaohongshu);
  assert.ok(row.scheduled_at >= t0 && row.scheduled_at <= Date.now(), "建议时间改成现在");
  assert.equal(runsOf(f.pub.xiaohongshu)[0].run_after, null, "不等原来的建议时间");
  await runner().tick();
  assert.equal(callsFor(f.pub.xiaohongshu), 1);
  assert.equal(stateOf(f.pub.xiaohongshu), "published");
});

test("ACC-v2-confirm-03：小红书「我自己发」——不进队列，转等你在 App 里发完；publish.confirm 含义不变", async () => {
  const f = fixture();
  const res = h["publish.manual"]({ publishId: f.pub.xiaohongshu });
  assert.equal(res.state, "notify_pending");
  assert.match(res.next, /vk publish confirm/);
  assert.equal(store.getPublish(f.pub.xiaohongshu).fallback_reason, "self_publish");
  assert.equal(runsOf(f.pub.xiaohongshu).length, 0, "不排 run，机器不碰平台");
  await runner().tick();
  assert.equal(callsFor(f.pub.xiaohongshu), 0);

  // 现有 publish.confirm：确认已在 App 里发完 → published，并排采集。
  assert.equal(h["publish.confirm"]({ publishId: f.pub.xiaohongshu }).state, "published");
  assert.ok(db().prepare("SELECT 1 FROM run WHERE kind='collect' AND target_id=?").get(f.pub.xiaohongshu));
  // publish.confirm 不能当成「确认发布」用在待确认的平台稿上。
  assert.throws(() => h["publish.confirm"]({ publishId: f.pub.tiktok }), /不需要确认/);
  assert.equal(stateOf(f.pub.tiktok), "pending_confirm");
});

test("ACC-v2-confirm-03：这支先不发——整支跳过（含小红书）；跳过的以后还能再确认", async () => {
  const f = fixture({ scheduledAt: Date.now() - H });
  const res = h["publish.skip"]({ cutId: f.cutId });
  assert.deepEqual(res.skipped.map((x) => x.platform).sort(), ["bilibili", "tiktok", "xiaohongshu"]);
  for (const p of PLATFORMS) {
    assert.equal(stateOf(f.pub[p]), "skipped");
    assert.equal(runsOf(f.pub[p]).length, 0);
  }
  assert.equal(h["publish.skip"]({ cutId: f.cutId }).already, true, "重复点是幂等的");
  assert.equal(store.showWork(f.work.id).status.key, "skipped", "作品状态：先不发（不算等确认）");
  await runner().tick();
  assert.equal(PLATFORMS.reduce((n, p) => n + callsFor(f.pub[p]), 0), 0);

  // 以后再确认：整支确认带上非小红书，小红书仍逐条。
  const again = h["publish.approve"]({ cutId: f.cutId });
  assert.deepEqual(again.approved.map((a) => a.platform).sort(), ["bilibili", "tiktok"]);
  assert.deepEqual(again.perItem.map((x) => x.platform), ["xiaohongshu"]);
  assert.equal(stateOf(f.pub.xiaohongshu), "skipped");
  h["publish.manual"]({ publishId: f.pub.xiaohongshu });
  assert.equal(stateOf(f.pub.xiaohongshu), "notify_pending");
  assert.throws(() => h["publish.skip"]({ cutId: f.cutId }), /没有等确认的平台稿可以跳过/);
});

// ---------------------------------------------------------------- ACC-v2-confirm-04（前半）

test("ACC-v2-confirm-04：确认前改标题和时间，发布用改后的值；作品标题不变", async () => {
  const f = fixture({ scheduledAt: Date.now() + 2 * H });
  const at = Date.now() + 6 * H;
  const edited = h["publish.edit"]({ publishId: f.pub.tiktok, title: "改后的标题", at });
  assert.equal(edited.title, "改后的标题");
  assert.equal(edited.scheduledAt, at);
  assert.equal(edited.state, "pending_confirm", "改不等于确认");
  assert.equal(runsOf(f.pub.tiktok).length, 0);
  assert.equal(store.getWork(f.work.id).title, f.work.title, "不改作品标题，不波及其他平台");
  assert.ok(db().prepare("SELECT 1 FROM event WHERE type='publish.edited' AND publish_id=?").get(f.pub.tiktok), "改动留痕");

  // 只改标题时时间不动；只改时间时标题不丢。
  h["publish.edit"]({ publishId: f.pub.bilibili, title: "B站标题" });
  assert.equal(store.getPublish(f.pub.bilibili).scheduled_at, store.getPublish(f.pub.xiaohongshu).scheduled_at);
  h["publish.edit"]({ publishId: f.pub.bilibili, at });
  assert.equal(JSON.parse(store.getPublish(f.pub.bilibili).overrides_json).title, "B站标题");

  h["publish.approve"]({ cutId: f.cutId });
  assert.equal(runsOf(f.pub.tiktok)[0].run_after, at, "队列按改后的时间");
  // 把 run 提前到现在模拟「到点」，看适配器拿到的是改后的标题。
  db().prepare("UPDATE run SET run_after = NULL WHERE kind='publish' AND target_id IN (?, ?)").run(f.pub.tiktok, f.pub.bilibili);
  // 前面用例可能留下可领的 run（并发 2）：多跑几轮，直到这两条都发完。
  for (let i = 0; i < 6 && !(stateOf(f.pub.tiktok) === "published" && stateOf(f.pub.bilibili) === "published"); i++) await runner().tick();
  const seen = calls.filter((c) => c.publishId === f.pub.tiktok).at(-1);
  assert.equal(seen.overrides.title, "改后的标题", "发布用的是改后的标题");
  assert.equal(calls.filter((c) => c.publishId === f.pub.bilibili).at(-1).overrides.title, "B站标题");
});

test("ACC-v2-confirm-04：拦过去时间、空改动、已确认的平台稿", () => {
  const f = fixture();
  assert.throws(() => h["publish.edit"]({ publishId: f.pub.tiktok, at: Date.now() - 1000 }), /过去的时间/);
  assert.throws(() => h["publish.edit"]({ publishId: f.pub.tiktok }), /至少一个/);
  assert.throws(() => h["publish.edit"]({ publishId: f.pub.tiktok, title: "   " }), /标题 不能为空/);
  h["publish.approve"]({ publishId: f.pub.tiktok });
  assert.throws(() => h["publish.edit"]({ publishId: f.pub.tiktok, title: "晚了" }), /不在等确认/);
  // 先不发的还能改，改完再确认。
  h["publish.skip"]({ cutId: f.cutId });
  assert.equal(h["publish.edit"]({ publishId: f.pub.xiaohongshu, title: "跳过后再改" }).state, "skipped");
});

// ---------------------------------------------------------------- 状态机

test("状态机：待确认 / 先不发的合法与非法迁移", () => {
  const f = fixture();
  for (const to of ["auto_running", "draft_running", "published", "published_limited", "failed", "blocked", "draft_pending"]) {
    assert.throws(() => core.transitionPublish(f.pub.tiktok, to), /非法状态迁移/, `pending_confirm → ${to} 必须抛错`);
  }
  core.transitionPublish(f.pub.tiktok, "skipped");
  for (const to of ["auto_running", "draft_running", "published", "failed"]) {
    assert.throws(() => core.transitionPublish(f.pub.tiktok, to), /非法状态迁移/, `skipped → ${to} 必须抛错`);
  }
  core.transitionPublish(f.pub.tiktok, "pending_confirm");
  core.transitionPublish(f.pub.tiktok, "queued");
  assert.throws(() => core.transitionPublish(f.pub.tiktok, "pending_confirm"), /非法状态迁移/, "进了队列不会退回待确认");
  assert.throws(() => core.transitionPublish(f.pub.tiktok, "skipped"), /非法状态迁移/);
  for (const from of ["pending_confirm", "skipped"]) {
    assert.ok(core.PUBLISH_TRANSITIONS[from].includes("canceled"), `${from} 可以取消`);
  }
});

test("作品状态：待确认算「等确认」，先不发单独一档", () => {
  assert.equal(store.deriveStatus(["pending_confirm", "queued"]).key, "awaiting_confirm");
  assert.equal(store.deriveStatus(["skipped", "skipped"]).key, "skipped");
  assert.equal(store.deriveStatus(["skipped", "published"]).key, "skipped", "没发完就不说都发完了");
  assert.equal(store.deriveStatus(["skipped", "queued"]).key, "scheduled");
  assert.equal(store.deriveStatus(["skipped", "failed"]).key, "problem");
});

// ---------------------------------------------------------------- ACC-v2-confirm-05

test("ACC-v2-confirm-05：每个动作都是命令表里的命令，HTTP 路由由它派生；publish.confirm 含义不变", async () => {
  const names = ["publish.approve", "publish.now", "publish.manual", "publish.skip", "publish.edit"];
  for (const name of names) {
    const cmd = findCommand(name);
    assert.ok(cmd, `命令表缺 ${name}`);
    assert.equal(cmd.remote, true, `${name} 卡片按钮可以触发`);
    assert.ok(cmd.card && cmd.cli?.usage && cmd.http, `${name} 有卡片 / CLI / HTTP 三种投影`);
    assert.equal(cmd.audit, "always");
    assert.equal(typeof cmd.idempotent, "function");
    assert.equal(typeof h[name], "function", `${name} 有 handler`);
  }
  assert.equal(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length, "命令名不重复");
  assert.ok(!names.some((n) => n.startsWith("approval.")), "与签名审批链接 approval.* 不混用");

  const confirm = findCommand("publish.confirm");
  assert.match(confirm.summary, /App 内完成发布/);
  assert.deepEqual(confirm.http, { method: "POST", path: "/api/publishes/:publishId/confirm" });

  assert.deepEqual(matchRoute("POST", "/api/publishes/approve"), { command: "publish.approve", params: {} });
  assert.deepEqual(matchRoute("POST", "/api/publishes/p1/now"), { command: "publish.now", params: { publishId: "p1" } });
  assert.deepEqual(matchRoute("POST", "/api/publishes/p1/manual"), { command: "publish.manual", params: { publishId: "p1" } });
  assert.deepEqual(matchRoute("POST", "/api/publishes/p1/edit"), { command: "publish.edit", params: { publishId: "p1" } });
  assert.deepEqual(matchRoute("POST", "/api/cuts/c1/skip"), { command: "publish.skip", params: { cutId: "c1" } });

  // 真实 HTTP：改时间 → 按成片确认 → 小红书先不发，全部走命令表派生的路由。
  const f = fixture();
  const daemon = await startDaemon({ runQueue: false, port: 0, socketPath: join(HOME, "vk-approve.sock"), handlers: { ...runHandlers, ...h } });
  const post = (path, body = {}) =>
    fetch(`http://127.0.0.1:${daemon.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const at = Date.now() + 9 * H;
    const edited = await post(`/api/publishes/${f.pub.tiktok}/edit`, { title: "HTTP 改", at });
    assert.equal(edited.status, 200);
    assert.equal(store.getPublish(f.pub.tiktok).scheduled_at, at);
    const approved = await post("/api/publishes/approve", { cutId: f.cutId });
    assert.equal(approved.status, 200);
    assert.equal(stateOf(f.pub.tiktok), "queued");
    assert.equal(stateOf(f.pub.xiaohongshu), "pending_confirm");
    const manual = await post(`/api/publishes/${f.pub.xiaohongshu}/manual`);
    assert.equal(manual.status, 200);
    assert.equal(stateOf(f.pub.xiaohongshu), "notify_pending");
    const bad = await post(`/api/publishes/${f.pub.tiktok}/now`);
    assert.equal(bad.status, 400, "已确认的再点「现在发」给人话错误，不是 200");
  } finally {
    await daemon.close();
  }
});
