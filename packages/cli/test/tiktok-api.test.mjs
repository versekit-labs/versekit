// vk 命令行走通 TikTok 官方接口（#143）：真实 vk 子进程 + 真实守护进程 + 本地 mock 的 TikTok。
// CLI 先行：授权、查创作者设置、填发布设置、Post / 送草稿箱、隐私没选时拒绝，都从命令行能做。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// unix socket 路径有长度上限（macOS 104），用短目录。
const HOME = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "vkt-"));
process.env.VK_HOME = HOME;
process.env.VK_NO_BROWSER = "1";
process.env.VK_TIKTOK_BACKOFF_MS = "1";
process.env.VK_TIKTOK_POLL_MS = "1";

const VK = fileURLToPath(new URL("../src/vk.mjs", import.meta.url));
const core = await import("../../core/src/index.mjs");
const store = await import("../../core/src/store.mjs");
const { loadAdapters, buildHandlers } = await import("../../core/src/adapters.mjs");
const { createCoreHandlers } = await import("../../core/src/handlers.mjs");
const { startDaemon } = await import("../../core/src/daemon.mjs");
const { startMock } = await import("../../adapter-tiktok-api/test/mock-tiktok.mjs");

let mock;
let daemon;

before(async () => {
  mock = await startMock({ privacyOptions: ["SELF_ONLY"] });
  Object.assign(process.env, {
    TIKTOK_API_BASE: mock.base,
    TIKTOK_AUTH_BASE: mock.base,
    TIKTOK_CLIENT_KEY: mock.state.clientKey,
    TIKTOK_CLIENT_SECRET: mock.state.clientSecret,
  });
  core.migrate();
  const adapters = (await loadAdapters({ only: ["tiktok-api"] })).adapters;
  const handlers = { ...buildHandlers(adapters, { log: () => {} }), ...createCoreHandlers({ adapters, log: () => {} }) };
  daemon = await startDaemon({ handlers, runQueue: false, port: 0 });
});
after(async () => {
  await daemon.close();
  await mock.close();
  rmSync(HOME, { recursive: true, force: true });
});

/** 跑一条 vk 命令；onStderr 能在命令还在等的时候拿到输出（比如授权链接）。 */
function vk(args, { onStderr } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VK, ...args], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      onStderr?.(stderr);
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const json = (r) => JSON.parse(r.stdout);
/** 失败时的人话：非 --human 输出 { ok:false, error:{message} } 到 stdout，--human 写 stderr。 */
const errorText = (r) => (r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout).error?.message ?? "" : "") + r.stderr;

async function drain(until) {
  for (let i = 0; i < 40; i++) {
    await daemon.runner.tick();
    if (until()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

let accountId;

test("vk account add tiktok-api → connect：授权链接走 stderr，授权完成后 stdout 是头像昵称", async () => {
  const group = store.addGroup({ name: "TT 组" });
  const add = json(await vk(["account", "add", "tiktok-api", "--group", "TT 组", "--name", "主号", "--handle", "@tt"]));
  accountId = add.id;
  assert.match(add.next, /vk account connect/);

  let approved = null;
  const run = await vk(["account", "connect", accountId], {
    onStderr(text) {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/v2\/auth\/authorize\/\?\S+)/.exec(text);
      if (m && !approved) approved = mock.approve(m[1]);
    },
  });
  assert.equal(run.code, 0, run.stderr);
  const out = json(run);
  assert.equal(out.state, "connected");
  assert.equal(out.displayName, "Mock Creator");
  assert.equal(out.avatarUrl, "https://mock.test/a.jpg");
  assert.match(run.stderr, /请在浏览器里打开/);
  assert.equal((await approved).status, 200);
  assert.ok(group);
});

test("vk account list --human：显示 TikTok、昵称和头像，不出现内部名 tiktok-api", async () => {
  const r = await vk(["account", "list", "--human"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /TikTok/);
  assert.match(r.stdout, /Mock Creator/);
  assert.match(r.stdout, /https:\/\/mock\.test\/a\.jpg/);
  assert.ok(!r.stdout.includes("tiktok-api"), r.stdout);
  const j = json(await vk(["account", "list"]));
  assert.equal(j.accounts.find((a) => a.id === accountId).avatar_url, "https://mock.test/a.jpg");
});

test("vk account creator --human：展示 TikTok 返回的隐私选项与开关", async () => {
  const r = await vk(["account", "creator", accountId, "--human"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /可选隐私级别：SELF_ONLY/);
  assert.match(r.stdout, /合拍：不允许/);
  assert.match(r.stdout, /最长时长：600 秒/);
});

function newPublish(video) {
  const work = store.upsertWork({ title: `CLI 作品 ${Math.random().toString(36).slice(2, 7)}`, cuts: [{ title: "c", versions: [{ language: "default", asset: video }] }] });
  return store.createPublish({ workId: work.id, accountId }).id;
}
const video = () => {
  const f = join(mkdtempSync(join(tmpdir(), "vkt-vid-")), "v.mp4");
  writeFileSync(f, Buffer.alloc(2048, 1));
  return f;
};

test("隐私级别没选：vk publish approve 拒绝并给人话，没有进队列", async () => {
  const id = newPublish(video());
  const r = await vk(["publish", "approve", "--publish", id]);
  assert.notEqual(r.code, 0);
  assert.match(errorText(r), /TikTok 发布前要先选隐私级别，没选不会发/);
  assert.match(errorText(r), /vk publish edit .* --privacy/);
  assert.equal(store.getPublish(id).state, "pending_confirm");
  const now = await vk(["publish", "now", id]);
  assert.notEqual(now.code, 0);
  assert.match(errorText(now), /没选不会发/);
});

test("Post：vk publish edit 填设置（开关默认关）→ approve → 已发布", async () => {
  mock.state.requests.length = 0;
  mock.state.pollCount = 0;
  const id = newPublish(video());
  const edit = await vk(["publish", "edit", id, "--privacy", "SELF_ONLY", "--caption", "审核演示", "--human"]);
  assert.equal(edit.code, 0, edit.stderr);
  assert.match(edit.stdout, /隐私级别：SELF_ONLY/);
  assert.match(edit.stdout, /评论 关 \/ 合拍 关 \/ 拼接 关/);
  assert.match(edit.stdout, /文案：审核演示/);
  assert.match(edit.stdout, /直接发布（Post）/);
  assert.ok(!edit.stdout.includes("tiktok-api"));

  const ok = await vk(["publish", "approve", "--publish", id]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(await drain(() => store.getPublish(id).state === "published"), `当前 ${store.getPublish(id).state}`);
  const body = mock.state.lastInit.body;
  assert.equal(body.post_info.title, "审核演示");
  assert.equal(body.post_info.privacy_level, "SELF_ONLY");
  assert.equal(body.post_info.disable_comment, true);
  assert.equal(body.post_info.disable_duet, true);
  assert.equal(body.post_info.disable_stitch, true);
});

test("Send to TikTok drafts：--draft → approve → 已送到草稿箱（draft_pending），不算已发布", async () => {
  mock.state.pollCount = 0;
  mock.state.statusSequence = ["SEND_TO_USER_INBOX"];
  const id = newPublish(video());
  const edit = await vk(["publish", "edit", id, "--draft", "--human"]);
  assert.equal(edit.code, 0, edit.stderr);
  assert.match(edit.stdout, /送到 TikTok 草稿箱/);
  assert.equal((await vk(["publish", "approve", "--publish", id])).code, 0);
  assert.ok(await drain(() => store.getPublish(id).state === "draft_pending"), `当前 ${store.getPublish(id).state}`);
  assert.equal(store.getPublish(id).published_at, null);
  assert.equal(mock.state.lastInit.path, "/v2/post/publish/inbox/video/init/");
  mock.state.statusSequence = ["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"];
});

test("vk publish edit 的用法提示里有新参数；不带任何改动时报用法", async () => {
  const r = await vk(["publish", "edit", "x"]);
  assert.notEqual(r.code, 0);
  assert.match(errorText(r), /--privacy/);
  assert.match(errorText(r), /--no-comment/);
});

test("vk publish edit --body/--tags 能改正文和话题，超限给人话（#175）", async () => {
  const id = newPublish(video());
  const ok = await vk(["publish", "edit", id, "--body", "新正文第一行", "--tags", "a,#b，c"]);
  assert.equal(ok.code, 0, ok.stderr + ok.stdout);
  const row = store.getPublish(id);
  const ov = JSON.parse(row.overrides_json);
  assert.equal(ov.body, "新正文第一行");
  assert.deepEqual(ov.tags, ["a", "b", "c"]);
  const bad = await vk(["publish", "edit", id, "--body", "长".repeat(5000)]);
  assert.notEqual(bad.code, 0);
  assert.match(errorText(bad), /最多/);
});
