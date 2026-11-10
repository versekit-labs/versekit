// 总览聚合与 bootstrap 快照（issue #23；验收 ACC-overview-01 / 02、ACC-matrix-01）。
//
// 原型 docs/design/store.js 里的 aggregate() / conflicts() / counts() 已经在 schedule.mjs 落地；
// 这里补上剩下的那一半：当前组、组列表、账号、数据新鲜度、口径化计数，以及跨组只读矩阵。
// Web 和 CLI 都只读这一份结果，页面数字、`vk --json` 与 `/api` 才不会各算一遍。
//
// 计数口径（ACC-overview-01 的「数字带口径」）：
//   works     = 至少有一条平台发布的 work 去重计数
//   publishes = publish 行数；同一作品每上一个平台账号算 1 条
// 一个作品发三端 = 1 个作品 + 3 条平台发布，这两个数不能互相替代。

import { open } from "./index.mjs";
import { currentGroup, listAccounts, listGroups } from "./store.mjs";

/** 1 小时内采集算「新鲜」；超过 24 小时仍未采集算「坏掉」。与总览页的 5/8 口径一致。 */
export const FRESH_AFTER_MS = 3600e3;
export const STALE_AFTER_MS = 24 * 3600e3;

export const COUNT_DEFINITIONS = {
  works: "作品数：至少有一条平台发布的 work 去重计数（一个作品发三端仍然只算 1 个作品）",
  publishes: "平台发布数：publish 行数；同一作品每上一个平台账号算 1 条",
  publishedPublishes: "已发布成功的平台发布数：state 为 published / published_limited 的行",
};

/** 矩阵固定五列。设计稿用 xhs / bili 简称，真实账号用 xiaohongshu / bilibili，别名在这里收口。 */
export const MATRIX_COLUMNS = [
  { platform: "xiaohongshu", label: "小红书", aliases: ["xhs"] },
  { platform: "douyin", label: "抖音", aliases: [] },
  { platform: "bilibili", label: "B站", aliases: ["bili"] },
  { platform: "youtube", label: "YouTube", aliases: [] },
  { platform: "tiktok", label: "TikTok", aliases: [] },
];

const PLATFORM_ALIASES = new Map(
  MATRIX_COLUMNS.flatMap((c) => [[c.platform, c.platform], ...c.aliases.map((a) => [a, c.platform])]),
);

const asPlatform = (platform) => PLATFORM_ALIASES.get(String(platform)) ?? String(platform);

const zeroCounts = () => ({ works: 0, publishes: 0, publishedPublishes: 0 });

function latestCollection(accountId) {
  return (
    open()
      .prepare(
        `SELECT s.captured_at, s.source, s.status
           FROM snapshot s JOIN publish p ON p.id = s.publish_id
          WHERE p.account_id = ?
          ORDER BY s.captured_at DESC LIMIT 1`,
      )
      .get(accountId) ?? null
  );
}

function latestPublish(accountId) {
  const row =
    open()
      .prepare(
        `SELECT p.id, p.state, p.published_at, p.updated_at, w.title
           FROM publish p JOIN work w ON w.id = p.work_id
          WHERE p.account_id = ?
          ORDER BY COALESCE(p.published_at, p.updated_at) DESC LIMIT 1`,
      )
      .get(accountId) ?? null;
  if (!row) return null;
  return {
    publishId: row.id,
    state: row.state,
    at: row.published_at ?? row.updated_at,
    title: row.title,
  };
}

/**
 * 一个账号的数据新鲜度。只看「最近一次采集」与账号是否还能采：
 *  · expired / banned → bad（采集已经停了，有旧数据也不可信）
 *  · 还没采过         → unknown（新账号，不假装新鲜）
 *  · ≤ 1h / ≤ 24h / 更久 → ok / warn / bad
 * 返回结构是页面与 CLI 共用的同一份，不在前端再判一次。
 */
export function freshnessOf({ state, lastCollectedAt }, now = Date.now()) {
  if (state === "expired" || state === "banned") {
    return {
      level: "bad",
      reason: "账号已失效，发布与采集暂停",
      lastCollectedAt: lastCollectedAt ?? null,
      freshAfterMs: FRESH_AFTER_MS,
      staleAfterMs: STALE_AFTER_MS,
    };
  }
  if (lastCollectedAt == null) {
    return {
      level: "unknown",
      reason: "还没有采集数据",
      lastCollectedAt: null,
      freshAfterMs: FRESH_AFTER_MS,
      staleAfterMs: STALE_AFTER_MS,
    };
  }
  const age = now - Number(lastCollectedAt);
  if (age <= FRESH_AFTER_MS) {
    return {
      level: "ok",
      reason: "1 小时内采集",
      lastCollectedAt: Number(lastCollectedAt),
      freshAfterMs: FRESH_AFTER_MS,
      staleAfterMs: STALE_AFTER_MS,
    };
  }
  if (age <= STALE_AFTER_MS) {
    return {
      level: "warn",
      reason: "超过 1 小时未采集",
      lastCollectedAt: Number(lastCollectedAt),
      freshAfterMs: FRESH_AFTER_MS,
      staleAfterMs: STALE_AFTER_MS,
    };
  }
  return {
    level: "bad",
    reason: "超过 24 小时未采集",
    lastCollectedAt: Number(lastCollectedAt),
    freshAfterMs: FRESH_AFTER_MS,
    staleAfterMs: STALE_AFTER_MS,
  };
}

/**
 * 账号读模型：原始账号字段 + 组名 + 最近采集 / 最近发布 + 新鲜度。
 * account.list 与 bootstrap.accounts 都走这里，所以「新鲜度面板与账号页一致」（ACC-overview-02）
 * 不是靠两张页面各自算，而是同一份对象。
 */
export function listAccountViews({ groupId = null, now = Date.now() } = {}) {
  const groups = new Map(listGroups().map((g) => [g.id, g]));
  return listAccounts({ groupId }).map((row) => {
    const collection = latestCollection(row.id);
    const publish = latestPublish(row.id);
    const freshness = freshnessOf({ state: row.state, lastCollectedAt: collection?.captured_at }, now);
    return {
      ...row,
      groupId: row.group_id ?? null,
      groupName: row.group_id ? (groups.get(row.group_id)?.name ?? null) : null,
      lastCollectedAt: collection?.captured_at ?? null,
      collection: collection ? { at: collection.captured_at, source: collection.source, status: collection.status } : null,
      lastPublishAt: publish?.at ?? null,
      lastPublish: publish,
      freshness,
    };
  });
}

/** 新鲜度摘要。fresh 只数「1 小时内采集」的账号，unknown 不算新鲜。 */
export function freshnessSummary(accounts) {
  const levels = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const account of accounts) levels[account.freshness?.level ?? "unknown"] += 1;
  return {
    total: accounts.length,
    fresh: levels.ok,
    stale: levels.warn,
    failing: levels.bad,
    unknown: levels.unknown,
    ratio: `${levels.ok}/${accounts.length}`,
    freshRatio: accounts.length ? levels.ok / accounts.length : 0,
    freshAfterMs: FRESH_AFTER_MS,
    staleAfterMs: STALE_AFTER_MS,
  };
}

// ------------------------------------------------------------------ 计数：作品 vs 平台发布

function totalCounts(conn) {
  const row = conn
    .prepare(
      `SELECT COUNT(DISTINCT work_id) AS works,
              COUNT(*) AS publishes,
              SUM(CASE WHEN state IN ('published','published_limited') THEN 1 ELSE 0 END) AS publishedPublishes
         FROM publish`,
    )
    .get();
  return {
    works: row.works ?? 0,
    publishes: row.publishes ?? 0,
    publishedPublishes: row.publishedPublishes ?? 0,
  };
}

function groupCountsMap(conn) {
  const map = new Map();
  const rows = conn
    .prepare(
      `SELECT a.group_id AS groupId,
              COUNT(DISTINCT p.work_id) AS works,
              COUNT(*) AS publishes,
              SUM(CASE WHEN p.state IN ('published','published_limited') THEN 1 ELSE 0 END) AS publishedPublishes
         FROM publish p JOIN account a ON a.id = p.account_id
        WHERE a.group_id IS NOT NULL
        GROUP BY a.group_id`,
    )
    .all();
  for (const row of rows) {
    map.set(row.groupId, {
      works: row.works ?? 0,
      publishes: row.publishes ?? 0,
      publishedPublishes: row.publishedPublishes ?? 0,
    });
  }
  return map;
}

function stateCounts(conn, groupId = null) {
  const rows = groupId
    ? conn
        .prepare(
          `SELECT p.state, COUNT(*) AS n
             FROM publish p JOIN account a ON a.id = p.account_id
            WHERE a.group_id = ? GROUP BY p.state`,
        )
        .all(groupId)
    : conn.prepare("SELECT state, COUNT(*) AS n FROM publish GROUP BY state").all();
  return Object.fromEntries(rows.sort((a, b) => a.state.localeCompare(b.state)).map((r) => [r.state, r.n]));
}

function countsFor(conn, groupId, groupMap, { all = false } = {}) {
  // 没有当前组时 counts 是 0，而不是偷偷回落到「全部组」——那会让首屏把别的组数字当成自己的。
  const base = all ? totalCounts(conn) : groupId ? (groupMap.get(groupId) ?? zeroCounts()) : zeroCounts();
  return {
    ...base,
    scope: all ? "all" : (groupId ?? null),
    byState: all ? stateCounts(conn, null) : groupId ? stateCounts(conn, groupId) : {},
    definitions: COUNT_DEFINITIONS,
  };
}

// ------------------------------------------------------------------ 跨组矩阵

/**
 * 跨组只读矩阵：每组 × 五平台的账号格。数据在 core 算好，Web 只渲染；
 * readOnly 是响应的一部分，页面不用再记「这里不能改」。
 */
export function buildMatrix(groups, accounts) {
  const byGroup = new Map();
  for (const account of accounts) {
    if (!account.group_id) continue;
    if (!byGroup.has(account.group_id)) byGroup.set(account.group_id, []);
    byGroup.get(account.group_id).push(account);
  }

  return {
    readOnly: true,
    note: "跨组矩阵只读：要改账号请进入对应账号组",
    columns: MATRIX_COLUMNS.map(({ platform, label, aliases }) => ({ platform, label, aliases })),
    groups: groups.map((group) => {
      const list = byGroup.get(group.id) ?? [];
      const cells = MATRIX_COLUMNS.map((column) => {
        const account = list.find((a) => asPlatform(a.platform) === column.platform) ?? null;
        return {
          platform: column.platform,
          label: column.label,
          filled: Boolean(account),
          account: account
            ? {
                id: account.id,
                accountId: account.id,
                platform: account.platform,
                handle: account.handle,
                state: account.state,
                lastCollectedAt: account.lastCollectedAt,
                freshness: account.freshness,
              }
            : null,
        };
      });
      return {
        id: group.id,
        groupId: group.id,
        name: group.name,
        accountCount: list.length,
        filled: cells.filter((c) => c.filled).length,
        slots: MATRIX_COLUMNS.length,
        cells,
      };
    }),
    totals: {
      groups: groups.length,
      accounts: accounts.filter((a) => a.group_id).length,
    },
  };
}

/**
 * bootstrap：一次拉齐外壳需要的快照。
 *
 * `accounts` 是全部账号（含未分组），每个带 groupId / groupName；页面按 `current` 过滤即可，
 * 跨组矩阵与汇总也复用同一份账号对象。`counts` / `freshness` 是当前组口径；
 * `rollup` 是跨组汇总且显式只读（ACC-overview-01）。
 */
export function buildBootstrap({ now = Date.now() } = {}) {
  const conn = open();
  const groups = listGroups();
  const current = currentGroup();
  const accounts = listAccountViews({ now });
  const groupMap = groupCountsMap(conn);
  const currentAccounts = current ? accounts.filter((a) => a.group_id === current.id) : [];

  return {
    current: current ? { id: current.id, name: current.name } : null,
    groups: groups.map((group) => ({
      ...group,
      counts: groupMap.get(group.id) ?? zeroCounts(),
      freshness: freshnessSummary(accounts.filter((a) => a.group_id === group.id)),
    })),
    accounts,
    freshness: freshnessSummary(currentAccounts),
    counts: countsFor(conn, current?.id ?? null, groupMap),
    rollup: {
      readOnly: true,
      note: "跨组汇总只读：这里只汇总数字，不改任何组的数据",
      counts: countsFor(conn, null, groupMap, { all: true }),
      freshness: freshnessSummary(accounts),
    },
    matrix: buildMatrix(groups, accounts),
  };
}
