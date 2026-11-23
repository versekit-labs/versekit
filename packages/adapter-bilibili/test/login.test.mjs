// B站页面扫码登录的纯函数部分：cookie 选择、biliup 文件形状、0600 权限。
// 真开 Chrome / 真扫码在验收里做，这里不碰网络也不碰浏览器。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
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
test("ACC-acct-iso-06：B站退出登录删掉这个账号自己的凭据文件，别的账号的还在；重复退出不报错", async () => {
  const { clearCredentials } = await import("../src/login.mjs");
  const { default: bilibili } = await import("../src/index.mjs");
  const { migrate, open } = await import("../../core/src/index.mjs");
  const store = await import("../../core/src/store.mjs");
  migrate();
  const mk = (name) => store.addAccount({ platform: "bilibili", handle: name, displayName: name, groupId: store.addGroup({ name: `B站换号组${name}` }).id });
  const a = mk("甲");
  const b = mk("乙");
  const fileA = credentialPathFor(a.id);
  const fileB = credentialPathFor(b.id);
  writeCookieFile(fileA, cookieFilePayload(cookiesFrom(cdpCookies)));
  writeCookieFile(fileB, cookieFilePayload(cookiesFrom(cdpCookies)));
  open().prepare("UPDATE account SET credential_ref=? WHERE id=?").run(fileA, a.id);
  open().prepare("UPDATE account SET credential_ref=? WHERE id=?").run(fileB, b.id);
  assert.equal(existsSync(fileA) && existsSync(fileB), true);

  const out = bilibili.logout({ accountId: a.id, credentialRef: fileA });
  assert.deepEqual(out.removed, [fileA]);
  assert.equal(existsSync(fileA), false, "甲的凭据文件已删");
  assert.equal(existsSync(fileB), true, "乙的凭据文件还在");
  assert.deepEqual(clearCredentials(a.id, fileA), [], "重复退出不报错");

  // vk 的退出同步清账号行的 credential_ref：之后 check 判「没连上」（auth → expired），不会再拿旧号去发
  open().prepare("UPDATE account SET credential_ref=NULL WHERE id=?").run(a.id);
  await assert.rejects(bilibili.check({ accountId: a.id }), (err) => err.code === "auth" && /还没有凭证/.test(err.message));
});

test("ACC-acct-iso-06：账号行指着凭证目录外的文件时不替用户删，只由调用方清掉引用", async () => {
  const { clearCredentials } = await import("../src/login.mjs");
  const outside = join(mkdtempSync(join(tmpdir(), "vk-bili-ext-")), "mine.json");
  writeCookieFile(outside, cookieFilePayload(cookiesFrom(cdpCookies)));
  assert.deepEqual(clearCredentials("acc_none", outside), []);
  assert.equal(existsSync(outside), true);
});
