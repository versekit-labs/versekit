// 发布机的出口位置（#310，ACC-v3-egress-01…06）。
//
// 为什么要有它：2026-11-16 小红书封号的根因是账号平时在一个国家、发布时 IP 在另一个国家。
// 所以发布机要知道「平台看到我在哪」，和账号平时的位置不在同一个国家时，这个账号的自动发布先停下。
//
// 三件事分开，才能各自测：
//   · 探测：用账号的浏览器（不是 Node 的 fetch）打开回显地址读出口 IP。用户的代理多半是系统代理，
//     Chrome 走它、Node 不走；用 Node 探测会报「没有代理」，闸门形同虚设。
//   · 查位置：离线库，只在本机读（DB-IP City Lite → 国家城市；IPinfo Lite → 线路是不是机房）。
//     IP 不发给任何第三方；库文件不进仓库，放在状态目录，每月下载一次新的。
//   · 判断：账号基线（平时的国家）和当前出口比，不同国家 → 暂停；查不到（没库、探测失败）→ 不暂停并说明原因。
//
// 状态放 meta 表（不改表结构）：egress.state / egress.baselines / egress.waits / egress.geodb。

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { emit, open, paths } from "./index.mjs";
import * as store from "./store.mjs";
import { readConfig } from "./config.mjs";

// ---------------------------------------------------------------- 线路

/** 国内平台走国内线路看到的位置，海外平台走海外线路。 */
export const LINES = [
  {
    key: "cn",
    label: "国内平台看到",
    // 请求里不带任何账号或个人信息：只是一个 GET，返回自己的出口 IP。
    echo: "https://myip.ipip.net/json",
  },
  {
    key: "intl",
    label: "海外平台看到",
    echo: "https://api.ipify.org?format=json",
  },
];

export const CN_PLATFORMS = new Set(["bilibili", "douyin", "shipinhao", "xiaohongshu"]);
export const lineOf = (platform) => (CN_PLATFORMS.has(platform) ? "cn" : "intl");

export const PROBE_EVERY_MS = 10 * 60e3;
export const WAIT_PROBE_EVERY_MS = 60e3;
export const GEO_DB_MAX_AGE_MS = 30 * 864e5;

// ---------------------------------------------------------------- MMDB 读取（无依赖）
//
// 格式见 https://maxmind.github.io/MaxMind-DB/ ：二叉搜索树 + 数据区。DB-IP 与 IPinfo 的库都是这个格式。

const MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com")]);

function decoderOf(buf, base, pointerBase) {
  const read = (offset) => {
    let ctrl = buf[base + offset++];
    let type = ctrl >> 5;
    if (type === 1) {
      const ss = (ctrl >> 3) & 3;
      const vvv = ctrl & 7;
      let ptr;
      if (ss === 0) ptr = (vvv << 8) | buf[base + offset];
      else if (ss === 1) ptr = ((vvv << 16) | (buf[base + offset] << 8) | buf[base + offset + 1]) + 2048;
      else if (ss === 2) ptr = ((vvv << 24) | (buf[base + offset] << 16) | (buf[base + offset + 1] << 8) | buf[base + offset + 2]) + 526336;
      else ptr = buf.readUInt32BE(base + offset);
      offset += ss + 1;
      return [read(pointerBase + ptr)[0], offset];
    }
    if (type === 0) type = 7 + buf[base + offset++];
    let size = ctrl & 31;
    if (size === 29) size = 29 + buf[base + offset++];
    else if (size === 30) {
      size = 285 + buf.readUInt16BE(base + offset);
      offset += 2;
    } else if (size === 31) {
      size = 65821 + ((buf[base + offset] << 16) | (buf[base + offset + 1] << 8) | buf[base + offset + 2]);
      offset += 3;
    }
    const start = base + offset;
    switch (type) {
      case 2:
        return [buf.toString("utf8", start, start + size), offset + size];
      case 3:
        return [buf.readDoubleBE(start), offset + size];
      case 15:
        return [buf.readFloatBE(start), offset + size];
      case 5:
      case 6:
      case 8:
      case 9:
      case 10: {
        let v = 0n;
        for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(buf[start + i]);
        if (type === 8 && size === 4) v = BigInt(buf.readInt32BE(start));
        return [v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v, offset + size];
      }
      case 4:
        return [buf.subarray(start, start + size), offset + size];
      case 14:
        return [size !== 0, offset];
      case 7: {
        const map = {};
        for (let i = 0; i < size; i++) {
          const [k, o1] = read(offset);
          const [v, o2] = read(o1);
          map[k] = v;
          offset = o2;
        }
        return [map, offset];
      }
      case 11: {
        const arr = [];
        for (let i = 0; i < size; i++) {
          const [v, o] = read(offset);
          arr.push(v);
          offset = o;
        }
        return [arr, offset];
      }
      default:
        throw new Error(`MMDB 里有不认识的数据类型 ${type}`);
    }
  };
  return read;
}

/** 打开一个 mmdb（Buffer）。返回 { metadata, lookup(ip) }；lookup 查不到返回 null。 */
export function openMmdb(buf) {
  const at = buf.lastIndexOf(MARKER);
  if (at < 0) throw new Error("不是 MMDB 文件（找不到元数据标记）");
  const metaStart = at + MARKER.length;
  const metadata = decoderOf(buf, metaStart, 0)(0)[0];
  const { node_count: nodeCount, record_size: recordSize, ip_version: ipVersion } = metadata;
  if (![24, 28, 32].includes(recordSize)) throw new Error(`不支持的 MMDB record_size：${recordSize}`);
  const nodeBytes = (recordSize * 2) / 8;
  const treeSize = nodeCount * nodeBytes;
  const dataBase = treeSize + 16;
  const decodeAt = decoderOf(buf, dataBase, 0);

  const record = (node, bit) => {
    const o = node * nodeBytes;
    if (recordSize === 24) return bit ? buf.readUIntBE(o + 3, 3) : buf.readUIntBE(o, 3);
    if (recordSize === 32) return buf.readUInt32BE(o + (bit ? 4 : 0));
    return bit
      ? ((buf[o + 3] & 0x0f) << 24) | (buf[o + 4] << 16) | (buf[o + 5] << 8) | buf[o + 6]
      : ((buf[o + 3] & 0xf0) << 20) | (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2];
  };

  let v4Start = 0;
  if (ipVersion === 6) for (let i = 0; i < 96 && v4Start < nodeCount; i++) v4Start = record(v4Start, 0);

  return {
    metadata,
    lookup(ip) {
      const bytes = ipBytes(ip);
      if (!bytes) return null;
      if (bytes.length === 16 && ipVersion === 4) return null;
      let node = bytes.length === 4 && ipVersion === 6 ? v4Start : 0;
      const bits = bytes.length * 8;
      for (let i = 0; i < bits && node < nodeCount; i++) node = record(node, (bytes[i >> 3] >> (7 - (i & 7))) & 1);
      if (node <= nodeCount) return null;
      return decodeAt(node - nodeCount - 16)[0];
    },
  };
}

/** "1.2.3.4" / "2001:db8::1" → 字节；不合法返回 null。 */
export function ipBytes(ip) {
  const text = String(ip ?? "").trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    return parts.every((n) => n <= 255) ? Uint8Array.from(parts) : null;
  }
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return null;
  const [head, tail = null] = text.split("::");
  if (text.split("::").length > 2) return null;
  const groups = (s) => (s ? s.split(":") : []);
  const h = groups(head);
  const t = tail == null ? [] : groups(tail);
  if (tail == null && h.length !== 8) return null;
  const fill = 8 - h.length - t.length;
  if (fill < 0 || (tail != null && fill < 1)) return null;
  const all = [...h, ...Array(tail == null ? 0 : fill).fill("0"), ...t];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const out = new Uint8Array(16);
  all.forEach((g, i) => {
    out[i * 2] = parseInt(g, 16) >> 8;
    out[i * 2 + 1] = parseInt(g, 16) & 255;
  });
  return out;
}

// ---------------------------------------------------------------- 离线库

export const geoDir = () => join(paths().state, "geo");
export const GEO_FILES = { city: "dbip-city-lite.mmdb", asn: "ipinfo-lite.mmdb" };

const opened = new Map(); // 路径 → { mtimeMs, db }

function openFile(path) {
  if (!existsSync(path)) return null;
  const mtimeMs = statSync(path).mtimeMs;
  const hit = opened.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.db;
  const db = openMmdb(readFileSync(path));
  opened.set(path, { mtimeMs, db });
  return db;
}

/** 本机的两个库。读不开（坏文件）也当作没有，并把原因带出去，不抛。 */
export function loadGeoDb(dir = geoDir()) {
  const out = { city: null, asn: null, errors: [] };
  for (const [kind, name] of Object.entries(GEO_FILES)) {
    try {
      out[kind] = openFile(join(dir, name));
    } catch (err) {
      out.errors.push(`${name} 读不开：${err.message}`);
    }
  }
  return out;
}

const COUNTRY_ZH = {
  CN: "中国", HK: "中国香港", MO: "中国澳门", TW: "中国台湾", US: "美国", JP: "日本", KR: "韩国", SG: "新加坡", GB: "英国",
  DE: "德国", FR: "法国", CA: "加拿大", AU: "澳大利亚", NL: "荷兰", RU: "俄罗斯", IN: "印度", BR: "巴西", TH: "泰国", MY: "马来西亚",
  VN: "越南", ID: "印度尼西亚", PH: "菲律宾", AE: "阿联酋", IT: "意大利", ES: "西班牙", SE: "瑞典", CH: "瑞士", IE: "爱尔兰",
};
const pickName = (names) => names?.["zh-CN"] ?? names?.en ?? null;

// IPinfo Lite 记的是 AS 名而不是「机房」标记，所以按 AS 名 / 域名里的云厂商字样判断；只提醒、不暂停。
const HOSTING_WORDS = [
  "amazon", "aws", "google", "microsoft", "azure", "digitalocean", "linode", "akamai", "vultr", "ovh", "hetzner", "choopa", "leaseweb",
  "alibaba", "aliyun", "tencent", "huawei", "cloudflare", "oracle", "contabo", "m247", "datacamp", "colocrossing", "psychz", "quadranet",
  "hosting", "datacenter", "data center", "cloud", "server", "vps",
];
export const looksLikeDatacenter = (asnRecord) => {
  if (!asnRecord) return null;
  if (typeof asnRecord.is_hosting === "boolean") return asnRecord.is_hosting;
  const text = `${asnRecord.as_name ?? ""} ${asnRecord.as_domain ?? ""}`.toLowerCase();
  if (!text.trim()) return null;
  return HOSTING_WORDS.some((w) => text.includes(w));
};

/** IP → 国家城市与线路类型。库缺失的那一半是 null，调用方据此写「查不到」。 */
export function locate(ip, geo = loadGeoDb()) {
  const c = geo.city?.lookup(ip) ?? null;
  const a = geo.asn?.lookup(ip) ?? null;
  const countryCode = (c?.country?.iso_code ?? a?.country_code ?? null)?.toUpperCase() ?? null;
  return {
    ip,
    countryCode,
    country: countryCode ? (pickName(c?.country?.names) ?? COUNTRY_ZH[countryCode] ?? a?.country ?? countryCode) : null,
    city: pickName(c?.city?.names) ?? null,
    network: a?.as_name ?? null,
    datacenter: looksLikeDatacenter(a),
  };
}

/** 「美国 洛杉矶」；查不到城市只写国家；国家也查不到写「查不到」。 */
export const placeText = (line) => (line?.country ? (line.city ? `${line.country} ${line.city}` : line.country) : "查不到");

// ---------------------------------------------------------------- 探测

/** 从回显页的文字里取出第一个 IP（JSON 或纯文本都行）。 */
export function ipFromEcho(text) {
  const s = String(text ?? "");
  const v4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/.exec(s)?.[0];
  if (v4) return v4;
  return (s.match(/[0-9a-fA-F:]{3,45}/g) ?? []).find((t) => t.includes(":") && ipBytes(t)) ?? null;
}

/** 默认的取页面文字：用探测专用的 Chrome 打开回显地址（和账号浏览器同一个系统代理设置）。 */
export async function browserPageText(url) {
  const driver = await import("../../driver-browser/src/index.mjs");
  return driver.fetchPageText(url, { accountId: "egress-probe" });
}

let pageText = browserPageText;
/** 测试用：换掉取页面文字的实现。传 null 恢复默认。 */
export const setPageText = (fn) => {
  pageText = fn ?? browserPageText;
};

/**
 * 两条线路各探测一次。一条失败不拖垮另一条：失败的那条带 error（人话）和 code。
 * 绝不用 Node 的 fetch 访问回显地址——Node 不走用户的代理，报出来的会是真实出口。
 */
export async function probeEgress({ geo = loadGeoDb(), lines = LINES, getText = (url) => pageText(url), now = Date.now() } = {}) {
  const out = [];
  for (const line of lines) {
    try {
      const text = await getText(line.echo, line);
      const ip = ipFromEcho(text);
      if (!ip) throw Object.assign(new Error(`回显地址没有返回 IP：${String(text ?? "").slice(0, 80)}`), { code: "egress_echo_bad" });
      out.push({ key: line.key, label: line.label, echo: line.echo, ...locate(ip, geo) });
    } catch (err) {
      out.push({
        key: line.key,
        label: line.label,
        echo: line.echo,
        ip: null,
        error: `探测不出口位置：${err.message}`,
        code: err.code ?? "egress_probe_failed",
      });
    }
  }
  return { at: now, lines: out };
}

// ---------------------------------------------------------------- 判断

export const geoDbStatus = (dir = geoDir()) => {
  const meta = store.getEgressGeoDb() ?? {};
  const cityFile = join(dir, GEO_FILES.city);
  const asnFile = join(dir, GEO_FILES.asn);
  return {
    hasCity: existsSync(cityFile),
    hasAsn: existsSync(asnFile),
    cityDate: existsSync(cityFile) ? Math.round(statSync(cityFile).mtimeMs) : null,
    asnDate: existsSync(asnFile) ? Math.round(statSync(asnFile).mtimeMs) : null,
    checkedAt: meta.checkedAt ?? null,
    error: meta.error ?? null,
  };
};

const activeAccounts = (groupId = null) => store.listAccounts({ groupId }).filter((a) => !a.removed_at);

/**
 * 纯判断：每个账号现在的状态。
 *   · 没有基线 → adopt（第一次见到就把当时的国家当平时的位置）
 *   · 线路国家查不到（没库 / 探测失败）→ 不暂停，写原因
 *   · 国家不同 → 暂停
 */
export function judge({ accounts, state, baselines, waits = {} }) {
  const byKey = new Map((state?.lines ?? []).map((l) => [l.key, l]));
  return accounts.map((a) => {
    const key = lineOf(a.platform);
    const line = byKey.get(key) ?? null;
    const base = baselines[a.id] ?? null;
    const now = line?.countryCode ?? null;
    let status = "ok";
    let note = null;
    if (!state) {
      status = "unknown";
      note = "还没有探测过出口位置";
    } else if (!line || line.error) {
      status = "unknown";
      note = line?.error ?? "这条线路还没探测过";
    } else if (!now) {
      status = "unknown";
      note = "没有 IP 库，查不到国家，所以不会因为位置暂停发布";
    } else if (!base) {
      status = "adopt";
    } else if (base.country !== now) {
      status = "paused";
    }
    return {
      accountId: a.id,
      platform: a.platform,
      handle: a.handle,
      line: key,
      status,
      paused: status === "paused",
      waiting: status === "paused" && Boolean(waits[a.id]),
      baseline: base ? { country: base.country, countryName: base.countryName ?? base.country, city: base.city ?? null, at: base.at } : null,
      baselineSource: base?.source ?? null,
      now: line && !line.error ? { country: line.countryCode, countryName: line.country, city: line.city, ip: line.ip } : null,
      note,
    };
  });
}

/** 现在被暂停的账号 id（队列据此不领取它们的发布）。 */
export function pausedAccountIds() {
  const state = store.getEgress();
  if (!state) return [];
  const rows = judge({ accounts: activeAccounts(), state, baselines: store.getEgressBaselines(), waits: store.getEgressWaits() });
  return rows.filter((r) => r.paused).map((r) => r.accountId);
}

/**
 * 记下一次探测的结果：先把没有基线的账号定下基线，再对比出「刚暂停」「刚恢复」留事件。
 * 返回 { paused, resumed, adopted }。
 */
export function recordProbe(result) {
  const accounts = activeAccounts();
  const before = new Set(pausedAccountIds());
  store.setEgress(result);

  const baselines = store.getEgressBaselines();
  const adopted = [];
  for (const row of judge({ accounts, state: result, baselines, waits: {} })) {
    if (row.status !== "adopt") continue;
    // 兜底：这个账号没有登录时记下的位置（功能上线前登录的、或登录那一刻探测失败），先用这次探测的国家，标明来源。
    baselines[row.accountId] = { country: row.now.country, countryName: row.now.countryName, city: row.now.city, at: result.at, source: "first_probe" };
    adopted.push(row.accountId);
  }
  if (adopted.length) store.setEgressBaselines(baselines);

  const rows = judge({ accounts, state: result, baselines, waits: store.getEgressWaits() });
  const paused = rows.filter((r) => r.paused);
  const resumed = [...before].filter((id) => !paused.some((r) => r.accountId === id));

  // 回到基线的账号：不再「等发布机复查」。
  const waits = store.getEgressWaits();
  let waitsChanged = false;
  for (const id of resumed) if (waits[id]) { delete waits[id]; waitsChanged = true; }
  if (waitsChanged) store.setEgressWaits(waits);

  for (const r of paused.filter((p) => !before.has(p.accountId))) {
    emit({
      type: "egress.moved",
      severity: "warn",
      payload: { accountId: r.accountId, platform: r.platform, from: r.baseline, to: r.now, message: `出口位置变了：${r.baseline.countryName} → ${r.now.countryName}，这个账号先暂停自动发布` },
      dedupeKey: `egress.moved:${r.accountId}:${r.baseline.country}->${r.now.country}:${result.at}`,
    });
  }
  for (const id of resumed) {
    const a = accounts.find((x) => x.id === id);
    emit({
      type: "egress.restored",
      severity: "info",
      payload: { accountId: id, platform: a?.platform, message: "出口位置回到平时的国家，已恢复自动发布" },
      dedupeKey: `egress.restored:${id}:${result.at}`,
    });
  }
  for (const line of result.lines.filter((l) => l.error)) {
    emit({
      type: "egress.probe_failed",
      severity: "warn",
      payload: { line: line.key, code: line.code, message: line.error },
      dedupeKey: `egress.probe_failed:${line.key}:${line.code}:${Math.floor(result.at / 36e5)}`,
    });
  }
  return { paused: paused.map((r) => r.accountId), resumed, adopted };
}

/**
 * 账号登录成功的那一刻：把「这一刻的出口国家」记成这个账号平时的位置（ADR-0005 §8）。
 * 基线必须来自登录，不是第一次探测——否则账号在中国登录、第一次探测时发布机恰好开着代理（日本），
 * 基线就成了日本，闸门正好漏过去。重新登录（掉线后再登）会换成新的基线，等于所有者确认过新位置。
 * 这一刻查不到国家（没库、探测失败）时，原有基线原样保留，没有基线的等下一次探测补上，并在 view 里标明来源。
 */
export async function recordLogin(accountId, { at = Date.now(), ...options } = {}) {
  const account = store.getAccount(accountId);
  if (!account || account.removed_at) return { baseline: null };
  const result = await probeEgress({ geo: loadGeoDb(), ...options });
  const line = result.lines.find((l) => l.key === lineOf(account.platform));
  let baseline = null;
  if (line && !line.error && line.countryCode) {
    baseline = { country: line.countryCode, countryName: line.country, city: line.city, at, source: "login" };
    const baselines = store.getEgressBaselines();
    baselines[accountId] = baseline;
    store.setEgressBaselines(baselines);
    const waits = store.getEgressWaits();
    if (waits[accountId]) {
      delete waits[accountId];
      store.setEgressWaits(waits);
    }
    emit({
      type: "egress.login_baseline",
      severity: "info",
      payload: { accountId, platform: account.platform, country: baseline.country, message: `登录成功：以 ${baseline.countryName} 作为这个账号平时的位置` },
      dedupeKey: `egress.login_baseline:${accountId}:${at}`,
    });
  } else {
    // 查不到国家（没有 IP 库 / 探测失败）：原基线保留，但要留现场，不静默（#325）。
    emit({
      type: "egress.probe_failed",
      severity: "warn",
      payload: { line: "login", accountId, platform: account.platform, code: line?.code ?? "egress_no_geo", message: line?.error ?? "登录成功但查不到出口国家（没有 IP 库），没有记录这个账号平时的位置，等下一次探测补上" },
      dedupeKey: `egress.login_baseline_skipped:${accountId}:${at}`,
    });
  }
  recordProbe(result);
  return { baseline };
}

/** 探测一次并记下来。 */
export async function probeNow(options = {}) {
  const result = await probeEgress({ geo: loadGeoDb(), ...options });
  return { result, ...recordProbe(result) };
}

/** 页面和 CLI 读的一份：线路、IP 库状态、每个账号的判断、暂停数。 */
export function view({ groupId = null } = {}) {
  const state = store.getEgress();
  const geo = geoDbStatus();
  const accounts = judge({ accounts: activeAccounts(groupId), state, baselines: store.getEgressBaselines(), waits: store.getEgressWaits() });
  const paused = accounts.filter((a) => a.paused);
  const lines = (state?.lines ?? []).map((l) => ({ ...l, place: placeText(l) }));
  const notes = [];
  if (!geo.hasCity) notes.push("没有 IP 库（国家城市），出口位置写「查不到」，不会因为位置暂停发布。发布机联网后会自动下载。");
  if (geo.error) notes.push(`IP 库上次没下载成功，继续用旧库：${geo.error}`);
  for (const l of lines) if (l.error) notes.push(`${l.label}：${l.error}`);
  const approx = accounts.filter((a) => a.baselineSource === "first_probe").length;
  if (approx) notes.push(`${approx} 个账号平时的位置是按第一次探测定的（没有登录时的记录）；重新登录一次会改成登录时的位置。`);
  return {
    probedAt: state?.at ?? null,
    lines,
    // 两条线路的出口国家不一样：系统页两条都写；一样就只写一条。
    split: lines.length === 2 && !lines.some((l) => l.error) && lines[0].ip !== lines[1].ip,
    geoDb: geo,
    source: "国家城市：DB-IP City Lite；线路类型：IPinfo Lite。都在本机离线查，IP 不会发给任何第三方。",
    accounts,
    paused,
    pausedCount: paused.length,
    waitingCount: paused.filter((a) => a.waiting).length,
    notes,
  };
}

// ---------------------------------------------------------------- 处理：继续用新位置 / 我去关掉代理

const targets = ({ groupId = null, accountId = null }) => {
  const rows = view({ groupId }).paused;
  return accountId ? rows.filter((r) => r.accountId === accountId) : rows;
};

/** 「继续用新位置」：把现在的国家定为这些账号平时的位置，并恢复发布。 */
export function acceptNewPlace({ groupId = null, accountId = null, now = Date.now() } = {}) {
  const rows = targets({ groupId, accountId });
  const baselines = store.getEgressBaselines();
  const waits = store.getEgressWaits();
  for (const r of rows) {
    baselines[r.accountId] = { country: r.now.country, countryName: r.now.countryName, city: r.now.city, at: now };
    delete waits[r.accountId];
    emit({
      type: "egress.accepted",
      severity: "info",
      payload: { accountId: r.accountId, platform: r.platform, from: r.baseline, to: r.now, message: `接受新位置：${r.baseline?.countryName} → ${r.now.countryName}，已恢复发布` },
      dedupeKey: `egress.accepted:${r.accountId}:${now}`,
    });
  }
  store.setEgressBaselines(baselines);
  store.setEgressWaits(waits);
  return { accepted: rows.map((r) => r.accountId) };
}

/** 「我去关掉代理」：不改基线，只记「等发布机复查」；探测到位置回到基线才自动恢复。 */
export function waitForRecheck({ groupId = null, accountId = null, now = Date.now() } = {}) {
  const rows = targets({ groupId, accountId });
  const waits = store.getEgressWaits();
  for (const r of rows) waits[r.accountId] = now;
  store.setEgressWaits(waits);
  return { waiting: rows.map((r) => r.accountId) };
}

// ---------------------------------------------------------------- IP 库下载（每月一次）

const monthStamp = (t) => new Date(t).toISOString().slice(0, 7);

/** 官方下载地址；IPinfo 要免费令牌（config.json 的 egress.ipinfo_token），没有就只用 DB-IP。 */
export function geoSources({ now = Date.now(), config = readConfig() } = {}) {
  const token = config.egress?.ipinfo_token;
  return [
    { kind: "city", name: "DB-IP City Lite", url: `https://download.db-ip.com/free/dbip-city-lite-${monthStamp(now)}.mmdb.gz`, gz: true },
    ...(token ? [{ kind: "asn", name: "IPinfo Lite", url: `https://ipinfo.io/data/ipinfo_lite.mmdb?token=${encodeURIComponent(token)}`, gz: false }] : []),
  ];
}

/** 库该不该下载了：没有库，或最近一次成功下载超过 30 天。 */
export function geoDbDue({ now = Date.now(), dir = geoDir() } = {}) {
  const s = geoDbStatus(dir);
  if (!s.hasCity) return true;
  return now - s.cityDate >= GEO_DB_MAX_AGE_MS;
}

/**
 * 下载新库。成功才替换（先写临时文件、校验能打开、再改名）；失败沿用旧库，把原因记下来，页面写明库的日期。
 */
export async function refreshGeoDb({ now = Date.now(), dir = geoDir(), fetchImpl = fetch, sources = geoSources({ now }), log = () => {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const errors = [];
  const got = [];
  for (const src of sources) {
    try {
      const res = await fetchImpl(src.url, { signal: AbortSignal.timeout(120e3) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let bytes = Buffer.from(await res.arrayBuffer());
      if (src.gz) bytes = gunzipSync(bytes);
      openMmdb(bytes); // 打不开的库不替换旧库
      const target = join(dir, GEO_FILES[src.kind]);
      writeFileSync(`${target}.tmp`, bytes);
      renameSync(`${target}.tmp`, target);
      got.push(src.name);
    } catch (err) {
      errors.push(`${src.name} 没下载成功：${err.message}`);
    }
  }
  const error = errors.length ? errors.join("；") : null;
  store.setEgressGeoDb({ checkedAt: now, error });
  if (error) {
    emit({ type: "egress.geodb_failed", severity: "warn", payload: { code: "egress_geodb_download", message: error }, dedupeKey: `egress.geodb_failed:${monthStamp(now)}:${error.length}` });
    log(`[egress] ${error}`);
  }
  return { updated: got, error };
}

// ---------------------------------------------------------------- 守护进程里的时钟

/**
 * 启动时探测一次，之后每 10 分钟一次（有人在「等发布机复查」时改成每分钟）；IP 库到期就下载。
 * 离线模式什么都不做。每次出错只记日志，不让定时器停下。
 */
export function startEgressWatcher({ log = () => {}, offline = false, probe = probeNow, refresh = refreshGeoDb, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (offline) return () => {};
  let timer = null;
  let stopped = false;
  const tick = async () => {
    try {
      if (geoDbDue()) await refresh({ log });
    } catch (err) {
      log(`[egress] IP 库更新出错：${err.message}`);
    }
    try {
      const r = await probe();
      if (r.paused?.length) log(`[egress] 出口位置变了，${r.paused.length} 个账号暂停发布`);
      if (r.resumed?.length) log(`[egress] ${r.resumed.length} 个账号恢复发布`);
    } catch (err) {
      log(`[egress] 探测出错：${err.message}`);
    }
    if (stopped) return;
    const waiting = store.getEgressWaits() && Object.keys(store.getEgressWaits()).length > 0;
    timer = setTimer(tick, waiting ? WAIT_PROBE_EVERY_MS : PROBE_EVERY_MS);
    timer.unref?.();
  };
  timer = setTimer(tick, 2000);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
  };
}
