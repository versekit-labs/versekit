// 通道测试：用一个假的 lark-cli 进程，验的是「参数拼对了、输出解析对了、事件能交回来」。
// 不装飞书、不联网，所以 CI 里也能跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  if (process.env.VK_TEST_PROBE_STDERR !== undefined) {
    console.error(process.env.VK_TEST_PROBE_STDERR);
    process.exitCode = Number(process.env.VK_TEST_PROBE_STATUS);
    return;
  }
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

test("默认用 versekit 目录下的 lark-cli；VK_LARK_BIN 仍可覆盖；没装就退回 PATH", () => {
  const prefix = mkdtempSync(join(tmpdir(), "vk-feishu-prefix-"));
  const own = join(prefix, "bin", "lark-cli");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(own, '#!/bin/sh\n[ "$1" = "--version" ] && { echo "lark-cli version own"; exit 0; }\nexit 2\n');
  chmodSync(own, 0o755);
  const saved = { bin: process.env.VK_LARK_BIN, prefix: process.env.VERSEKIT_PREFIX, path: process.env.PATH };
  try {
    delete process.env.VK_LARK_BIN;
    process.env.VERSEKIT_PREFIX = prefix;
    process.env.PATH = "/nonexistent-vk-test";
    assert.equal(channel.installed(), true, "PATH 里没有 lark-cli，也该找到 versekit 目录下的");
    process.env.VK_LARK_BIN = join(prefix, "missing");
    assert.equal(channel.installed(), false, "VK_LARK_BIN 优先于默认位置");
    delete process.env.VK_LARK_BIN;
    process.env.VERSEKIT_PREFIX = join(prefix, "empty");
    assert.equal(channel.installed(), false, "两处都没有就是没装");
  } finally {
    for (const [k, v] of [["VK_LARK_BIN", saved.bin], ["VERSEKIT_PREFIX", saved.prefix], ["PATH", saved.path]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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

async function receiveAction(signal, check) {
  const got = [];
  const events = new EventEmitter();
  const received = once(events, "action", { signal });
  const stop = channel.start({ onAction: (evt) => {
    got.push(evt);
    events.emit("action");
  } });
  try {
    await received;
    assert.equal(got.length, 1, "应该收到一条按钮事件");
    check(got[0]);
  } finally {
    stop();
  }
}

test("start(): 把长连接里的按钮事件交回来，stop() 能停掉", { timeout: 30e3 }, async ({ signal }) => {
  await receiveAction(signal, (evt) => {
    assert.equal(evt.operator_id, "ou_test");
    assert.equal(evt.token, "tok_1");
    assert.equal(JSON.parse(evt.action_value).cmd, "publish.retry");
  });
});

async function probeWithFixture(stderr, status) {
  // 复用 ready() 和 start() 的假 CLI，避免首次执行新脚本的开销占掉探活期限。
  process.env.VK_TEST_PROBE_STDERR = stderr;
  process.env.VK_TEST_PROBE_STATUS = String(status);
  try {
    return await channel.probeEvents();
  } finally {
    delete process.env.VK_TEST_PROBE_STDERR;
    delete process.env.VK_TEST_PROBE_STATUS;
  }
}

test("probeEvents(): 未订阅时返回 false 并带上后台订阅链接", async () => {
  const res = await probeWithFixture(JSON.stringify({
    ok: false,
    error: {
      type: "validation",
      subtype: "failed_precondition",
      message: "EventKey card.action.trigger requires callbacks not subscribed in console: card.action.trigger",
      hint: "subscribe these callbacks by scanning: https://open.feishu.cn/page/launcher?clientID=cli_test&addons=abc",
    },
  }), 2);
  assert.equal(res.ok, false);
  assert.match(res.detail, /没有订阅|未订阅/);
  assert.equal(res.url, "https://open.feishu.cn/page/launcher?clientID=cli_test&addons=abc");
});

test("probeEvents(): 已有消费者在跑时视为订阅生效，不误报", async () => {
  const res = await probeWithFixture(JSON.stringify({
    ok: false,
    error: {
      type: "validation",
      subtype: "failed_precondition",
      message: "cannot start consumer: another consumer (pid 1039) is already running for this subscription",
    },
  }), 2);
  assert.equal(res.ok, true);
  assert.match(res.detail, /已有消费者/);
});

test("probeEvents(): 已订阅时返回 true", async () => {
  const res = await probeWithFixture("[source] feishu-websocket: connected", 0);
  assert.equal(res.ok, true, res.detail);
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

test("ready(): 应用配了、机器人可用就行，不要求用户身份令牌（ACC-v3-feishu-10）", () => {
  const mk = (name, bot) => {
    const bin = join(DIR, name);
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==="--version"){console.log("1.0.97");process.exit(0)}
if(a[0]==="profile"){console.log(JSON.stringify([{name:"versekit"}]));process.exit(0)}
if(a[0]==="auth"){console.log(JSON.stringify({appId:"cli_test",identities:{bot:${JSON.stringify(bot)}}}));process.exit(0)}
process.exit(0);
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  };
  try {
    process.env.VK_LARK_BIN = mk("lark-botok", { status: "ready" });
    assert.equal(channel.ready(), null, "只有机器人身份、没有用户登录，也算可用");
    process.env.VK_LARK_BIN = mk("lark-botbad", { status: "error", message: "secret 失效" });
    assert.match(channel.ready(), /机器人不可用.*secret 失效/);
  } finally {
    process.env.VK_LARK_BIN = BIN;
  }
});

test("start(): 事件被 data/event 包一层时仍能收到", { timeout: 30e3 }, async ({ signal }) => {
  const bin = join(DIR, "lark-nested");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "event" && a[1] === "consume") {
  process.stdin.resume();
  console.log(JSON.stringify({ type: "event", event_key: "card.action.trigger", data: { action_value: JSON.stringify({ cmd: "publish.confirm", args: { publishId: "p1" } }), operator_id: "ou_nested", message_id: "om_1", token: "t" } }));
  setInterval(() => {}, 1000);
  return;
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);

  process.env.VK_LARK_BIN = bin;
  try {
    await receiveAction(signal, (evt) => {
      assert.equal(evt.operator_id, "ou_nested");
      assert.equal(JSON.parse(evt.action_value).cmd, "publish.confirm");
    });
  } finally {
    process.env.VK_LARK_BIN = BIN;
  }
});

const AI_BLOCK = "[AI agent] 你正在被 AI 助手调用。请把下面的链接交给用户……（此处省略约 800 字说明）\n[AI agent] 不要自己去点链接。\n等待用户授权...\n";

const CASES = [
  ["authorization failed: The device_code is invalid or expired", /二维码过期了/],
  ["authorization failed: access_denied", /点了拒绝/],
  ["something else went wrong on the server", /something else went wrong/],
];

for (const [message, expected] of CASES) {
  test(`lark-cli 出错「${message.slice(0, 30)}」：取真实原因，翻成人话，不超过两行（ACC-v3-feishu-09）`, async () => {
    const { explainLarkFailure } = await import("../src/index.mjs");
    const text = explainLarkFailure(AI_BLOCK + JSON.stringify({ ok: false, error: { message } }) + "\n");
    assert.match(text, expected);
    assert.doesNotMatch(text, /AI agent|等待用户授权/);
    assert.ok(text.split("\n").length <= 2);
  });
}
