// 网页登录的登录态收尾（#386）：适配器的 loginStatus 只负责「读窗口、报结果」，
// 账号变「正常」、通知、收登录窗口这些副作用由 vk 统一做（适配器不碰库，零后门律）。

/**
 * 适配器报 `finish: "window"` 的成功：账号变 ok、收登录窗口、清掉本进程的登录会话。
 * 返回给调用方的结果里去掉内部字段 finish。别的结果原样返回。
 */
export async function finishWindowLogin({ accountId, account, result, deps }) {
  if (result?.state !== "ok" || result.finish !== "window") return result;
  const { finish: _finish, ...rest } = result;
  deps.clearSession?.(accountId);
  if (account.state !== "ok") deps.setAccountState(accountId, "ok");
  await deps.notifyLogin(accountId);
  deps.closeWindow(accountId).catch?.(() => {});
  return rest;
}

/** 没有自带 loginStatus 的平台：只有小红书走旧的页面检测；其余只报「在等 / 没在登录」，绝不开页。 */
export function fallbackLoginStatus({ hasSession }) {
  return hasSession
    ? { state: "pending", mode: "manual", note: "等你在浏览器里登录…" }
    : { state: "idle", mode: "manual", note: "点「打开登录窗口」，在窗口里登录" };
}
