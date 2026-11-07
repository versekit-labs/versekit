// 手机审批页是真正给“没有飞书”的人用的入口：GET 能看，POST 能拍板，局域网外进不来。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-approval-page-"));
const core = await import("../src/index.mjs");
mkdirSync(dirname(core.paths().configFile), { recursive: true });
const approval = await import("../src/approval.mjs");
const { startDaemon } = await import("../src/daemon.mjs");
const { buildEventCard } = await import("../src/cards.mjs");

const PORT = 18100 + (process.pid % 500);
let daemon;
let publishId;

before(async () => {
  core.migrate();
  core.open().prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES ('w1','一条测试','/tmp/a.mp4',?)").run(Date.now());
  core.open().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a1','bilibili','@demo',?)").run(Date.now());
  core.open()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at, error_message) VALUES ('p1','w1','a1','notify_pending',?,?,?)")
    .run(Date.now(), Date.now(), "平台拒绝：封面不合规");
  publishId = "p1";
  daemon = await startDaemon({ handlers: {}, log: () => {}, port: PORT, host: "127.0.0.1", runQueue: false, channels: [] });
});

after(async () => {
  await daemon?.close?.();
});

test("GET /a/:token 显示拍板页，POST 后重试进入队列", async () => {
  const token = approval.signApproval({ publishId });
  const page = await fetch(`http://127.0.0.1:${PORT}/a/${token}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /需要你拍板/);
  assert.match(html, /重试发布/);
  assert.match(html, /封面不合规/);

  const res = await fetch(`http://127.0.0.1:${PORT}/a/${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision: "retry" }).toString(),
  });
  assert.equal(res.status, 200);
  const done = await res.text();
  assert.match(done, /已处理/);
  assert.equal(core.open().prepare("SELECT state FROM publish WHERE id=?").get(publishId).state, "queued");
});

test("坏签名 / 过期链接不给拍板", async () => {
  const expired = approval.signApproval({ publishId, exp: Date.now() - 1000 });
  const res = await fetch(`http://127.0.0.1:${PORT}/a/${expired}`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /过期/);
});

test("飞书卡片带「手机打开」链接", () => {
  const card = buildEventCard(
    { id: "e1", type: "publish.failed", severity: "critical", payload: { code: "platform_reject" } },
    { publish: { id: "p1", platform: "bilibili", handle: "@demo", title: "一条测试" }, now: Date.now(), approvalUrl: "https://example.test/a/t" },
  );
  const actions = card.elements.find((e) => e.tag === "action").actions;
  assert.ok(actions.some((a) => a.url === "https://example.test/a/t"), "卡片里应该有手机打开按钮");
});
