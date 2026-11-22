#!/usr/bin/env node
// 假的 lark-cli：用一个状态目录（FAKE_LARK_DIR）里的文件模拟飞书那一侧，测试往里放文件就是「用户在飞书里做了这一步」。
//   profile      应用已建好（profile add 会写它；secret 只从 stdin 读，长度记在 secret.len，内容不落盘）
//   authed       lark-cli 里有用户身份（只给 `vk channel bind` 不带 open_id 的老路径用；接飞书本身不再需要）
//   subscribed   开发者后台开通了按钮订阅
//   sendfail     里面写一句话：发卡片就失败并带这句话
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_LARK_DIR;
const f = (n) => join(dir, n);
const has = (n) => existsSync(f(n));
const args = process.argv.slice(2);
appendFileSync(f("calls.log"), JSON.stringify(args.filter((a) => !/secret/i.test(a))) + "\n");

if (args[0] === "--version") { console.log("1.0.97"); process.exit(0); }
if (args[0] === "profile" && args[1] === "add") {
  const d = await new Promise((resolve) => { let t = ""; process.stdin.on("data", (c) => (t += c)); process.stdin.on("end", () => resolve(t)); });
  writeFileSync(f("secret.len"), String(d.trim().length));
  writeFileSync(f("profile"), args[args.indexOf("--app-id") + 1]);
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
} else if (args[0] === "profile") {
  console.log(JSON.stringify(has("profile") ? [{ name: "versekit", appId: readFileSync(f("profile"), "utf8") === "1" ? "cli_fake" : readFileSync(f("profile"), "utf8") }] : []));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ appId: "cli_fake", identities: { ...(has("authed") ? { user: { openId: "ou_owner", userName: "所有者" } } : {}), bot: { status: "ready" } } }));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "qrcode") {
  const out = args[args.indexOf("-o") + 1];
  writeFileSync(out, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
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
