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
// 和真的 lark-cli 1.0.97 一样：同名 add 报错、不能删唯一的 profile、remove/rename 只认位置参数；错误是多行缩进 JSON。
const fail = (msg) => { console.error(JSON.stringify({ ok: false, error: { type: "validation", message: msg } }, null, 2)); process.exit(2); };
const names = () => (has("profiles") ? readFileSync(f("profiles"), "utf8").split("\n").filter(Boolean) : has("profile") ? ["versekit"] : []);
const save = (list) => writeFileSync(f("profiles"), list.join("\n"));
if (args[0] === "profile" && args[1] === "add") {
  const name = args[args.indexOf("--name") + 1];
  if (names().includes(name)) fail(`profile "${name}" already exists`);
  if (has("failadd") && name !== "versekit") fail("add failed on purpose");
  const before = names();
  const d = await new Promise((resolve) => { let t = ""; process.stdin.on("data", (c) => (t += c)); process.stdin.on("end", () => resolve(t)); });
  writeFileSync(f("secret.len"), String(d.trim().length));
  if (name === "versekit" || !has("profile")) writeFileSync(f("profile"), args[args.indexOf("--app-id") + 1]);
  else writeFileSync(f("profile.new"), args[args.indexOf("--app-id") + 1]);
  save([...before, name]);
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
} else if (args[0] === "profile" && args[1] === "remove") {
  const name = args[2];
  if (args.includes("--name")) fail("unknown flag: --name");
  if (!names().includes(name)) fail(`profile "${name}" not found`);
  if (names().length === 1) fail("cannot remove the only profile");
  if (has("failremove") && name === "versekit") fail("remove failed on purpose");
  save(names().filter((n) => n !== name));
  if (name === "versekit") unlinkSync(f("profile"));
  else if (name.startsWith("versekit-new-") && has("profile.new")) unlinkSync(f("profile.new"));
  else if (has("profile.bak")) unlinkSync(f("profile.bak"));
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
} else if (args[0] === "profile" && args[1] === "rename") {
  const [from, to] = [args[2], args[3]];
  if (!names().includes(from)) fail(`profile "${from}" not found`);
  if (names().includes(to)) fail(`profile "${to}" already exists`);
  if (has("failbackup") && from === "versekit") fail("backup rename failed on purpose");
  if (has("failrename") && from.startsWith("versekit-new-")) fail("rename failed on purpose");
  save(names().map((n) => (n === from ? to : n)));
  // 状态文件：profile=versekit 的 appId；profile.new=临时名的；profile.bak=被改名挪走的旧 versekit 的
  const mv = (a, b) => { if (has(a)) { writeFileSync(f(b), readFileSync(f(a), "utf8")); unlinkSync(f(a)); } };
  if (from === "versekit") mv("profile", "profile.bak");
  else if (to === "versekit") mv(from.startsWith("versekit-new-") ? "profile.new" : "profile.bak", "profile");
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
} else if (args[0] === "profile") {
  console.log(JSON.stringify(names().includes("versekit") ? [{ name: "versekit", appId: readFileSync(f("profile"), "utf8") === "1" ? "cli_fake" : readFileSync(f("profile"), "utf8") }] : []));
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
