// #173 演示环境：本地 mock 的 TikTok 服务端 + 带「同意」按钮的假授权页 + 真实守护进程与 Web。
// 只连 127.0.0.1，不碰真实账号、不用真实 client_key。用法：node docs/screenshots/issue-173/mock-demo.mjs
// 控制：打印出的 CONTROL 地址 /mode?name=ok|spam|fail 切换下一次发布的结果。
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const HOME = mkdtempSync("/tmp/vk173-");
process.env.VK_HOME = HOME;
process.env.VK_NO_BROWSER = "1";
process.env.VK_TIKTOK_POLL_MS = "900";
process.env.VK_TIKTOK_BACKOFF_MS = "1";

const root = new URL("../../../", import.meta.url);
const core = await import(new URL("packages/core/src/index.mjs", root));
const store = await import(new URL("packages/core/src/store.mjs", root));
const { loadAdapters, buildHandlers } = await import(new URL("packages/core/src/adapters.mjs", root));
const { createCoreHandlers } = await import(new URL("packages/core/src/handlers.mjs", root));
const { startDaemon } = await import(new URL("packages/core/src/daemon.mjs", root));
const { startMock } = await import(new URL("packages/adapter-tiktok-api/test/mock-tiktok.mjs", root));

const mock = await startMock({ privacyOptions: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS", "PUBLIC_TO_EVERYONE"], duetDisabled: true, statusSequence: ["PROCESSING_UPLOAD", "PROCESSING_UPLOAD", "PUBLISH_COMPLETE"] });

// 假授权页：TikTok 的授权页长这样——点「Authorize」就带 code 回到本机回调。
const auth = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/v2/auth/authorize/") {
    const q = Object.fromEntries(u.searchParams);
    mock.state.codes.set("demo_code", { challenge: q.code_challenge });
    const back = `${q.redirect_uri}?code=demo_code&state=${encodeURIComponent(q.state)}`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta charset=utf-8><title>TikTok · Authorize (mock)</title><body style="font:16px system-ui;max-width:420px;margin:12vh auto;text-align:center">
<h2>versekit wants to access your TikTok account</h2><p>Basic info (user.info.basic) · Post videos (video.publish) · Upload drafts (video.upload)</p>
<p style="color:#888">本地 mock 授权页，仅演示</p><a href="${back}" style="display:inline-block;padding:12px 28px;background:#fe2c55;color:#fff;border-radius:6px;text-decoration:none">Authorize</a></body>`);
  }
  res.writeHead(404).end();
});
await new Promise((r) => auth.listen(0, "127.0.0.1", r));

Object.assign(process.env, {
  TIKTOK_API_BASE: mock.base,
  TIKTOK_AUTH_BASE: `http://127.0.0.1:${auth.address().port}`,
  TIKTOK_CLIENT_KEY: mock.state.clientKey,
  TIKTOK_CLIENT_SECRET: mock.state.clientSecret,
});
core.migrate();
const adapters = (await loadAdapters({ only: ["tiktok-api"] })).adapters;
const handlers = { ...buildHandlers(adapters, { log: () => {} }), ...createCoreHandlers({ adapters, log: () => {} }) };
const daemon = await startDaemon({ handlers, runQueue: true, port: Number(process.env.PORT || 8799) });

// 演示数据：一个账号组、一支真实的小 mp4、三条作品（正常 / 送草稿 / 出错各一条）。
const group = store.addGroup({ name: "演示组" });
const video = join(HOME, "demo.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=24:duration=3", "-pix_fmt", "yuv420p", video]);
store.addAccount({ platform: "tiktok-api", handle: "@versekit_demo", displayName: "versekit_demo", groupId: group.id });
const acc = store.listAccounts({ groupId: group.id }).find((a) => a.platform === "tiktok-api");
for (const title of ["演示 A：直接发布", "演示 B：送到草稿箱", "演示 C：出错的人话"]) {
  const w = store.upsertWork({ title, cuts: [{ title, versions: [{ language: "default", asset: video }] }] });
  store.createPublish({ workId: w.id, accountId: acc.id });
}
mock.state.postId = "7300000000000000001";

const control = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/mode") {
    const m = u.searchParams.get("name");
    mock.state.initError = m === "spam" ? { status: 403, code: "spam_risk_too_many_posts" } : null;
    mock.state.statusSequence = m === "draft" ? ["SEND_TO_USER_INBOX"] : ["PROCESSING_UPLOAD", "PROCESSING_UPLOAD", "PUBLISH_COMPLETE"];
    mock.state.pollCount = 0;
    return res.end("mode " + m);
  }
  res.writeHead(404).end();
});
await new Promise((r) => control.listen(0, "127.0.0.1", r));
console.log(JSON.stringify({ WEB: `http://127.0.0.1:${daemon.port ?? daemon.address?.port ?? 8799}`, CONTROL: `http://127.0.0.1:${control.address().port}`, HOME, account: acc.id }));
