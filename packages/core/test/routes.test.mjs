// Three faces, one table (docs/BLUEPRINT.md §2.2). If a command exists on the card but has no
// route, the button works in one place and 404s in another — this test is the wall against that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, findCommand, parseArgs } from "../src/commands.mjs";
import { buildRoutes, matchRoute, cardButtons, ROUTES } from "../src/routes.mjs";

test("every command except bootstrap is reachable over HTTP", () => {
  for (const cmd of COMMANDS) {
    if (cmd.name === "init") {
      assert.equal(cmd.http, null, "init 是引导命令，落库之前没有服务可调");
      continue;
    }
    assert.ok(cmd.http, `${cmd.name} 没有 http 路由，Web 与 CLI 会各写一套`);
  }
});

test("a local-only command never grows a card button", () => {
  for (const cmd of COMMANDS) {
    if (cmd.localOnly) assert.equal(cmd.card, null, `${cmd.name} 标了 localOnly 却有卡片按钮`);
  }
});

test("route paths are unique per method — a duplicate would shadow a command", () => {
  const seen = new Set();
  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    assert.equal(seen.has(key), false, `重复路由：${key}`);
    seen.add(key);
  }
});

test("only GET is used for reads, and every path is under /api", () => {
  for (const route of ROUTES) {
    assert.ok(route.path.startsWith("/api/"), `${route.command} 的路径不在 /api 下：${route.path}`);
    if (route.command === "now" || route.command === "doctor" || route.command === "stats.works") {
      assert.equal(route.method, "GET", `${route.command} 是只读命令，应该是 GET`);
    }
  }
});

test("a card button always maps to a remote command", () => {
  const buttons = cardButtons();
  assert.ok(buttons.length >= 6);
  for (const button of buttons) {
    const cmd = findCommand(button.command);
    assert.ok(cmd.remote, `${button.command} 有卡片按钮但不可远程触发`);
    assert.equal(typeof button.label, "string");
  }
});

test("matchRoute resolves a parameterised path and hands back the params", () => {
  const hit = matchRoute("POST", "/api/publishes/pub_123/retry");
  assert.deepEqual(hit, { command: "publish.retry", params: { publishId: "pub_123" } });
});

test("matchRoute ignores a trailing slash and the wrong verb", () => {
  assert.equal(matchRoute("POST", "/api/now/"), null);
  assert.equal(matchRoute("GET", "/api/publishes/pub_123/retry"), null);
  assert.equal(matchRoute("DELETE", "/api/nope"), null);
});

test("buildRoutes refuses to build a table with a duplicate", () => {
  const dup = [
    { name: "a", http: { method: "GET", path: "/api/x" } },
    { name: "b", http: { method: "GET", path: "/api/x" } },
  ];
  assert.throws(() => buildRoutes(dup), /路由重复/);
});

test("cardButtons refuses a button on a local-only command", () => {
  const bad = [{ name: "x", remote: false, card: { label: "点我", style: "default" } }];
  assert.throws(() => cardButtons(bad), /remote/);
});

// ---------------------------------------------------------------- args

test("parseArgs rejects a missing required argument by name", () => {
  assert.throws(() => parseArgs(findCommand("publish.retry"), {}), /publishId/);
});

test("parseArgs rejects an unknown argument instead of dropping it silently", () => {
  assert.throws(() => parseArgs(findCommand("publish.retry"), { publishId: "p", force: true }), /不认识参数/);
});

test("parseArgs keeps optional arguments absent rather than filling defaults", () => {
  assert.deepEqual(parseArgs(findCommand("collect.now"), {}), {});
});
