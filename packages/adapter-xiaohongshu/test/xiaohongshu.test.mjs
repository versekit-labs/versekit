// 小红书适配器：能力声明与「图片不当视频硬传」的本地兜底（issue #74 / ACC-publish-04）。
//
// 不启动浏览器：图片在打开账号浏览器之前就被拒绝；视频的 dry-run 也在对外动作之前返回。
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-xhs-"));

const core = await import("../../core/src/index.mjs");
const { AdapterError } = await import("../../core/src/errors.mjs");
const adapter = (await import("../src/index.mjs")).default;

const db = () => core.open();
let seq = 0;

function fixture(asset) {
  const k = ++seq;
  const now = Date.now();
  db().prepare("INSERT INTO work (id,title,asset_path,meta_json,created_at) VALUES (?,?,?,?,?)").run(
    `w${k}`,
    "小红书测试",
    asset,
    JSON.stringify({ title: "测试标题", body: "测试正文" }),
    now,
  );
  db().prepare("INSERT INTO account (id,platform,handle,state,created_at) VALUES (?,?,?, 'ok', ?)").run(`a${k}`, "xiaohongshu", `@x${k}`, now);
  db()
    .prepare("INSERT INTO publish (id,work_id,account_id,mode,visibility,state,created_at,updated_at) VALUES (?,?,?, 'auto','public','auto_running',?,?)")
    .run(`p${k}`, `w${k}`, `a${k}`, now, now);
  return `p${k}`;
}

before(() => core.migrate());
beforeEach(() => {
  db().exec("DELETE FROM publish; DELETE FROM work; DELETE FROM account;");
});

test("能力声明：小红书当前只支持视频", () => {
  assert.deepEqual(adapter.capabilities.assetTypes, ["video"], "声明出来，发布台才能在创建前拦住图片");
});

test("图片素材在打开浏览器之前被拒绝，并说清平台只能发视频", async () => {
  const png = join(process.env.VK_HOME, "01_pier_landing.png");
  writeFileSync(png, "fake image");
  const publishId = fixture(png);

  await assert.rejects(
    () => adapter.publish({ publishId, dryRun: true }),
    (err) => err instanceof AdapterError && err.code === "asset_invalid" && /只能发视频/.test(err.message) && /01_pier_landing\.png/.test(err.message),
  );
});

test("视频 dry-run 照常返回，不改状态、不打开浏览器", async () => {
  const mp4 = join(process.env.VK_HOME, "clip.mp4");
  writeFileSync(mp4, "fake video");
  const publishId = fixture(mp4);

  const result = await adapter.publish({ publishId, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.target.asset, mp4);
  assert.equal(db().prepare("SELECT state FROM publish WHERE id=?").get(publishId).state, "auto_running");
});