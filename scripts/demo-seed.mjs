#!/usr/bin/env node
// 演示数据（#180）：在指定的 HIFABU_HOME 里造出今天页、作品页的典型数据，供验收与演示用。
//
//   HIFABU_HOME=$(mktemp -d) node scripts/demo-seed.mjs        # 或：HIFABU_HOME=... vk demo seed
//
// 造出来的东西：
//   · 待确认：一个长片作品（含一支长片 + 一支短片，各发两个平台）
//   · 已发布：三条，24 小时播放分别是平时的 4 倍（好）、1 倍（正常）、0.3 倍（差）
//   · 出问题：一条 failed，带 error_code 与人话
// 账号全是假的，且 last_checked_at 都写成「刚刚」——哪怕有人误起了不带 --offline 的服务，
// 调度器也不会马上给它们排体检。
//
// 安全：必须显式给 HIFABU_HOME。不给就会写进真实的家目录，那正是这个脚本要避免的事。

import { readEnv } from "../packages/core/src/env.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOUR = 3600e3;
const DAY = 24 * HOUR;

async function load() {
  const core = await import("../packages/core/src/index.mjs");
  const { createCoreHandlers } = await import("../packages/core/src/handlers.mjs");
  const { createPublish } = await import("../packages/core/src/store.mjs");
  return { core, createCoreHandlers, createPublish };
}

export async function seedDemoAsync(options = {}) {
  if (!readEnv("HIFABU_HOME")) {
    throw new Error("没有设置 HIFABU_HOME：演示数据只能写进临时目录，例如 HIFABU_HOME=$(mktemp -d) vk demo seed");
  }
  return run(await load(), options.now ?? Date.now());
}

function run({ core, createCoreHandlers, createPublish }, now) {
  core.ensureDirs();
  core.migrate();
  const db = core.open();
  const handlers = createCoreHandlers({
    adapters: ["tiktok", "bilibili", "xiaohongshu"].map((platform) => ({ platform })),
    log: () => {},
  });

  const dir = join(core.paths().state, "demo-assets");
  mkdirSync(dir, { recursive: true });
  const asset = (name) => {
    const p = join(dir, name);
    writeFileSync(p, "demo video placeholder");
    return p;
  };

  const group = handlers["group.add"]({ name: "演示组" });
  const accounts = {};
  for (const [platform, name] of [["tiktok", "@demo_tt"], ["bilibili", "@demo_bili"], ["xiaohongshu", "@demo_xhs"]]) {
    accounts[platform] = handlers["account.add"]({ platform, name, group: group.name }).id;
  }
  // 假账号不需要被体检：写成刚检查过，且登录态正常。
  db.prepare("UPDATE account SET last_checked_at = ?, last_ok_at = ?, state = 'ok' WHERE group_id IS NOT NULL").run(now, now);

  const addWork = (title, cuts) =>
    handlers["work.add"]({
      title,
      source: join(dir, `${title}.json`),
      cuts: cuts.map(([cutTitle, file]) => ({ title: cutTitle, versions: [{ language: "zh", asset: asset(file) }] })),
    });

  // 1. 待确认：长片 + 短片，各发两个平台。
  const pending = addWork("演示·一期访谈", [["访谈长片", "long.mp4"], ["访谈短片", "short.mp4"]]);
  const created = [];
  for (const cut of pending.work.cuts) {
    for (const platform of ["tiktok", "bilibili"]) {
      created.push(createPublish({ workId: pending.id, cutId: cut.id, accountId: accounts[platform], scheduledAt: now + 2 * HOUR }));
    }
  }

  // 2. 已发布：先给每个账号铺 6 条平时的历史（24 小时播放 100），倍数才算得出来。
  let n = 0;
  const insertPublish = ({ workId, accountId, state, publishedAt, play, error }) => {
    const id = `demo_pub_${++n}`;
    db.prepare(
      `INSERT INTO publish (id, work_id, account_id, state, published_at, error_code, error_message, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, workId, accountId, state, publishedAt ?? null, error?.code ?? null, error?.message ?? null, now - DAY, now - DAY);
    if (play != null) {
      db.prepare("INSERT INTO snapshot (id, publish_id, captured_at, source, status, metrics_json) VALUES (?,?,?,?,?,?)").run(
        `demo_snap_${n}`, id, publishedAt + DAY, "api", "ok", JSON.stringify({ play }),
      );
    }
    return id;
  };
  const history = addWork("演示·历史作品", [["历史", "history.mp4"]]);
  for (const accountId of [accounts.tiktok, accounts.bilibili, accounts.xiaohongshu]) {
    for (let i = 0; i < 6; i++) insertPublish({ workId: history.id, accountId, state: "published", publishedAt: now - (30 - i) * DAY, play: 100 });
  }
  const good = addWork("演示·爆款", [["爆款", "good.mp4"]]);
  const normal = addWork("演示·平稳", [["平稳", "normal.mp4"]]);
  const poor = addWork("演示·冷清", [["冷清", "poor.mp4"]]);
  insertPublish({ workId: good.id, accountId: accounts.tiktok, state: "published", publishedAt: now - 3 * DAY, play: 400 });
  insertPublish({ workId: normal.id, accountId: accounts.bilibili, state: "published", publishedAt: now - 3 * DAY, play: 100 });
  insertPublish({ workId: poor.id, accountId: accounts.xiaohongshu, state: "published", publishedAt: now - 3 * DAY, play: 30 });

  // 3. 出问题。
  const broken = addWork("演示·发布失败", [["失败稿", "broken.mp4"]]);
  insertPublish({
    workId: broken.id,
    accountId: accounts.tiktok,
    state: "failed",
    error: { code: "demo_failed", message: "演示用的失败：素材转码超时，可以重试" },
  });

  const works = db.prepare("SELECT COUNT(*) n FROM work").get().n;
  const publishes = db.prepare("SELECT COUNT(*) n FROM publish").get().n;
  return { ok: true, home: core.paths().root, group: group.name, works, publishes, pending_confirm: created.length };
}

// 直接运行：node scripts/demo-seed.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seedDemoAsync()
    .then((d) => console.log(JSON.stringify(d)))
    .catch((err) => {
      console.error(`出错：${err.message}`);
      process.exit(1);
    });
}
