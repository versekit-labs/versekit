// 自检报告（ARCHITECTURE §11）：回答「为什么发不出去」，每个红灯都带下一步。
//
// 逻辑放在 core、依赖从外面注入（浏览器探测、适配器列表），这样 CLI、控制台和测试
// 拿到的是同一份判断：不会出现「网页说没问题、命令行说有问题」。

import { existsSync } from "node:fs";
import { paths, getMeta, isInitialised, open } from "./index.mjs";

/** 这些红灯不阻塞使用（还没配账号、还没配对通道），所以不算整体失败。 */
export const OPTIONAL_CHECKS = ["adapters", "channel_feishu", "browser_profile", "accounts", "daemon", "account_probe"];

export function doctorReport({
  browserReady = () => "未接入浏览器驱动",
  browser = {},
  adapters = [],
  adapterErrors = [],
  now = Date.now(),
} = {}) {
  const checks = [];
  const add = (id, ok, detail, next) => checks.push({ id, ok, detail, ...(next ? { next } : {}) });

  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  add("node", nodeOk, `v${process.versions.node}${nodeOk ? "" : "（需要 ≥22.13，node:sqlite 的 .get() 修复）"}`, nodeOk ? null : "升级 Node 到 22.13 以上");

  const p = paths();
  const initialised = isInitialised();
  add("config_dir", existsSync(p.config), p.config, existsSync(p.config) ? null : "运行 vk init");
  add("database", initialised, initialised ? p.db : "还没有初始化", initialised ? null : "运行 vk init");
  add("schema_version", getMeta("schema_version") === "1", getMeta("schema_version") ?? "（无）", initialised ? null : "运行 vk init");

  const chrome = browserReady();
  add("chrome", chrome === null, chrome ?? "已找到 Chrome", chrome);
  const profile = browser.profile ?? null;
  const port = browser.port ?? null;
  add(
    "browser_profile",
    Boolean(profile) && existsSync(profile),
    profile ? `${profile}${port ? `（CDP :${port}）` : ""}` : "没有浏览器 profile 路径",
    profile && existsSync(profile) ? null : "首次扫码登录时会自动创建",
  );
  add("daemon", existsSync(p.socket), existsSync(p.socket) ? `unix socket ${p.socket}` : "守护进程没在跑", existsSync(p.socket) ? null : "vk serve --detach（写命令会自动拉起）");

  let counts = { accounts: 0, expiring: 0, stuck: 0 };
  if (initialised) {
    const conn = open({ readonly: true });
    counts.accounts = conn.prepare("SELECT COUNT(*) n FROM account").get().n;
    counts.expiring = conn.prepare("SELECT COUNT(*) n FROM account WHERE state IN ('expiring','expired')").get().n;
    counts.stuck = conn.prepare("SELECT COUNT(*) n FROM run WHERE state='running' AND lease_until < ?").get(now).n;
  }
  add("accounts", counts.accounts > 0, `${counts.accounts} 个账号`, counts.accounts ? null : "vk account add <platform> --name 主号");
  add("account_health", counts.expiring === 0, counts.expiring ? `${counts.expiring} 个账号需要重新登录` : "全部正常", counts.expiring ? "vk account reauth <id>" : null);
  add("queue", counts.stuck === 0, counts.stuck ? `${counts.stuck} 个任务租约过期` : "没有卡住的任务", counts.stuck ? "重启守护进程（任务会自动重排）" : null);

  const platforms = adapters.map((a) => a.platform);
  add(
    "adapters",
    platforms.length > 0 && adapterErrors.length === 0,
    platforms.length ? `${platforms.join(", ")}${adapterErrors.length ? `（${adapterErrors.length} 个加载失败）` : ""}` : "尚未接入任何平台适配器",
    platforms.length ? null : "按 docs/adapter-contract.md 实现第一个适配器",
  );

  // 没有 check() 的适配器只能靠发布/采集失败发现失效——产品承诺的一部分，要显式说出来。
  const passiveOnly = adapters.filter((a) => typeof a.adapter?.check !== "function").map((a) => a.platform);
  if (platforms.length) {
    add(
      "account_probe",
      passiveOnly.length === 0,
      passiveOnly.length ? `${passiveOnly.join("、")} 只能被动发现失效` : "所有适配器都能主动探测登录态",
      passiveOnly.length ? "给这些适配器补 check()；在此之前账号失效只会在发布/采集时暴露" : null,
    );
  }

  const feishu = initialised ? open({ readonly: true }).prepare("SELECT COUNT(*) n FROM channel_binding WHERE channel='feishu'").get().n > 0 : false;
  add("channel_feishu", feishu, feishu ? "已配对" : "未配对", feishu ? null : "vk channel bind feishu");

  const passed = checks.filter((c) => c.ok).length;
  return {
    ok: checks.every((c) => c.ok || OPTIONAL_CHECKS.includes(c.id)),
    passed,
    total: checks.length,
    checks,
  };
}
