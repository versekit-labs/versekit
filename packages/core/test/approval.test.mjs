// 审批链接是「没有飞书也能拍板」的兜底：签名、时效、幂等三件事必须钉死。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-approval-"));
const core = await import("../src/index.mjs");
mkdirSync(dirname(core.paths().configFile), { recursive: true });
const approval = await import("../src/approval.mjs");

before(() => core.migrate());

let n = 0;
function seed(state = "notify_pending") {
  const k = ++n;
  core.open().prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES (?,?,?,?)").run(`w${k}`, `标题${k}`, "/tmp/a.mp4", Date.now());
  core.open().prepare("INSERT INTO account (id, platform, handle, created_at) VALUES (?,?,?,?)").run(`a${k}`, "bilibili", `@h${k}`, Date.now());
  core.open()
    .prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at, error_message) VALUES (?,?,?,?,?,?,?)")
    .run(`p${k}`, `w${k}`, `a${k}`, state, Date.now(), Date.now(), "平台说不行");
  return `p${k}`;
}

test("链接签名可验证，改一个字符就失效", () => {
  const token = approval.signApproval({ publishId: "px" });
  assert.equal(approval.verifyApproval(token).p, "px");
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.throws(() => approval.verifyApproval(tampered), /签名/);
});

test("过期的链接会被拒绝", () => {
  const token = approval.signApproval({ publishId: "px", exp: Date.now() - 1000 });
  assert.throws(() => approval.verifyApproval(token), /过期/);
});

test("批准重试：notify_pending → queued，并真的排进队列；重复点击只执行一次", () => {
  const id = seed("notify_pending");
  const token = approval.signApproval({ publishId: id });
  const first = approval.applyApproval(token, "retry", { actor: "test" });
  assert.equal(first.state, "queued");
  const run = core.open().prepare("SELECT * FROM run WHERE target_id=? AND kind='publish'").get(id);
  assert.ok(run, "应该排进 publish 队列");

  const second = approval.applyApproval(token, "retry", { actor: "test" });
  assert.equal(second.duplicate, true);
  assert.equal(core.open().prepare("SELECT COUNT(*) n FROM run WHERE target_id=? AND kind='publish'").get(id).n, 1);
});

test("取消：notify_pending → canceled；已发布的不能取消", () => {
  const id = seed("notify_pending");
  const token = approval.signApproval({ publishId: id });
  const res = approval.applyApproval(token, "cancel", { actor: "test" });
  assert.equal(res.state, "canceled");
  assert.equal(core.open().prepare("SELECT state FROM publish WHERE id=?").get(id).state, "canceled");

  const doneId = seed("published");
  assert.throws(() => approval.applyApproval(approval.signApproval({ publishId: doneId }), "cancel", { actor: "test" }), /已经发布/);
});
