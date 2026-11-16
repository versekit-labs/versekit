import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../web/public/work.html", import.meta.url), "utf8");

test("作品页：notify_pending（无论有没有 error）都有「再试一次」入口，和发布页 / CLI 一致", () => {
  assert.match(html, /PROBLEM\.has\(p\.state\) \|\| p\.state === "notify_pending"/);
  assert.doesNotMatch(html, /notify_pending" && p\.error/);
  assert.match(html, /data-retry="\$\{esc\(p\.id\)\}">再试一次/);
});
