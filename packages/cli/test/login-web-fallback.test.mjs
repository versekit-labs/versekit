// ACC-acct-iso-08：没有 loginStatus 的非小红书平台，登录态兜底只报状态、不开页。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fallbackLoginStatus } from "../src/login-web.mjs";

test("fallbackLoginStatus：没会话 idle，有会话 pending", () => {
  assert.equal(fallbackLoginStatus({ hasSession: false }).state, "idle");
  assert.equal(fallbackLoginStatus({ hasSession: true }).state, "pending");
});

test("vk.mjs：小红书专用的 creatorLoggedIn 之前有平台闸，非小红书平台走兜底", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/vk.mjs", import.meta.url)), "utf8");
  const status = src.slice(src.indexOf('"account.login.status"'));
  const gate = status.indexOf('account.platform !== "xiaohongshu"');
  assert.ok(gate > 0 && gate < status.indexOf("creatorLoggedIn(accountId)"));
});
