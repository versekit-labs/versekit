// 界面上不出现命令（ACC-v3-nocli-01..04）：页面和脚本、服务端给页面的报错和提示、入口对应的命令都在命令表里。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = mkdtempSync(join(tmpdir(), "vk-nocli-"));
process.env.VK_HOME = HOME;
const ROOT = new URL("../../../", import.meta.url).pathname;

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { createDispatcher, withoutCommandHints } = await import("../src/daemon.mjs");
const { COMMANDS, findCommand } = await import("../src/commands.mjs");
const { readConfig, updateConfig } = await import("../src/config.mjs");
const { ERROR_CODES } = await import("../src/errors.mjs");

before(() => core.migrate());

/** 命令行、配置文件名、参数开关、内部标识：页面上的人不该读到。 */
const LEAK = [
  [/\bvk [a-z]/, "vk 命令"],
  [/\bnpm (?:run|install|test)\b/, "npm 命令"],
  [/\bcurl \S/, "curl 命令"],
  [/config\.json/, "配置文件名"],
  [/(?:^|[\s（(])--[a-z][a-z-]*/, "命令行参数"],
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "ISO 时间串"],
  [/\berror_code\b/, "error_code"],
  [/\bpackages\/[a-z]/, "仓库里的文件路径"],
  [/(?:^|[\s（(：])\/(?:Users|home|var|tmp)\//, "文件路径"],
];
const leaks = (text) => LEAK.filter(([re]) => re.test(text)).map(([, name]) => name);

// ── ACC-v3-nocli-01 ───────────────────────────────────────────────────────

test("ACC-v3-nocli-01：packages/web/public 下的页面和脚本里没有命令行", () => {
  const dir = join(ROOT, "packages/web/public");
  const bad = [];
  for (const f of readdirSync(dir).filter((n) => /\.(html|js)$/.test(n))) {
    const src = readFileSync(join(dir, f), "utf8");
    const hits = [...src.matchAll(/<code[\s>]|\bvk (?:[a-z]+)\b|\bnpm (?:run|install|test)\b|\bcurl \S|config\.json/g)].map((m) => m[0]);
    if (hits.length) bad.push(`${f}: ${hits.join(" | ")}`);
  }
  assert.deepEqual(bad, []);
});

test("ACC-v3-nocli-01：design:check 的 cli-in-ui 检查两处都跑", () => {
  const src = readFileSync(join(ROOT, "scripts/design-check.mjs"), "utf8");
  assert.match(src, /docs\/design/);
  assert.match(src, /packages\/web\/public/);
  assert.match(src, /cli-in-ui/);
});

// ── ACC-v3-nocli-02：遍历会到达页面的报错文案 ────────────────────────────────

/** 读出一段源码里 `fail(` 的第一个参数（字符串或模板字面量，含嵌套的 ${}），不含第二个参数（命令行提示）。 */
function failMessages(src) {
  const out = [];
  for (const m of src.matchAll(/\bfail\(/g)) {
    let i = m.index + m[0].length;
    while (/\s/.test(src[i])) i++;
    const q = src[i];
    if (q !== '"' && q !== "`" && q !== "'") continue; // fail(err.message) 之类：不是写死的文案
    let j = i + 1, depth = 0;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") { j++; continue; }
      if (q === "`" && c === "$" && src[j + 1] === "{") { depth++; j++; continue; }
      if (depth && c === "}") { depth--; continue; }
      if (!depth && c === q) break;
    }
    out.push(src.slice(i + 1, j));
  }
  return out;
}

test("ACC-v3-nocli-02：handlers.mjs / store.mjs 里 fail(…) 的文案没有命令、参数、内部标识", () => {
  const bad = [];
  for (const f of ["handlers.mjs", "store.mjs"]) {
    const msgs = failMessages(readFileSync(join(ROOT, "packages/core/src", f), "utf8"));
    assert.ok(msgs.length > 20, `${f} 里应该能读出一批 fail 文案（读到 ${msgs.length}）`);
    for (const msg of msgs) if (leaks(msg).length) bad.push(`${f}: ${msg}（${leaks(msg).join("、")}）`);
  }
  assert.deepEqual(bad, []);
});

test("ACC-v3-nocli-02：适配器、调度、更新、规则里 new Error / AdapterError 的文案同样干净", () => {
  const files = [
    "packages/core/src/daemon.mjs", "packages/core/src/adapters.mjs", "packages/core/src/update.mjs", "packages/core/src/overview.mjs",
    "packages/core/src/plan-rules.mjs", "packages/core/src/schedule.mjs",
    "packages/adapter-tiktok-api/src/index.mjs", "packages/adapter-tiktok-api/src/api.mjs", "packages/adapter-tiktok-api/src/settings.mjs",
    "packages/adapter-xiaohongshu/src/index.mjs",
  ];
  const bad = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    // 只看抛出去的文案行；注释和日志不算。
    for (const line of src.split("\n")) {
      if (!/(new Error\(|AdapterError\(|message:\s*[`"])/.test(line)) continue;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      // 只看字符串字面量里的话：对象的键名（如库字段 error_code）不是给人看的。
      const text = [...line.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2]).join(" ");
      if (leaks(text).length) bad.push(`${f}: ${line.trim().slice(0, 140)}（${leaks(text).join("、")}）`);
    }
  }
  assert.deepEqual(bad, []);
});

test("ACC-v3-nocli-02：错误码表里给人看的话也没有命令（改用「扫码」「代理设置」这类说法）", () => {
  const bad = Object.entries(ERROR_CODES).filter(([, v]) => leaks(v.human).length).map(([k, v]) => `${k}: ${v.human}`);
  assert.deepEqual(bad, []);
});

test("ACC-v3-nocli-02：经 HTTP 给页面的报错体不带 hint，命令行来的带；成功结果里的命令提示给页面时去掉", async () => {
  const handlers = createCoreHandlers({ adapters: [], log: () => {} });
  const dispatch = createDispatcher({ handlers, log: () => {} });
  const call = async (origin) => {
    const req = Object.assign(new (await import("node:stream")).Readable({ read() { this.push(JSON.stringify({ platform: "bilibili", name: "无组", group: "不存在的组" })); this.push(null); } }), {
      url: "/api/accounts", method: "POST", headers: { "x-vk-origin": origin, "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" },
    });
    let status = 0, body = "";
    const res = { headersSent: false, writeHead(s) { status = s; }, end(b) { body = b; } };
    await dispatch(req, res);
    return { status, body: JSON.parse(body) };
  };
  const web = await call("web");
  assert.equal(web.status, 400);
  assert.deepEqual(leaks(web.body.error.message), [], `页面收到的报错里没有命令：${web.body.error.message}`);
  assert.equal(web.body.error.hint, undefined, "给页面的错误体不带 hint");
  const cli = await call("cli");
  assert.match(cli.body.error.hint, /vk group list/, "命令行照旧拿到提示");
  assert.equal(cli.body.error.message, web.body.error.message, "话是同一句");

  assert.deepEqual(withoutCommandHints({ id: "x", next: "下一步：vk account login x --qr", checkHint: "vk account check x" }), { id: "x" });
  assert.deepEqual(withoutCommandHints({ next: "在 App 里发完后再确认" }), { next: "在 App 里发完后再确认" });
});

// ── ACC-v3-nocli-03 / 04：入口和命令 ───────────────────────────────────────

test("ACC-v3-nocli-03：以前靠命令才能做的事，页面脚本里都有对应的调用", () => {
  const page = readFileSync(join(ROOT, "packages/web/public/system.html"), "utf8") + readFileSync(join(ROOT, "packages/web/public/api.js"), "utf8");
  const entries = {
    新建账号组: /addGroup|data-ngsave/,
    改名账号组: /renameGroup|data-renamesave/,
    接入账号: /\/api\/accounts"/,
    扫码登录: /login\/qr/,
    短信登录: /login\/start[\s\S]*login\/verify/,
    窗口登录: /login\/open/,
    退出登录: /"logout"/,
    换号: /"switch"/,
    填应用凭证: /platforms\/tiktok-api\/credentials/,
    改发布方案: /\/api\/plan"/,
    现在更新: /data-updnow[\s\S]*\/api\/update", \{\}/,
    开关自动更新: /auto: d\.autoupd/,
    接入设备: /\/api\/relay\/connect/,
    断开设备: /\/api\/relay\/disconnect/,
  };
  for (const [name, re] of Object.entries(entries)) assert.match(page, re, `页面上缺「${name}」的入口`);
});

test("ACC-v3-nocli-04：CLI 完整律：上面每个入口对应的命令都在 vk commands --json 里", () => {
  const out = JSON.parse(execFileSync(process.execPath, [join(ROOT, "packages/cli/src/vk.mjs"), "commands", "--json"], { env: { ...process.env, VK_HOME: HOME }, encoding: "utf8" }));
  const names = new Set((out.commands ?? out).map((c) => c.name));
  for (const n of [
    "group.add", "group.rename", "group.use", "account.add", "account.login.qr", "account.login.start", "account.login.verify", "account.login.resend",
    "account.login.open", "account.login.status", "account.login.cancel", "account.logout", "account.switch", "account.credentials", "plan.set", "plan.reset", "update",
    "update.status", "relay.connect", "relay.disconnect",
  ]) assert.ok(names.has(n), `命令表里缺 ${n}`);
  const cmd = findCommand("relay.disconnect");
  assert.equal(cmd.cli.usage, "vk relay disconnect");
  assert.deepEqual(cmd.http, { method: "POST", path: "/api/relay/disconnect" });
});

test("断开中转：清掉地址和令牌，没连过就说人话；已经入库的不受影响", async () => {
  const h = createCoreHandlers({ adapters: [], log: () => {} });
  assert.throws(() => h["relay.disconnect"](), /本来就没有连中转/);
  updateConfig({ relay: { url: "https://relay.example", pull_token: "tok-pull", push_token: "tok-push", interval_minutes: 7 } });
  const r = h["relay.disconnect"]();
  assert.equal(r.disconnected, true);
  const cfg = readConfig().relay;
  assert.equal(cfg.url, null);
  assert.equal(cfg.pull_token, null);
  assert.equal(cfg.push_token, null);
  assert.equal(cfg.interval_minutes, 7, "拉取间隔这类偏好留着");
  assert.equal(h["relay.status"]().configured, false);
  assert.deepEqual(leaks(r.message), []);
});

test("现在更新：HTTP 上 update 不带参数就是更新；空闲检查在先，不空闲时说人话原因", async () => {
  let applied = 0;
  const h = createCoreHandlers({ adapters: [], log: () => {}, updater: { apply: async () => { applied++; return { started: true, message: "已开始更新" }; } }, loginsOpen: () => 0 });
  assert.equal((await h.update({})).started, true);
  assert.equal(applied, 1);
  const busy = createCoreHandlers({ adapters: [], log: () => {}, updater: { apply: async () => ({ started: true }) }, loginsOpen: () => 2 });
  await assert.rejects(busy.update({}), (e) => /现在不适合更新：有 2 个登录窗口开着/.test(e.message) && leaks(e.message).length === 0);
  const none = createCoreHandlers({ adapters: [], log: () => {} });
  await assert.rejects(none.update({}), (e) => leaks(e.message).length === 0);
});
