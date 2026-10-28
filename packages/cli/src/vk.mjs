#!/usr/bin/env node
// vk — versekit CLI. Default output is JSON (agents and scripts are the primary caller);
// --human switches to the layout a person reads.
//
// Reads run against the database directly (doctor must work when the daemon is dead); writes go
// through the daemon over the unix socket. That split is the whole point of the architecture:
// one writer, many faces.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { paths, migrate, open, getMeta, isInitialised } from "../../core/src/index.mjs";
import { COMMANDS } from "../../core/src/commands.mjs";
import { loadAdapters, buildHandlers } from "../../core/src/adapters.mjs";
import { createCoreHandlers } from "../../core/src/handlers.mjs";
import { startDaemon } from "../../core/src/daemon.mjs";
import { statusSnapshot } from "../../core/src/store.mjs";
import { browserReady, PROFILE, PORT } from "../../driver-browser/src/index.mjs";
import { send, ensureDaemon } from "./client.mjs";

const PKG = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------- argv

const VALUE_FLAGS = new Set([
  "--to", "--name", "--handle", "--credential", "--title", "--schedule", "--visibility",
  "--range", "--publish", "--platform", "--concurrency", "--port", "--actor", "--origin",
]);

function parseArgv(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      if (VALUE_FLAGS.has(token)) flags[token] = argv[++i];
      else flags[token] = true;
    } else {
      pos.push(token);
    }
  }
  return { flags, pos };
}

const { flags, pos } = parseArgv(process.argv.slice(2));
const has = (flag) => Boolean(flags[flag]);
const val = (flag) => (typeof flags[flag] === "string" ? flags[flag] : undefined);
const human = has("--human");

const out = (data) => {
  if (!human) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
};
const line = (label, value) => `${label.padEnd(18)}${value}`;

/** "2h" / "30m" / "2026-11-01T10:00" / epoch ms → ms timestamp. */
function parseSchedule(raw) {
  if (raw == null) return null;
  const m = /^(\d+)(m|h|d)$/.exec(String(raw).trim());
  if (m) {
    const unit = { m: 60e3, h: 3600e3, d: 24 * 3600e3 }[m[2]];
    return Date.now() + Number(m[1]) * unit;
  }
  if (/^\d{10,}$/.test(String(raw))) return Number(raw);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) throw new Error(`看不懂的定时时间：${raw}（用 2h / 30m / 2026-11-01T10:00）`);
  return at;
}

// ---------------------------------------------------------------- commands

function cmdInit() {
  const p = migrate();
  const config = existsSync(p.configFile) ? JSON.parse(readFileSync(p.configFile, "utf8")) : null;
  if (!config) {
    writeFileSync(
      p.configFile,
      JSON.stringify(
        {
          version: 1,
          created_at: new Date().toISOString(),
          defaults: { mode: "auto", visibility: "public", collect: { offsets: ["1h", "6h", "24h", "3d", "7d", "daily"] } },
          browser: { profile: "${state}/browser", cdp_port: 9333 },
          channel: { feishu: { enabled: false } },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
  const result = {
    ok: true,
    root: p.root,
    db: p.db,
    config: p.configFile,
    schema_version: getMeta("schema_version"),
    next: ["vk doctor", "vk account add tiktok --name 主号", "vk channel bind feishu"],
  };
  if (human) {
    console.log(line("已初始化", p.state));
    console.log(line("数据库", p.db));
    console.log(line("配置", p.configFile));
    console.log("\n下一步：");
    result.next.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  } else out(result);
  return result;
}

function guard() {
  if (isInitialised()) return true;
  const msg = "还没有初始化：先运行 vk init";
  if (human) console.error(msg);
  else out({ ok: false, error: { code: "not_initialised", message: msg } });
  return false;
}

function cmdNow() {
  if (!guard()) return;
  const data = statusSnapshot();
  if (human) {
    console.log(`账号   ${data.accounts.total} 个（ok ${data.accounts.by_state.ok} · 需处理 ${data.accounts.by_state.expiring + data.accounts.by_state.expired}）`);
    for (const a of data.accounts.list) console.log(`       ${a.platform.padEnd(12)}${a.handle.padEnd(18)}${a.state}`);
    console.log(`队列   待跑 ${data.queue.queued} · 运行中 ${data.queue.running} · 失败 ${data.queue.failed}`);
    console.log(`发布   成功 ${data.publishes.published} · 部分 ${data.publishes.published_limited} · 待确认 ${data.publishes.needs_human}`);
    console.log(`通道   飞书 ${data.channel.feishu === "bound" ? "已连接" : "未配对"}`);
    if (!data.accounts.total) console.log("\n还没有账号：vk account add tiktok --name 主号");
  } else out({ ok: true, ...data });
  return data;
}

async function cmdDoctor() {
  const checks = [];
  const add = (id, ok, detail, next) => checks.push({ id, ok, detail, ...(next ? { next } : {}) });

  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  const nodeOk = major > 23 || (major === 23 && minor >= 0) || (major === 22 && minor >= 5) || major > 22;
  add("node", nodeOk, `v${process.versions.node}${nodeOk ? "" : "（需要 ≥22.5，node:sqlite）"}`, nodeOk ? null : "升级 Node 到 22.5 以上");

  const p = paths();
  const initialised = isInitialised();
  add("config_dir", existsSync(p.config), p.config, existsSync(p.config) ? null : "运行 vk init");
  add("database", initialised, initialised ? p.db : "还没有初始化", initialised ? null : "运行 vk init");
  add("schema_version", getMeta("schema_version") === "1", getMeta("schema_version") ?? "（无）", initialised ? null : "运行 vk init");

  const chrome = browserReady();
  add("chrome", chrome === null, chrome ?? "已找到 Chrome", chrome);
  add("browser_profile", existsSync(PROFILE), `${PROFILE}（CDP :${PORT}）`, existsSync(PROFILE) ? null : "首次扫码登录时会自动创建");
  add("daemon", existsSync(p.socket), existsSync(p.socket) ? `unix socket ${p.socket}` : "守护进程没在跑", existsSync(p.socket) ? null : "vk serve --detach（写命令会自动拉起）");

  let counts = { accounts: 0, expiring: 0, stuck: 0 };
  if (initialised) {
    const conn = open({ readonly: true });
    counts.accounts = conn.prepare("SELECT COUNT(*) n FROM account").get().n;
    counts.expiring = conn.prepare("SELECT COUNT(*) n FROM account WHERE state IN ('expiring','expired')").get().n;
    counts.stuck = conn.prepare("SELECT COUNT(*) n FROM run WHERE state='running' AND lease_until < ?").get(Date.now()).n;
  }
  add("accounts", counts.accounts > 0, `${counts.accounts} 个账号`, counts.accounts ? null : "vk account add <platform> --name 主号");
  add("account_health", counts.expiring === 0, counts.expiring ? `${counts.expiring} 个账号需要重新登录` : "全部正常", counts.expiring ? "vk account reauth <id>" : null);
  add("queue", counts.stuck === 0, counts.stuck ? `${counts.stuck} 个任务租约过期` : "没有卡住的任务", counts.stuck ? "重启守护进程（任务会自动重排）" : null);

  const loaded = await loadAdapters();
  const adapters = loaded.adapters.map((a) => a.platform);
  add(
    "adapters",
    adapters.length > 0 && loaded.errors.length === 0,
    adapters.length ? `${adapters.join(", ")}${loaded.errors.length ? `（${loaded.errors.length} 个加载失败）` : ""}` : "尚未接入任何平台适配器",
    adapters.length ? null : "按 docs/adapter-contract.md 实现第一个适配器",
  );

  // 没有 check() 的适配器只能靠发布/采集失败发现失效——这是产品承诺的一部分，要显式说出来。
  const passiveOnly = loaded.adapters.filter((a) => typeof a.adapter?.check !== "function").map((a) => a.platform);
  if (adapters.length) {
    add(
      "account_probe",
      passiveOnly.length === 0,
      passiveOnly.length ? `${passiveOnly.join("、")} 只能被动发现失效` : "所有适配器都能主动探测登录态",
      passiveOnly.length ? "给这些适配器补 check()；在此之前账号失效只会在发布/采集时暴露" : null,
    );
  }

  const feishu = initialised ? open({ readonly: true }).prepare("SELECT COUNT(*) n FROM channel_binding WHERE channel='feishu'").get().n > 0 : false;
  add("channel_feishu", feishu, feishu ? "已配对" : "未配对", feishu ? null : "vk channel bind feishu");

  const optional = ["adapters", "channel_feishu", "browser_profile", "accounts", "daemon", "account_probe"];
  const okCount = checks.filter((c) => c.ok).length;
  const data = { ok: checks.every((c) => c.ok || optional.includes(c.id)), passed: okCount, total: checks.length, checks };
  if (human) {
    for (const c of checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.id.padEnd(18)}${c.detail}`);
      if (!c.ok && c.next) console.log(`  ${" ".repeat(19)}→ ${c.next}`);
    }
    console.log(`\n${okCount}/${checks.length} 项通过`);
  } else out(data);
  return data;
}

/**
 * Two kinds of handlers share the daemon: the queue runner takes `run` rows (publish/collect),
 * the dispatcher takes commands (publish.retry …). Names never collide — the dot is the separator.
 */
function daemonHandlers(adapters, log) {
  return {
    ...buildHandlers(adapters, { log }),
    ...createCoreHandlers({ adapters, log }),
    "channel.test": () => ({ bound: false, next: "vk channel bind feishu" }),
  };
}

async function cmdServe() {
  if (!guard()) return;

  if (has("--detach")) {
    const result = await ensureDaemon();
    const data = { ok: true, started: result.started, socket: paths().socket };
    if (human) console.log(result.started ? "守护进程已启动" : "守护进程已经在跑");
    else out(data);
    return data;
  }

  const { adapters, errors } = await loadAdapters();
  const log = (m) => (human ? console.log(m) : console.error(m));
  const handlers = daemonHandlers(adapters, log);
  const daemon = await startDaemon({ handlers, log, port: Number(val("--port") ?? 8787) });

  log(`versekit 守护进程已启动：http://127.0.0.1:${daemon.port} · socket ${daemon.socketPath}`);
  log(`适配器 ${adapters.length} 个${adapters.length ? "：" + adapters.map((a) => a.platform).join(", ") : "（尚未安装）"}`);
  for (const e of errors) log(`适配器加载失败 ${e.dir}: ${e.message}`);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      log(`\n收到 ${sig}，正在停止`);
      await daemon.close();
      process.exit(0);
    });
  }
  await new Promise(() => {});
}

function cmdCommands() {
  const data = COMMANDS.map((c) => ({
    name: c.name,
    summary: c.summary,
    remote: c.remote,
    localOnly: c.localOnly === true,
    cli: c.cli?.usage ?? null,
    http: c.http ? `${c.http.method} ${c.http.path}` : null,
    card: c.card ? { label: c.card.label, style: c.card.style, confirm: c.card.confirm } : null,
    idempotent: typeof c.idempotent === "function",
    ttl_ms: c.ttlMs ?? null,
  }));
  if (human) for (const c of data) console.log(`${c.name.padEnd(18)}${c.remote ? "远程 ✓" : "远程 ✗"}  ${c.summary}`);
  else out(data);
  return data;
}

async function cmdAccount() {
  const sub = pos[1];
  const log = (m) => human && console.log(m);
  if (sub === "list") {
    const data = await send("account.list", {}, { log });
    if (human) {
      if (!data.accounts.length) console.log("还没有账号：vk account add tiktok --name 主号");
      for (const a of data.accounts) console.log(`${a.id.padEnd(14)}${a.platform.padEnd(12)}${a.handle.padEnd(18)}${a.state}`);
    } else out(data);
    return data;
  }
  if (sub === "add") {
    const platform = pos[2];
    if (!platform) throw new Error("用法：vk account add <platform> --name <名字>");
    const name = val("--name") ?? platform;
    const data = await send(
      "account.add",
      {
        platform,
        name,
        ...(val("--handle") ? { handle: val("--handle") } : {}),
        ...(val("--credential") ? { credentialRef: val("--credential") } : {}),
      },
      { log },
    );
    if (human) console.log(`已添加 ${platform} ${name}（${data.id}）\n${data.next ?? ""}`);
    else out(data);
    return data;
  }
  if (sub === "mode") {
    const [, , accountId, mode] = pos;
    if (!accountId || !mode) throw new Error("用法：vk account mode <accountId> auto|manual");
    const data = await send("account.mode", { accountId, mode }, { log });
    if (human) console.log(`${accountId} → ${mode}`);
    else out(data);
    return data;
  }
  if (sub === "reauth") {
    const accountId = pos[2];
    if (!accountId) throw new Error("用法：vk account reauth <accountId>");
    const data = await send("account.reauth", { accountId }, { log });
    if (human) console.log(data.next ?? "已开始");
    else out(data);
    return data;
  }
  throw new Error("用法：vk account list | add | mode | reauth");
}

async function cmdPublish() {
  const sub = pos[1];
  const log = (m) => human && console.log(m);

  if (["retry", "release", "confirm"].includes(sub)) {
    const publishId = pos[2];
    if (!publishId) throw new Error(`用法：vk publish ${sub} <publishId>`);
    const data = await send(`publish.${sub}`, { publishId }, { log });
    if (human) console.log(`${publishId} → ${data.state}`);
    else out(data);
    return data;
  }

  const asset = sub;
  if (!asset) throw new Error("用法：vk publish <素材> --to tiktok,bilibili [--title] [--schedule 2h] [--visibility] [--dry-run]");
  const to = (val("--to") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) throw new Error("要指定平台：--to tiktok,bilibili");
  const args = {
    asset,
    to,
    ...(val("--title") ? { title: val("--title") } : {}),
    ...(val("--visibility") ? { visibility: val("--visibility") } : {}),
    ...(parseSchedule(val("--schedule")) ? { schedule: parseSchedule(val("--schedule")) } : {}),
    ...(has("--dry-run") ? { dryRun: true } : {}),
  };
  const data = await send("publish.create", args, { log });
  if (human) {
    if (data.dryRun) {
      console.log(`试运行：${data.work.title} → ${data.publishes.map((p) => p.platform).join("、")}`);
      console.log("没有写入任何行，也没有对外动作");
    } else {
      console.log(`已创建 ${data.publishes.length} 条发布：`);
      for (const p of data.publishes) console.log(`  ${p.platform.padEnd(12)}${p.handle.padEnd(18)}${p.publishId}`);
    }
  } else out(data);
  return data;
}

async function cmdCollect() {
  const data = await send("collect.now", { ...(val("--platform") ? { platform: val("--platform") } : {}), ...(val("--publish") ? { publishId: val("--publish") } : {}) }, { log: (m) => human && console.log(m) });
  if (human) console.log(`已排 ${data.queued} 个采集任务`);
  else out(data);
  return data;
}

async function cmdStats() {
  const sub = pos[1];
  if (sub !== "works") throw new Error("用法：vk stats works [--range 7d] [--publish <id>]");
  const data = await send("stats.works", { range: val("--range") ?? "all", ...(val("--publish") ? { publishId: val("--publish") } : {}) });
  if (human) {
    const rows = data.rows.filter((r) => r.latest);
    if (!rows.length) console.log("还没有采集到数据：vk collect --now");
    for (const r of rows) console.log(`${r.platform.padEnd(10)}${String(r.title).slice(0, 24).padEnd(26)}${JSON.stringify(r.latest.metrics)}`);
  } else out(data);
  return data;
}

function usage() {
  console.log(
    [
      "vk — versekit CLI（默认 JSON，--human 给人看）",
      "",
      "用法:",
      "  vk init",
      "  vk now [--human]",
      "  vk doctor [--human]",
      "  vk serve [--detach] [--port 8787]",
      "  vk commands [--human]",
      "  vk account list | add <platform> --name <名字> | mode <id> auto|manual | reauth <id>",
      "  vk publish <素材> --to tiktok,bilibili [--title] [--schedule 2h] [--visibility] [--dry-run]",
      "  vk publish retry|release|confirm <publishId>",
      "  vk collect [--now] [--platform <p>]",
      "  vk stats works [--range 7d]",
      "  vk --version",
      "",
      "命令总表由 packages/core/src/commands.mjs 派生（与 Web、飞书卡片同源）。",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------- dispatch

const cmd = pos[0];

try {
  if (!cmd || has("--help") || has("-h")) usage();
  else if (has("--version") || has("-v")) console.log(PKG.version);
  else if (cmd === "init") cmdInit();
  else if (cmd === "now") cmdNow();
  else if (cmd === "doctor") await cmdDoctor();
  else if (cmd === "commands") cmdCommands();
  else if (cmd === "serve") await cmdServe();
  else if (cmd === "account") await cmdAccount();
  else if (cmd === "publish") await cmdPublish();
  else if (cmd === "collect") await cmdCollect();
  else if (cmd === "stats") await cmdStats();
  else {
    console.error(`未知命令：${cmd}\n`);
    usage();
    process.exit(2);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (human) console.error(`出错：${message}`);
  else out({ ok: false, error: { code: err.code ?? "error", message } });
  process.exit(1);
}
