// B站页面扫码登录的纯函数部分：cookie 选择、biliup 文件形状、0600 权限。
// 真开 Chrome / 真扫码在验收里做，这里不碰网络也不碰浏览器。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-bili-login-"));

const { credentialPathFor, cookiesFrom, cookieFilePayload, writeCookieFile, loginStatus } = await import("../src/login.mjs");

const cdpCookies = [
  { name: "SESSDATA", value: "sess-token", expires: 1802268997, secure: false },
  { name: "bili_jct", value: "csrf-token", expires: 1802268997, secure: false },
  { name: "DedeUserID", value: "1519210378", expires: 1802268997, secure: false },
  { name: "DedeUserID__ckMd5", value: "ckmd5", expires: 1802268997, secure: false },
  { name: "sid", value: "sid-value", expires: 1802268997, secure: false },
  { name: "sec_ck", value: "sec", expires: 1802268997, secure: true },
  { name: "buvid3", value: "random", expires: -1, secure: false },
];

before(() => {
  // VK_HOME 必须在 import core 之前设置（login.mjs 用了 paths()），所以放在文件顶部。
  assert.ok(process.env.VK_HOME);
});

test("只挑凭证 cookie：没有 SESSDATA / bili_jct 就不算登录", () => {
  assert.equal(cookiesFrom([{ name: "SESSDATA", value: "x" }]), null);
  assert.equal(cookiesFrom([]), null);
  assert.equal(cookiesFrom(null), null);
});

test("CDP cookie → biliup cookie：丢掉 -1 会话 cookie，保留续期时间", () => {
  const cookies = cookiesFrom(cdpCookies);
  assert.deepEqual(cookies.map((c) => c.name), ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid", "sec_ck"]);
  assert.equal(cookies.find((c) => c.name === "SESSDATA").http_only, 1);
  assert.equal(cookies.find((c) => c.name === "bili_jct").http_only, 0);
  assert.equal(cookies.find((c) => c.name === "sec_ck").secure, 1);
  assert.equal(cookies.every((c) => c.expires > 0), true);
});

test("文件形状是 biliup-rs 的 LoginInfo：cookie_info + token_info + platform", () => {
  const payload = cookieFilePayload(cookiesFrom(cdpCookies));
  assert.equal(payload.platform, "BiliTV");
  assert.deepEqual(payload.cookie_info.domains, [".bilibili.com", ".biligame.com", ".bilibili.cn", ".huasheng.cn"]);
  assert.equal(payload.cookie_info.cookies.length, 6);
  assert.equal(payload.token_info.mid, 1519210378);
});

test("写凭证：落在 credentials/，文件 0600，内容可被适配器读回", () => {
  const file = credentialPathFor("acc_test");
  assert.equal(file, join(process.env.VK_HOME, ".config", "versekit", "credentials", "bili-acc_test.json"));
  writeCookieFile(file, cookiesFrom(cdpCookies));
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.cookie_info.cookies.find((c) => c.name === "SESSDATA").value, "sess-token");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(credentialPathFor("acc_test", "/tmp/existing.json"), "/tmp/existing.json");
});

test("TV 交换回来的完整 LoginInfo 原样落盘（token_info 不能丢，否则 biliup renew 会 -400）", () => {
  const file = `${process.env.VK_HOME}/tv-login.json`;
  writeCookieFile(file, {
    cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }], domains: [".bilibili.com"] },
    sso: [],
    token_info: { access_token: "at", expires_in: 15552000, mid: 42, refresh_token: "rt" },
    platform: "BiliTV",
  });
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.token_info.access_token, "at");
  assert.equal(parsed.token_info.refresh_token, "rt");
  assert.equal(parsed.platform, "BiliTV");
});

test("没有登录窗口时 status 返回 idle，不伪造成功", async () => {
  const result = await loginStatus({ accountId: "acc_test" });
  assert.equal(result.state, "idle");
  assert.ok(result.note);
});