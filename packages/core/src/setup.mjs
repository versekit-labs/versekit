// 接入状态：把「用户还需要做什么」变成数据，而不是散落的提示。
//
// 四个步骤是固定的（环境 → 账号 → 通道 → 第一条），顺序本身就是引导的一部分：
// 人不需要读 README，只要看第一个不是绿色的步骤。
//
// 这里不探测外部世界：医生报告的检查、账号列表、通道绑定、已发布数量都由调用方注入，
// 所以规则可以被测试穷举，也不会在 HTTP 请求里卡住 3 秒去连飞书。

import { OPTIONAL_CHECKS } from "./doctor.mjs";

const fix = (kind, payload) => ({ kind, ...payload });

const ENV_CHECKS = ["node", "config_dir", "database", "schema_version", "chrome", "daemon", "adapters"];

const statusOf = (checks, done) => {
  if (done) return "ok";
  const blocked = checks.some((c) => !c.ok && c.blocking);
  return blocked ? "blocked" : "todo";
};

/**
 * @param doctor   doctorReport() 的结果；缺省时环境步骤视为未知（不假装绿）
 * @param accounts 账号列表（store.listAccounts）
 * @param channel  {bound:boolean, who?:string}
 * @param publishedCount 已成功发布的数量
 */
export function setupStatus({ doctor = null, accounts = [], channel = { bound: false }, publishedCount = 0, now = Date.now() } = {}) {
  const doctorChecks = doctor?.checks ?? [];
  const envChecks = doctorChecks
    .filter((c) => ENV_CHECKS.includes(c.id))
    .map((c) => ({ id: `env.${c.id}`, ok: c.ok, detail: c.detail, blocking: true, ...(c.next ? { next: c.next } : {}) }));

  // ---------- 1. 环境
  const envDone = envChecks.length > 0 && envChecks.every((c) => c.ok);
  const env = {
    id: "env",
    title: "环境",
    intent: "这台电脑能不能跑起来",
    status: doctor ? statusOf(envChecks, envDone) : "todo",
    done: envDone,
    checks: envChecks.length ? envChecks : [{ id: "env.unknown", ok: false, detail: "还没有拿到自检结果", blocking: true }],
    fix: envDone ? null : fix("page", { label: "看自检页", href: "#doctor" }),
  };

  // ---------- 2. 账号
  const bad = accounts.filter((a) => ["expired", "banned"].includes(a.state));
  const accountChecks = [
    {
      id: "account.exists",
      ok: accounts.length > 0,
      blocking: true,
      detail: accounts.length ? `${accounts.length} 个账号` : "还没有添加任何平台账号",
      next: accounts.length ? null : "添加一个平台账号，并验证登录态",
    },
    {
      id: "account.healthy",
      ok: bad.length === 0,
      blocking: bad.length > 0,
      detail: bad.length ? `${bad.length} 个账号登录态失效（${bad.map((a) => `${a.platform} ${a.handle}`).join("、")}）` : "账号登录态正常",
    },
  ];
  const accountDone = accounts.length > 0 && bad.length === 0;
  const account = {
    id: "account",
    title: "平台账号",
    intent: "至少一个账号能发出去",
    status: statusOf(accountChecks, accountDone),
    done: accountDone,
    checks: accountChecks,
    fix: accountDone
      ? null
      : bad.length
        ? fix("command", { label: "重新授权", command: "account.reauth", args: { accountId: bad[0].id } })
        : fix("page", { label: "去添加账号", href: "#accounts" }),
  };

  // ---------- 3. 手机通道
  const channelChecks = [
    {
      id: "channel.bound",
      ok: Boolean(channel?.bound),
      blocking: false,
      detail: channel?.bound ? `已配对${channel.who ? `（${channel.who}）` : ""}` : "还没有配对飞书，失败时只能自己盯着",
    },
  ];
  const channelDone = Boolean(channel?.bound);
  const channelStep = {
    id: "channel",
    title: "手机通道",
    intent: "出问题时在手机上拍板",
    status: statusOf(channelChecks, channelDone),
    done: channelDone,
    checks: channelChecks,
    fix: channelDone ? null : fix("page", { label: "去配对飞书", href: "#accounts" }),
  };

  // ---------- 4. 第一条发布
  const publishChecks = [
    {
      id: "publish.first",
      ok: publishedCount > 0,
      blocking: false,
      detail: publishedCount > 0 ? `已经有 ${publishedCount} 条成功发布` : "还没有成功发布过一条",
    },
  ];
  const publishDone = publishedCount > 0;
  const publishStep = {
    id: "first-publish",
    title: "第一条发布",
    intent: "确认整条链路真的通",
    status: statusOf(publishChecks, publishDone),
    done: publishDone,
    checks: publishChecks,
    fix: publishDone ? null : fix("page", { label: "去发布台", href: "#publish" }),
  };

  const steps = [env, account, channelStep, publishStep];
  const nextStep = steps.find((s) => s.status !== "ok")?.id ?? null;
  const done = steps.filter((s) => s.status === "ok").length;

  return { steps, nextStep, done, total: steps.length, updatedAt: now };
}
