// The single source of truth for what versekit can do.
// CLI help, HTTP routes and Feishu card buttons are all derived from this table, and CI asserts
// the three stay identical (docs/ARCHITECTURE.md §5, PRD §5.4).
//
// Adding a capability = adding an entry here. If a feature exists only in the web UI, it is a bug.
//
// Fields:
//   name       command id, stable — it is what a card button sends and what the audit row records
//   args       shape of the payload; the CLI and the HTTP layer both validate against it
//   remote     may be triggered by a card button (i.e. without the person sitting at the machine)
//   localOnly  explicitly cannot be triggered from a card (may still have a local HTTP route)
//   http       { method, path } — null only when localOnly is true
//   card       button projection; only allowed on remote commands
//   audit      "always" for anything remote, "never" for read-only local queries

export const COMMANDS = [
  {
    name: "init",
    summary: "建库、写配置、准备目录",
    remote: false,
    localOnly: true,
    args: {},
    http: null,
    cli: { usage: "vk init" },
    card: null,
    audit: "never",
  },
  {
    name: "now",
    summary: "一屏状态：账号健康 / 队列 / 通道",
    remote: true,
    args: {},
    http: { method: "GET", path: "/api/now" },
    cli: { usage: "vk now [--human]" },
    card: null,
    audit: "never",
  },
  {
    name: "doctor",
    summary: "自检：能不能跑 / 能不能发 / 能不能看到 / 能不能收到",
    remote: false,
    args: {},
    http: { method: "GET", path: "/api/doctor" },
    cli: { usage: "vk doctor [--human] [--json]" },
    card: null,
    audit: "never",
  },
  {
    name: "account.add",
    summary: "加一个账号（需要在电脑上扫码）",
    remote: false,
    localOnly: true,
    args: { platform: "string", name: "string", handle: "string?", credentialRef: "string?" },
    http: { method: "POST", path: "/api/accounts" },
    cli: { usage: "vk account add <platform> --name <name> [--handle @x] [--credential <cookies.json>]" },
    card: null,
    audit: "never",
  },
  {
    name: "account.list",
    summary: "列出所有账号与登录状态",
    remote: true,
    args: {},
    http: { method: "GET", path: "/api/accounts" },
    cli: { usage: "vk account list" },
    card: null,
    audit: "never",
  },
  {
    name: "account.reauth",
    summary: "重新登录某个账号（远程只能发起，扫码必须在电脑前完成）",
    remote: true,
    args: { accountId: "string" },
    idempotent: (a) => `reauth:${a.accountId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/accounts/:accountId/reauth" },
    cli: { usage: "vk account reauth <accountId>" },
    card: { label: "重新授权", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "account.mode",
    summary: "把账号设为自动发布 / 仅手动",
    remote: true,
    args: { accountId: "string", mode: "auto|manual" },
    idempotent: (a) => `mode:${a.accountId}:${a.mode}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/accounts/:accountId/mode" },
    cli: { usage: "vk account mode <accountId> auto|manual" },
    card: { label: "转手动跟踪", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "publish.create",
    summary: "创建发布（一条内容 → 多平台）",
    remote: false,
    localOnly: true,
    args: { asset: "string", to: "string[]", schedule: "number?", visibility: "string?", dryRun: "boolean?", title: "string?" },
    http: { method: "POST", path: "/api/publishes" },
    cli: { usage: "vk publish <asset> --to <platforms> [--schedule] [--visibility] [--dry-run]" },
    card: null,
    audit: "never",
  },
  {
    name: "publish.retry",
    summary: "重试一次发布",
    remote: true,
    args: { publishId: "string" },
    idempotent: (a) => `retry:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/:publishId/retry" },
    cli: { usage: "vk publish retry <publishId>" },
    card: { label: "重试", style: "primary", confirm: false },
    audit: "always",
  },
  {
    name: "publish.release",
    summary: "把 private_then_public 的内容放行为公开",
    remote: true,
    args: { publishId: "string" },
    idempotent: (a) => `release:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/:publishId/release" },
    cli: { usage: "vk publish release <publishId>" },
    card: { label: "放行公开", style: "primary", confirm: false },
    audit: "always",
  },
  {
    name: "publish.confirm",
    summary: "确认已在 App 内完成发布（notify 模式）",
    remote: true,
    args: { publishId: "string" },
    idempotent: (a) => `confirm:${a.publishId}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/publishes/:publishId/confirm" },
    cli: { usage: "vk publish confirm <publishId>" },
    card: { label: "我已发布", style: "primary", confirm: false },
    audit: "always",
  },
  {
    name: "collect.now",
    summary: "立刻抓一次指标",
    remote: true,
    args: { publishId: "string?", platform: "string?" },
    // 按小时去重：连点两次不该排两次，隔一小时再点应该真的重抓。
    idempotent: (a) => `collect:${a.publishId ?? a.platform ?? "all"}:${new Date().toISOString().slice(0, 13)}`,
    ttlMs: 24 * 3600e3,
    http: { method: "POST", path: "/api/collect" },
    cli: { usage: "vk collect [--now] [--platform <p>]" },
    card: { label: "立即重抓", style: "default", confirm: false },
    audit: "always",
  },
  {
    name: "stats.works",
    summary: "看作品指标（JSON）",
    remote: true,
    args: { range: "string?", publishId: "string?" },
    http: { method: "GET", path: "/api/stats/works" },
    cli: { usage: "vk stats works [--range 7d] [--publish <id>]" },
    card: { label: "看 24 小时数据", style: "default", confirm: false },
    audit: "never",
  },
  {
    name: "channel.bind",
    summary: "配对飞书（本机显示 6 位码）",
    remote: false,
    localOnly: true,
    args: {},
    http: { method: "POST", path: "/api/channels/feishu/bind" },
    cli: { usage: "vk channel bind feishu" },
    card: null,
    audit: "never",
  },
  {
    name: "channel.test",
    summary: "飞书通道探活",
    remote: false,
    args: {},
    http: { method: "POST", path: "/api/channels/feishu/test" },
    cli: { usage: "vk channel test feishu" },
    card: null,
    audit: "never",
  },
];

export const findCommand = (name) => COMMANDS.find((c) => c.name === name) ?? null;

/** What a remote caller (card button) is allowed to trigger. */
export const remoteCommands = () => COMMANDS.filter((c) => c.remote);

/**
 * Argument validation shared by the CLI, the HTTP layer and the card handler. Returns the parsed
 * args or throws with a field name — never a silent coercion, because `publishId: undefined`
 * reaching the queue is how a card button "does nothing".
 */
export function parseArgs(command, input = {}) {
  const args = command.args ?? {};
  const out = {};
  for (const [key, spec] of Object.entries(args)) {
    const optional = spec.endsWith("?");
    const type = spec.replace(/\?$/, "");
    const value = input[key];
    if (value == null || value === "") {
      if (optional) continue;
      throw new Error(`命令 ${command.name} 缺少参数：${key}`);
    }
    if (type === "string" && typeof value !== "string") throw new Error(`参数 ${key} 必须是字符串`);
    if (type === "number" && typeof value !== "number") throw new Error(`参数 ${key} 必须是数字`);
    if (type === "boolean" && typeof value !== "boolean") throw new Error(`参数 ${key} 必须是布尔值`);
    if (type === "string[]" && !Array.isArray(value)) throw new Error(`参数 ${key} 必须是字符串数组`);
    if (type === "auto|manual" && !["auto", "manual"].includes(value)) throw new Error(`参数 ${key} 只能是 auto 或 manual`);
    out[key] = value;
  }
  for (const key of Object.keys(input)) {
    if (!(key in args)) throw new Error(`命令 ${command.name} 不认识参数：${key}`);
  }
  return out;
}
