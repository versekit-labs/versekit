#!/usr/bin/env node
// 适配器契约门禁（BLUEPRINT §3.9「adapter-contract」/ ARCHITECTURE §12 / docs/adapter-contract.md §2）。
//
// 每个 packages/adapter-<platform> 都要过四关，缺一关就是「装上了但发不出去」：
//
//   1. loadAdapters() 能加载它，validateAdapter() 认它的形状（platform / ready / capabilities）。
//   2. ready() 只回答 null（可用）或非空字符串（人能看懂的缺失原因）。
//      ready() 抛错、返回 ""、返回 false 都是产品缺陷——账号墙会显示一片空白。
//   3. ready() 为 null 时，在一个全新的 VK_HOME（mkdtempSync）里造 account / work / publish
//      + 真实的临时素材文件，调 publish({ publishId, dryRun: true })。
//      dry-run 是「发布前彩排」：必须返回 { dryRun: true }，且不产生任何副作用。
//   4. 副作用断言：publish 状态不变、external_id 不变、不新增 snapshot、不联网。
//      联网用 fetch 断言桩拦截——dry-run 里出现任何一次 fetch，门禁就红。
//
// ready() 非 null（例如没装 biliup）的适配器：显式打印适配器自己给的原因再跳过。
// 静默跳过等于门禁不存在——CI 日志里必须能看见「为什么这条没测」。
//
// 不联网、不调 biliup、不起 Chrome：脚本只做本地文件与数据库操作；dry-run 分支按契约
// 在对外动作之前返回。真实适配器的这条路径由上面第 3、4 关钉住。
//
// 用法：node scripts/ci/adapter-contract.mjs   （npm run check:contract）

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { close, migrate, open } from "../../packages/core/src/index.mjs";
import { loadAdapters } from "../../packages/core/src/adapters.mjs";
import { validateAdapter } from "../../packages/core/src/contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NAME = "适配器契约门禁 adapter-contract";

const results = [];
const skipped = [];
const ok = (id, detail) => results.push({ id, ok: true, detail });
const bad = (id, detail, fix) => results.push({ id, ok: false, detail, fix });

// ---------------------------------------------------------------- 1. 加载

let loaded = { adapters: [], errors: [] };
try {
  loaded = await loadAdapters({ root: join(ROOT, "packages") });
} catch (err) {
  bad("contract.load", `loadAdapters() 抛错：${err.message}`, "适配器发现不能因为一个坏包就整体失败；检查 packages/core/src/adapters.mjs 的目录遍历");
}

if (loaded.errors.length) {
  const detail = loaded.errors.map((e) => `${e.dir}: ${e.message}`).join("；");
  bad("contract.load.errors", `${loaded.errors.length} 个适配器包加载失败：${detail}`, "每个 adapter-* 目录必须有可 import 的 package.json exports，并 export default 适配器对象");
} else {
  ok("contract.load", `${loaded.adapters.length} 个适配器包加载成功`);
}

if (loaded.adapters.length === 0 && loaded.errors.length === 0) {
  console.log(`▸ ${NAME}`);
  console.log("  ⊘ packages/adapter-* 下还没有适配器包，门禁无对象");
  console.log(`\n✓ ${NAME}通过（0 个适配器）`);
  process.exit(0);
}

// ---------------------------------------------------------------- 每个适配器

/** 读一次现场：dry-run 前后各读一次，用来证明"没变"。 */
function snapshotOf(db, publishId) {
  const row = db.prepare("SELECT state, external_id, external_url FROM publish WHERE id = ?").get(publishId);
  if (!row) throw new Error(`fixture 里的发布不见了：${publishId}`);
  const snapshots = db.prepare("SELECT COUNT(*) AS n FROM snapshot WHERE publish_id = ?").get(publishId).n;
  return { state: row.state, external_id: row.external_id, external_url: row.external_url, snapshots };
}

for (const info of loaded.adapters) {
  const platform = info.platform;
  const label = `adapter-${platform}`;

  // 1) 形状：loadAdapters 已经校验过，这里再显式跑一次 validateAdapter，
  //    因为门禁要独立于 loader 的宽容度——契约测试用严格的那份实现。
  try {
    validateAdapter(info.adapter, label);
    ok(`contract.shape.${platform}`, `${label} 通过 validateAdapter（publish=${info.publish} / collect=${info.collect}）`);
  } catch (err) {
    bad(`contract.shape.${platform}`, `${label} 不满足适配器契约：${err.message}`, "按 docs/adapter-contract.md §2 补齐 platform / ready() / capabilities；形状错误必须在 CI 红，不能等用户装上了才发现");
    continue;
  }

  // 2) ready()：null 或非空字符串，别的都不行。
  let ready;
  try {
    ready = info.adapter.ready();
  } catch (err) {
    bad(`contract.ready.${platform}`, `${label} 的 ready() 抛错：${err.message}`, "ready() 只做本地探测（二进制/配置/登录文件是否存在），不许联网、不许抛错；用返回值说人话");
    continue;
  }

  if (ready === null) {
    ok(`contract.ready.${platform}`, `${label} 的 ready() = null（可用）`);
  } else if (typeof ready === "string" && ready.trim() !== "") {
    ok(`contract.ready.${platform}`, `${label} 的 ready() 返回了缺失原因，按约定跳过发布分支`);
    skipped.push({ platform, label, reason: ready });
    continue;
  } else {
    bad(
      `contract.ready.${platform}`,
      `${label} 的 ready() 返回 ${JSON.stringify(ready)}，只允许 null 或非空字符串`,
      "null = 可用；否则返回一句人能照做的缺失原因（例如「B站 未配置：没有安装 biliup」）。空字符串/false 会让账号墙显示空白",
    );
    continue;
  }

  // 3) fixture：独立 VK_HOME，真素材文件，真 account/work/publish 行。
  const home = mkdtempSync(join(tmpdir(), `vk-contract-${platform}-`));
  const originalHome = process.env.VK_HOME;
  const realFetch = globalThis.fetch;
  let db = null;
  try {
    process.env.VK_HOME = home;
    migrate();
    db = open();

    const asset = join(home, "asset.mp4");
    writeFileSync(asset, "versekit adapter-contract fixture：这不是真视频，只用来过 dry-run 的素材存在性检查\n");
    const credential = join(home, "cookies.json");
    writeFileSync(credential, JSON.stringify({ cookie_info: { cookies: [{ name: "SESSDATA", value: "contract-fixture" }] } }));

    const now = Date.now();
    db.prepare("INSERT INTO account (id, platform, handle, credential_ref, state, created_at) VALUES (?,?,?,?, 'ok', ?)").run(
      "acc_contract",
      platform,
      "@contract",
      credential,
      now,
    );
    db.prepare("INSERT INTO work (id, title, asset_path, meta_json, created_at) VALUES (?,?,?,?,?)").run(
      "work_contract",
      "契约门禁素材",
      asset,
      JSON.stringify({ title: "契约门禁标题", description: "dry-run fixture", tags: ["ci"] }),
      now,
    );
    // 种子状态用 auto_running：契约把 dry-run 定义成「发布前彩排」，此时发布已经被认领。
    // 用 queued 会让部分适配器（如 B站）在 dry-run 之前先做 queued → auto_running 迁移，
    // 那测到的就不是 dry-run 的无副作用，而是状态机本身。
    db.prepare(
      "INSERT INTO publish (id, work_id, account_id, mode, visibility, state, scheduled_at, created_at, updated_at) VALUES (?,?,?, 'auto', 'public', 'auto_running', ?, ?, ?)",
    ).run("pub_contract", "work_contract", "acc_contract", now + 3600e3, now, now);

    const before = snapshotOf(db, "pub_contract");

    // 4) 联网断言桩：dry-run 里任何 fetch 都是缺陷。
    let fetchCalls = 0;
    globalThis.fetch = () => {
      fetchCalls += 1;
      throw new Error("契约门禁：dry-run 不应联网（fetch 被拦截）");
    };

    let result = null;
    let thrown = null;
    try {
      result = await info.adapter.publish({ publishId: "pub_contract", dryRun: true });
    } catch (err) {
      thrown = err;
    } finally {
      globalThis.fetch = realFetch;
    }

    if (thrown) {
      bad(
        `contract.dry-run.${platform}`,
        `${label} 的 dry-run 抛错：${thrown.message}`,
        "dry-run 必须能在没有网络、没有平台凭据、没有真素材的情况下返回 { dryRun: true }；把对外动作放到 dryRun 分支之后",
      );
    } else if (result?.dryRun !== true) {
      bad(
        `contract.dry-run.${platform}`,
        `${label} 的 dry-run 返回值里 dryRun !== true：${JSON.stringify(result)?.slice(0, 200)}`,
        "publish({ dryRun: true }) 必须返回 { dryRun: true, ... }，调用方靠这个字段确认「没有真的发出去」",
      );
    } else {
      ok(`contract.dry-run.${platform}`, `${label} 的 dry-run 返回 dryRun === true`);
    }

    if (fetchCalls > 0) {
      bad(
        `contract.no-network.${platform}`,
        `${label} 的 dry-run 调用了 fetch ${fetchCalls} 次`,
        "dry-run 不能联网：上传/登录/查询都必须在 dryRun 分支之后；CI 没有网络凭据，联网会直接红",
      );
    } else {
      ok(`contract.no-network.${platform}`, `${label} 的 dry-run 没有发起任何 fetch`);
    }

    const after = snapshotOf(db, "pub_contract");
    if (after.state !== before.state || after.external_id !== before.external_id || after.external_url !== before.external_url) {
      bad(
        `contract.dry-run-state.${platform}`,
        `${label} 的 dry-run 改了 publish 行：state ${before.state} → ${after.state}，external_id ${JSON.stringify(before.external_id)} → ${JSON.stringify(after.external_id)}`,
        "dry-run 只能读：不许 transitionPublish、不许写 external_id/url；它不是「先跑一半」，而是「彩排一遍」",
      );
    } else {
      ok(`contract.dry-run-state.${platform}`, `${label} 的 dry-run 没有改 publish 状态（仍为 ${before.state}）`);
    }

    if (after.snapshots !== before.snapshots) {
      bad(
        `contract.dry-run-snapshot.${platform}`,
        `${label} 的 dry-run 新增了 ${after.snapshots - before.snapshots} 条 snapshot（${before.snapshots} → ${after.snapshots}）`,
        "快照只能由 collect 写；dry-run 新增快照会污染指标曲线，必须 0 新增",
      );
    } else {
      ok(`contract.dry-run-snapshot.${platform}`, `${label} 的 dry-run 没有新增 snapshot（${before.snapshots} 条）`);
    }
  } catch (err) {
    bad(
      `contract.fixture.${platform}`,
      `${label} 的 fixture / dry-run 执行失败：${err.message}`,
      "检查适配器是否把 VK_HOME 当唯一状态根；fixture 必须在空目录里自给自足，不依赖本机 ~/.config",
    );
  } finally {
    globalThis.fetch = realFetch;
    try {
      close();
    } catch {
      /* 已经关闭 */
    }
    if (originalHome === undefined) delete process.env.VK_HOME;
    else process.env.VK_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 输出

console.log(`▸ ${NAME}`);
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.id.padEnd(44)}${r.detail}`);
  if (!r.ok) console.log(`      ↳ 怎么修：${r.fix}`);
}
for (const s of skipped) {
  console.log(`  ⊘ 跳过 ${s.label}：${s.reason}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n✗ ${NAME}失败：${failed.length} 条断言未通过（通过 ${results.length - failed.length}，跳过适配器 ${skipped.length} 个）`);
  console.log("  复现：npm run check:contract");
  process.exit(1);
}
console.log(`\n✓ ${NAME}通过：${results.length} 条断言${skipped.length ? `，${skipped.length} 个适配器显式跳过（原因见上）` : ""}`);
