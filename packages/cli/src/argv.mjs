// vk 的命令行参数解析。从 vk.mjs 抽出来是为了能单测：vk.mjs 一 import 就会执行命令。
//
// #112 的根因就在这里：--phone / --code 不在「带值参数」表里，被解析成布尔 true，
// 后面的手机号/验证码变成了位置参数，val("--phone") 永远是 undefined，命令直接报「要指定 --phone」。
// 所以带值参数只在这一张表里登记，测试逐条钉住。

export const VALUE_FLAGS = new Set([
  "--to", "--name", "--handle", "--credential", "--title", "--schedule", "--visibility",
  "--range", "--publish", "--platform", "--concurrency", "--port", "--actor", "--origin",
  "--group", "--from", "--at",
  // 账号登录：短信手机号与验证码（ACC-account-08）
  "--phone", "--code",
]);

/** argv（不含 node 与脚本路径）→ { flags, pos }。带值参数缺值时记为 undefined，不吞掉下一个 --flag。 */
export function parseArgv(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      if (VALUE_FLAGS.has(token)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) flags[token] = undefined;
        else flags[token] = argv[++i];
      } else flags[token] = true;
    } else {
      pos.push(token);
    }
  }
  return { flags, pos };
}

/**
 * `vk account login <id> …` 的分派：参数 → 要发的命令与载荷。纯函数，便于单测；
 * 不认识的组合返回 null，由调用方报用法。
 */
export function loginCommandOf(accountId, flags) {
  const has = (f) => flags[f] === true;
  const val = (f) => (typeof flags[f] === "string" ? flags[f] : undefined);
  if (has("--cancel")) return { name: "account.login.cancel", args: { accountId } };
  if (has("--status")) return { name: "account.login.status", args: { accountId } };
  if (has("--resend")) return { name: "account.login.resend", args: { accountId } };
  if (has("--open")) return { name: "account.login.open", args: { accountId } };
  if (has("--qr")) return { name: "account.login.qr", args: { accountId } };
  if (val("--code")) return { name: "account.login.verify", args: { accountId, code: val("--code") } };
  if (val("--phone")) return { name: "account.login.start", args: { accountId, phone: val("--phone") } };
  return null;
}
