// 通道测试：用一个假的 lark-cli 进程，验的是「参数拼对了、输出解析对了、事件能交回来」。
// 不装飞书、不联网，所以 CI 里也能跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "vk-feishu-"));
const LOG = join(DIR, "calls.ndjson");

function fakeLark() {
  const bin = join(DIR, "lark-cli");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("1.0.97"); process.exit(0); }
if (args[0] === "profile") {
  console.log(JSON.stringify([{ name: "versekit", appId: "cli_test" }]));
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ ok: true, identities: { user: { openId: "ou_test", userName: "测试用户" } } }));
  process.exit(0);
}
if (args[0] === "im") {
  console.log(JSON.stringify({ ok: true, data: { message_id: "om_test_1" } }));
  process.exit(0);
}
if (args[0] === "api") {
  console.log(JSON.stringify({ ok: true, data: {} }));
  process.exit(0);
}
if (args[0] === "event") {
  console.log(JSON.stringify({ type: "card.action.trigger", operator_id: "ou_test", action_value: JSON.stringify({ cmd: "publish.retry", args: { publishId: "p1" }, exp: Date.now() + 60000, key: "k1" }), token: "tok_1" }));
  setInterval(() => {}, 60000);
  return;
}
console.error("unexpected args " + args.join(" "));
process.exit(2);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const BIN = fakeLark();
process.env.VK_LARK_BIN = BIN;
const channel = (await import("../src/index.mjs")).default;

const calls = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("ready(): 有 lark-cli 返回 null，没有就给出人能照做的原因", () => {
  assert.equal(channel.ready(), null);
  process.env.VK_LARK_BIN = join(DIR, "missing-cli");
  assert.match(channel.ready(), /没有找到 lark-cli/);
  process.env.VK_LARK_BIN = BIN;
});

test("whoami() 从 auth status 里取当前登录的人", async () => {
  const who = await channel.whoami();
  assert.equal(who.openId, "ou_test");
  assert.equal(who.name, "测试用户");
});

test("send(): 以机器人身份发交互卡片，参数与幂等键都带上了", async () => {
  const card = { config: { wide_screen_mode: true }, elements: [] };
  const res = await channel.send({ openId: "ou_test", card, idempotencyKey: "event:evt_1" });
  assert.equal(res.messageId, "om_test_1");

  const call = calls().reverse().find((a) => a[0] === "im");
  assert.deepEqual(call.slice(0, 2), ["im", "+messages-send"]);
  assert.ok(call.includes("--user-id"));
  assert.equal(call[call.indexOf("--user-id") + 1], "ou_test");
  assert.equal(call[call.indexOf("--msg-type") + 1], "interactive");
  assert.deepEqual(JSON.parse(call[call.indexOf("--content") + 1]), card);
  assert.equal(call[call.indexOf("--idempotency-key") + 1], "event:evt_1");
  assert.equal(call[call.indexOf("--as") + 1], "bot");
});

test("updateCard(): 按 message_id PATCH，content 是序列化后的卡片", async () => {
  const card = { elements: [], header: { title: { content: "已处理" } } };
  await channel.updateCard({ messageId: "om_test_1", card });
  const call = calls().reverse().find((a) => a[0] === "api");
  assert.equal(call[call.indexOf("PATCH")], "PATCH");
  assert.ok(call.includes("/open-apis/im/v1/messages/om_test_1"));
  const body = JSON.parse(call[call.indexOf("--data") + 1]);
  assert.deepEqual(JSON.parse(body.content), card);
});

test("start(): 把长连接里的按钮事件交回来，stop() 能停掉", async () => {
  const got = [];
  const stop = channel.start({ onAction: (evt) => got.push(evt) });
  try {
    const end = Date.now() + 5000;
    while (!got.length && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.equal(got.length, 1, "应该收到一条按钮事件");
    assert.equal(got[0].operator_id, "ou_test");
    assert.equal(got[0].token, "tok_1");
    assert.equal(JSON.parse(got[0].action_value).cmd, "publish.retry");
  } finally {
    stop();
  }
});

test("probeEvents(): 未订阅时返回 false 并带上后台订阅链接", async () => {
  const bin = join(DIR, "lark-probe-bad");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "event") {
  console.error(JSON.stringify({ ok: false, error: { type: "validation", subtype: "failed_precondition",
    message: "EventKey card.action.trigger requires callbacks not subscribed in console: card.action.trigger",
    hint: "subscribe these callbacks by scanning: https://open.feishu.cn/page/launcher?clientID=cli_test&addons=abc" } }));
  process.exit(2);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);

  process.env.VK_LARK_BIN = bin;
  try {
    const res = await channel.probeEvents();
    assert.equal(res.ok, false);
    assert.match(res.detail, /没有订阅|未订阅/);
    assert.equal(res.url, "https://open.feishu.cn/page/launcher?clientID=cli_test&addons=abc");
  } finally {
    process.env.VK_LARK_BIN = BIN;
  }
});

test("probeEvents(): 已有消费者在跑时视为订阅生效，不误报", async () => {
  const bin = join(DIR, "lark-probe-busy");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "event") {
  console.error(JSON.stringify({ ok: false, error: { type: "validation", subtype: "failed_precondition",
    message: "cannot start consumer: another consumer (pid 1039) is already running for this subscription" } }));
  process.exit(2);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  process.env.VK_LARK_BIN = bin;
  try {
    const res = await channel.probeEvents();
    assert.equal(res.ok, true);
    assert.match(res.detail, /已有消费者/);
  } finally {
    process.env.VK_LARK_BIN = BIN;
  }
});

test("probeEvents(): 已订阅时返回 true", async () => {
  const bin = join(DIR, "lark-probe-good");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "event") {
  console.error("[source] feishu-websocket: connected");
  setTimeout(() => process.exit(0), 200);
  return;
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  process.env.VK_LARK_BIN = bin;
  try {
    const res = await channel.probeEvents();
    assert.equal(res.ok, true);
  } finally {
    process.env.VK_LARK_BIN = BIN;
  }
});

test("configure(): app_secret 只走 stdin，不进 argv、不落文件", async () => {
  const bin = join(DIR, "lark-config");
  const secretLog = join(DIR, "secret-audit.log");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(secretLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "profile" && args[1] === "add") {
  let data = "";
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => {
    fs.appendFileSync(${JSON.stringify(secretLog)}, "stdin_len=" + data.trim().length + "\\n");
    console.log(JSON.stringify({ ok: true }));
  });
  return;
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);

  process.env.VK_LARK_BIN = bin;
  try {
    const res = await channel.configure({ appId: "cli_test123", appSecret: "super-secret-value" });
    assert.equal(res.profile, "versekit");
    assert.equal(res.appId, "cli_test123");

    const audit = readFileSync(secretLog, "utf8");
    assert.ok(!audit.includes("super-secret-value"), "secret 不能出现在 argv 或日志里");
    assert.match(audit, /stdin_len=18/);
  } finally {
    process.env.VK_LARK_BIN = BIN;
  }
});

test("ready(): 没有自己的 profile 时让你去配，不回落全局应用", () => {
  const bin = join(DIR, "lark-noprofile");
  writeFileSync(bin, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[0]==="--version"){console.log("1.0.97");process.exit(0)}\nif(a[0]==="profile"){console.log("[]");process.exit(0)}\nprocess.exit(0);\n`);
  chmodSync(bin, 0o755);
  process.env.VK_LARK_BIN = bin;
  try {
    assert.match(channel.ready(), /应用未配置|app_secret/);
  } finally {
    process.env.VK_LARK_BIN = BIN;
  }
});

test("ready(): 应用配了但没授权时，要求先授权", () => {
  const bin = join(DIR, "lark-noauth");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==="--version"){console.log("1.0.97");process.exit(0)}
if(a[0]==="profile"){console.log(JSON.stringify([{name:"versekit"}]));process.exit(0)}
if(a[0]==="auth"){console.log(JSON.stringify({appId:"cli_test",identities:{bot:{status:"ready"}}}));process.exit(0)}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  process.env.VK_LARK_BIN = bin;
  try {
    assert.match(channel.ready(), /还没有授权/);
  } finally {
    process.env.VK_LARK_BIN = BIN;
  }
});

test("authStart / authFinish：设备码两步", async () => {
  const bin = join(DIR, "lark-login");
  const log = join(DIR, "login.log");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
if (a[0] === "auth" && a[1] === "login") {
  if (a.includes("--no-wait")) console.log(JSON.stringify({ ok: true, data: { verification_url: "https://open.feishu.cn/device", device_code: "dc_1", expires_in: 300 } }));
  else console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  process.env.VK_LARK_BIN = bin;
  try {
    const started = await channel.authStart();
    assert.equal(started.verificationUrl, "https://open.feishu.cn/device");
    assert.equal(started.deviceCode, "dc_1");

    await channel.authFinish("dc_1");
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /--device-code/);
  } finally {
    process.env.VK_LARK_BIN = BIN;
  }
});
