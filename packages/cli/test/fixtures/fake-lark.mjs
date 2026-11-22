#!/usr/bin/env node
// 假的 lark-cli：用一个状态目录（FAKE_LARK_DIR）里的文件模拟飞书那一侧，测试往里放文件就是「用户在飞书里做了这一步」。
//   create.go    扫码建应用完成        → 写 profile
//   login.go     扫码授权完成          → 写 authed
//   subscribed   开发者后台开通了按钮订阅
//   sendfail     里面写一句话：发卡片就失败并带这句话
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_LARK_DIR;
const f = (n) => join(dir, n);
const has = (n) => existsSync(f(n));
const args = process.argv.slice(2);
const wait = async (name) => { while (!has(name)) await new Promise((r) => setTimeout(r, 30)); };
appendFileSync(f("calls.log"), JSON.stringify(args.filter((a) => !/secret/i.test(a))) + "\n");

if (args[0] === "--version") { console.log("1.0.97"); process.exit(0); }
if (args[0] === "profile") {
  console.log(JSON.stringify(has("profile") ? [{ name: "versekit", appId: "cli_fake" }] : []));
  process.exit(0);
}
if (args[0] === "config") {
  console.log("请在浏览器打开 https://fake.feishu.test/create?code=abc 完成创建");
  await wait("create.go");
  writeFileSync(f("profile"), "1");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify(has("authed") ? { appId: "cli_fake", identities: { user: { openId: "ou_owner", userName: "所有者" }, bot: { status: "ready" } } } : { identities: {} }));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "qrcode") {
  const out = args[args.indexOf("-o") + 1];
  writeFileSync(out, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login") {
  if (args.includes("--no-wait")) { console.log(JSON.stringify({ ok: true, data: { verification_url: "https://fake.feishu.test/auth?c=1", device_code: "dev_1", expires_in: 600 } })); process.exit(0); }
  await wait("login.go");
  writeFileSync(f("authed"), "1");
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "event") {
  if (!has("subscribed")) {
    console.error('{"error":{"type":"failed_precondition","hint":"https://open.feishu.cn/page/launcher?fake=1"}} not subscribed');
    process.exit(1);
  }
  if (args.includes("--timeout")) process.exit(0);
  console.log("ready event_key card.action.trigger");
  // 和真的 lark-cli 一样：stdin 关了（父进程没了）就退出，测试不会留下孤儿进程。
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
} else if (args[0] === "im") {
  if (has("sendfail")) { console.error(readFileSync(f("sendfail"), "utf8")); process.exit(1); }
  appendFileSync(f("sent.log"), args[args.indexOf("--content") + 1] + "\n");
  console.log(JSON.stringify({ ok: true, data: { message_id: `om_${Date.now()}` } }));
  process.exit(0);
} else if (args[0] === "api") {
  console.log(JSON.stringify({ ok: true, data: {} }));
  process.exit(0);
} else {
  console.error("unexpected args " + args.join(" "));
  process.exit(2);
}
