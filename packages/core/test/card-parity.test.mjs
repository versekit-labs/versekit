// 三端一致律在卡片上的执行版（ACC-arch-12）：卡片上的每个按钮都必须能在命令表里找到。
// 改单卡片的「提交」就是 publish.edit 命令本身；翻页按钮在 CARD_VIEWS 里声明。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, CARD_VIEWS, cardActionProblems, findCommand } from "../src/commands.mjs";
import { cardActions, sampleCards } from "../src/cards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const samples = sampleCards();

test("每种卡片的每个按钮都能在命令表（或 CARD_VIEWS）里找到", () => {
  for (const [name, card] of Object.entries(samples)) {
    assert.ok(card, `样例卡片 ${name} 没造出来`);
    const actions = cardActions(card);
    assert.deepEqual(cardActionProblems(actions), [], `${name} 卡片有表外动作`);
  }
  const all = Object.values(samples).flatMap(cardActions);
  assert.ok(all.length >= 10, "样例卡片应当覆盖到足够多的按钮");
});

test("改单卡片：提交是 publish.edit 本身，不再有 card.save_edit", () => {
  const cmds = (key) => cardActions(samples[key]).map((a) => a.cmd);
  for (const key of ["edit:scheduled", "edit:now"]) {
    assert.ok(cmds(key).includes("publish.edit"), `${key} 提交按钮应是 publish.edit`);
    assert.ok(!cmds(key).includes("card.save_edit"));
  }
  const submit = cardActions(samples["edit:now"]).find((a) => a.cmd === "publish.edit");
  assert.equal(submit.args.when, "now");
  assert.ok(submit.key.endsWith(":publish.edit"));
});

test("CARD_VIEWS 每一项都服务于一条存在的远程命令，且不与命令重名", () => {
  for (const v of CARD_VIEWS) {
    assert.ok(!findCommand(v.name), `${v.name} 与命令重名`);
    assert.equal(findCommand(v.serves)?.remote, true, `${v.name} 的 serves=${v.serves} 不是远程命令`);
  }
});

test("表外动作会被识别：未知 cmd、非 remote 命令、serves 悬空的翻页", () => {
  assert.equal(cardActionProblems([{ cmd: "card.bogus" }]).length, 1);
  assert.equal(cardActionProblems([{}]).length, 1);
  const local = COMMANDS.find((c) => !c.remote);
  assert.equal(cardActionProblems([{ cmd: local.name }]).length, 1);
  assert.deepEqual(cardActionProblems([{ cmd: "publish.edit" }, { cmd: "card.edit" }]), []);
});

test("check:parity 通过；故意塞一个表外卡片动作时失败并点名", () => {
  const run = (env) =>
    spawnSync(process.execPath, ["scripts/ci/parity.mjs"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
  const clean = run({});
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /parity\.cards\.actions-in-table/);

  const rogue = run({ VK_PARITY_ROGUE_CARD_ACTION: "card.rogue" });
  assert.equal(rogue.status, 1, "表外卡片动作必须让 check:parity 失败");
  assert.match(rogue.stdout, /parity\.cards\.actions-in-table/);
  assert.match(rogue.stdout, /card\.rogue/);
});

test("cards.mjs 手写 callback 会被 check:parity 抓到", () => {
  const r = spawnSync(process.execPath, ["scripts/ci/parity.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, VK_PARITY_CARDS_SOURCE_APPEND: 'const x = callback("card.rogue", {}, { now });' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /parity\.cards\.derived/);
  assert.match(r.stdout, /直接调用 callback/);
});

test("卡片按钮 value 只能经命令表造：表外 cmd 当场抛错", async () => {
  const { cardCallbackValue } = await import("../src/commands.mjs");
  assert.throws(() => cardCallbackValue("card.rogue", {}, { now: 0, ttlMs: 1 }), /不合法/);
  assert.equal(cardCallbackValue("card.edit", { cutId: "c" }, { now: 1, ttlMs: 2 }).exp, 3);
});
