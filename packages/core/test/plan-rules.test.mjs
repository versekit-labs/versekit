// 改时间按平台规则校验（#151，ACC-v2-confirm-06）。只用 fixture，不碰任何真实账号或平台。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME = mkdtempSync(join(tmpdir(), "vk-plan-rules-"));

const core = await import("../src/index.mjs");
const store = await import("../src/store.mjs");
const { createCoreHandlers } = await import("../src/handlers.mjs");
const { planRules, DEFAULT_PLAN_RULES, violationAt, nearestAvailable } = await import("../src/plan-rules.mjs");
const { updateConfig } = await import("../src/config.mjs");

const h = createCoreHandlers({ adapters: [{ platform: "tiktok" }, { platform: "bilibili" }], log: () => {} });
const MIN = 60e3;
const H = 3600e3;
let seq = 0;

before(() => core.migrate());

/** 一个账号 + 若干已排好时间的平台稿 + 一条待改的平台稿。 */
function account(platform = "tiktok") {
  const groupId = store.addGroup({ name: `规则组 ${++seq}` }).id;
  return { platform, accountId: store.addAccount({ platform, handle: `@r${seq}`, groupId }).id };
}
function pub(accountId, scheduledAt) {
  const work = store.createWork({ title: `作品 ${++seq}`, assetPath: "/tmp/a.mp4" });
  return store.createPublish({ workId: work.id, accountId, scheduledAt }).id;
}
/** 明天 00:00 本地时间，用来让「一天」的边界可控。 */
const tomorrow = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};
const rulesOf = (platform) => planRules(platform);
const edit = (publishId, at) => h["publish.edit"]({ publishId, at });

test("默认值是所有者定的：每日 10 条、间隔 10 分钟，所有平台一样", () => {
  assert.deepEqual({ ...DEFAULT_PLAN_RULES }, { daily_cap: 10, min_gap_minutes: 10 });
  for (const p of ["tiktok", "bilibili", "xiaohongshu"]) {
    const r = rulesOf(p);
    assert.equal(r.dailyCap, 10);
    assert.equal(r.minGapMs, 10 * MIN);
  }
});

test("间隔不足被拒，建议时间满足两条规则", () => {
  const { accountId } = account();
  const base = tomorrow() + 12 * H;
  pub(accountId, base);
  const mine = pub(accountId, base + 5 * H);
  const want = base + 3 * MIN;
  let err;
  try {
    edit(mine, want);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应该拒绝");
  assert.match(err.message, /最小间隔 10 分钟/);
  assert.match(err.message, /最近的可用时间/);
  assert.equal(err.code, "plan_min_gap");
  assert.equal(err.suggestedAt, base + 10 * MIN, "离想要的时间最近的合规点");
  assert.equal(violationAt(err.suggestedAt, [base], rulesOf("tiktok")), null);
  assert.equal(store.getPublish(mine).scheduled_at, base + 5 * H, "被拒就不改");
  // 建议时间本身能改成功。
  assert.equal(edit(mine, err.suggestedAt).scheduledAt, err.suggestedAt);
  // 刚好 10 分钟算合规。
  const other = pub(accountId, base + 8 * H);
  assert.equal(edit(other, base + 20 * MIN).scheduledAt, base + 20 * MIN);
});

test("超每日上限被拒，建议时间满足两条规则（且不在已满的那天）", () => {
  const { accountId } = account();
  const day = tomorrow() + 24 * H; // 后天
  const dayStart = new Date(day).setHours(0, 0, 0, 0);
  const taken = [];
  for (let i = 0; i < 10; i++) {
    taken.push(dayStart + (8 + i) * H); // 8:00…17:00，每小时一条，共 10 条
    pub(accountId, taken.at(-1));
  }
  const mine = pub(accountId, dayStart + 3 * 24 * H);
  const want = dayStart + 20 * H; // 当天 20:00：间隔没问题，但第 11 条
  let err;
  try {
    edit(mine, want);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "第 11 条应该被拒");
  assert.match(err.message, /每日上限 10 条/);
  assert.equal(err.code, "plan_daily_cap");
  const s = err.suggestedAt;
  assert.ok(s > Date.now());
  assert.equal(violationAt(s, taken, rulesOf("tiktok")), null, "建议时间同时满足两条规则");
  assert.ok(s < dayStart || s >= dayStart + 24 * H, "不在已满的那天");
  // 最近：前一天最后一刻(23:59:59.999)离 20:00 是 4 小时，后一天 00:00 也是 4 小时，取晚的。
  assert.equal(s, dayStart + 24 * H);
  assert.equal(edit(mine, s).scheduledAt, s);
});

test("自己不占名额：已满的一天里，把自己挪到同一天合规的位置没问题", () => {
  const { accountId } = account();
  const dayStart = tomorrow() + 3 * 24 * H;
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(pub(accountId, dayStart + (8 + i) * H));
  assert.equal(edit(ids[0], dayStart + 20 * H).scheduledAt, dayStart + 20 * H);
});

test("先不发、已取消的不占名额；不同账号互不影响", () => {
  const a = account();
  const b = account();
  const base = tomorrow() + 14 * H;
  const skipped = pub(a.accountId, base);
  core.transitionPublish(skipped, "skipped", { reason: "test" });
  const mine = pub(a.accountId, base + 3 * H);
  assert.equal(edit(mine, base + MIN).scheduledAt, base + MIN, "先不发那条不占名额");
  const mate = pub(a.accountId, base + 5 * H);
  assert.throws(() => edit(mate, base + 2 * MIN), /最小间隔/, "待确认的占名额");
  pub(b.accountId, base);
  const bMine = pub(b.accountId, base + 4 * H);
  assert.throws(() => edit(bMine, base + MIN), /最小间隔/);
  assert.equal(edit(pub(account().accountId, base + 6 * H), base).scheduledAt, base, "换一个账号不受影响");
});

test("按平台覆盖：config 里改了就用改后的数，没改的平台仍是默认", () => {
  updateConfig({ plan: { rules: { platforms: { bilibili: { min_gap_minutes: 60, daily_cap: 2 } } } } });
  try {
    assert.equal(rulesOf("bilibili").minGapMs, 60 * MIN);
    assert.equal(rulesOf("bilibili").dailyCap, 2);
    assert.equal(rulesOf("tiktok").dailyCap, 10);
    const { accountId } = account("bilibili");
    const base = tomorrow() + 10 * H;
    pub(accountId, base);
    const mine = pub(accountId, base + 6 * H);
    let err;
    try {
      edit(mine, base + 30 * MIN);
    } catch (e) {
      err = e;
    }
    assert.equal(err.suggestedAt, base + 60 * MIN);
    // 配错的值（0、负数、字符串）退回默认，不会变成「不限制」。
    updateConfig({ plan: { rules: { platforms: { bilibili: { min_gap_minutes: 0, daily_cap: "x" } } } } });
    assert.equal(rulesOf("bilibili").minGapMs, 10 * MIN);
    assert.equal(rulesOf("bilibili").dailyCap, 10);
  } finally {
    updateConfig({ plan: { rules: { platforms: { bilibili: null } } } });
  }
});

test("只改标题、过去的时间、已确认的平台稿：原有行为不变", () => {
  const { accountId } = account();
  const id = pub(accountId, tomorrow() + 9 * H);
  assert.equal(h["publish.edit"]({ publishId: id, title: "新标题" }).title, "新标题");
  assert.throws(() => edit(id, Date.now() - 1000), /过去的时间/);
  h["publish.approve"]({ publishId: id });
  assert.throws(() => edit(id, tomorrow() + 11 * H), /不在等确认/);
});

test("nearestAvailable：纯函数在多条夹击下找到合规点", () => {
  const rules = rulesOf("tiktok");
  const base = tomorrow() + 12 * H;
  const taken = [base, base + 15 * MIN, base + 30 * MIN]; // 每 15 分钟一条，中间只剩 5 分钟缝，放不下
  const s = nearestAvailable(base + 16 * MIN, taken, rules, Date.now());
  assert.equal(violationAt(s, taken, rules), null);
  assert.equal(s, base + 40 * MIN, "夹缝放不下，落到最后一条之后 10 分钟");
});
