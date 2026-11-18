/* versekit Web 数据层：一次拉 /api/bootstrap 快照，之后读是同步的。
 *
 * 为什么是「同步门面」：本地应用的数据量很小，页面不需要为每次读都写一套 loading 状态；
 * 打开页面先拉一次快照，渲染时直接读内存。写操作（选组 / 建组）一律 POST 命令表派生的
 * HTTP 路由，成功后再刷新快照——页面看到的数字与命令行、`/api/bootstrap` 是同一份。
 *
 * 当前账号组存在守护进程的 meta 表里，不存 localStorage：换一台浏览器打开也还是同一个组，
 * 且页面切组与命令行切组是同一条命令，不会出现「页面记的和命令行记的不一样」。
 *
 * 这里不引用设计稿原型里的 localStorage 假数据：那些数字只用于视觉稿，真实数据只从 /api 来。
 */
(function () {
  const VK = (window.VK = window.VK || {});

  let snapshot = null;
  let inflight = null;

  async function request(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method,
      // 标明来自页面：服务端给页面的报错不带命令行提示（ACC-v3-nocli-02）。
      headers: { "x-vk-origin": "web", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      // 结构化细节（最近能排的时间、哪条平台稿、超限清单）挂在错误对象上，页面据此在原地说清楚。
      const err = new Error(data.error?.message ?? `HTTP ${res.status}`);
      for (const k of ["code", "suggestedAt", "publishId", "problems"]) if (data.error?.[k] != null) err[k] = data.error[k];
      throw err;
    }
    return data;
  }

  /**
   * 拉一次外壳快照。并发调用共享同一个在途请求：一个页面里两个模块同时 bootstrap 时，
   * 不该打两次 /api/bootstrap。
   */
  async function bootstrap({ force = false } = {}) {
    if (snapshot && !force) return snapshot;
    if (inflight && !force) return inflight;
    inflight = request("/api/bootstrap")
      .then((data) => {
        snapshot = data;
        return data;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const ready = (options) => bootstrap(options);

  function current() {
    return snapshot?.current ?? null;
  }

  function groups() {
    return snapshot?.groups ?? [];
  }

  function group(ref) {
    if (!ref) return null;
    const key = String(ref);
    return groups().find((g) => g.id === key || g.name === key) ?? null;
  }

  /** 账号读模型是 bootstrap 的全集；按组过滤在这里一次做完，页面不再各自判 group_id。 */
  function accounts(groupId) {
    const id = groupId ?? current()?.id ?? null;
    const all = snapshot?.accounts ?? [];
    if (!id) return [];
    return all.filter((a) => a.groupId === id);
  }

  /* 五个平台槽位的展示信息：平台清单由服务端矩阵列决定，这里只补自绘标识与授权方式。
   * 展示信息不参与「有没有账号 / 能不能添加」的判断——那些判断读 /api 的真实账号。 */
  const PLATFORM_STYLE = {
    xiaohongshu: { logo: "pl-xhs", auth: "扫码登录" },
    douyin: { logo: "pl-douyin", auth: "扫码登录" },
    bilibili: { logo: "pl-bili", auth: "授权登录" },
    youtube: { logo: "pl-youtube", auth: "Google 授权" },
    tiktok: { logo: "pl-tiktok", auth: "TikTok 授权" },
  };

  /** 当前组的五个平台槽位 = /api/bootstrap 的矩阵列 + 展示信息。 */
  function platforms() {
    const columns = snapshot?.matrix?.columns ?? [];
    return columns.map((column) => ({
      ...column,
      ...(PLATFORM_STYLE[column.platform] ?? { logo: "pl-generic", auth: "授权登录" }),
    }));
  }

  /** 账号也可能用旧别名（xhs / bili）落库；按列里的 aliases 归一到同一个槽位。 */
  function platformOf(account) {
    const platform = String(account?.platform ?? "");
    return platforms().find((column) => column.platform === platform || (column.aliases ?? []).includes(platform)) ?? null;
  }

  function account(id) {
    return (snapshot?.accounts ?? []).find((a) => a.id === id) ?? null;
  }

  function groupCounts(groupId) {
    const id = groupId ?? current()?.id;
    return group(id)?.counts ?? { works: 0, publishes: 0, publishedPublishes: 0 };
  }

  function groupFreshness(groupId) {
    const id = groupId ?? current()?.id;
    return group(id)?.freshness ?? snapshot?.freshness ?? { total: 0, fresh: 0, stale: 0, failing: 0, unknown: 0 };
  }

  /** 当前组口径（与总览页、命令行同一份），不是跨组汇总。 */
  function counts() {
    return snapshot?.counts ?? { works: 0, publishes: 0, publishedPublishes: 0 };
  }

  function freshness() {
    return snapshot?.freshness ?? { total: 0, fresh: 0, stale: 0, failing: 0, unknown: 0 };
  }

  function matrix() {
    return snapshot?.matrix ?? { columns: [], groups: [], totals: { groups: 0, accounts: 0 } };
  }

  function rollup() {
    return snapshot?.rollup ?? { readOnly: true, counts: null, freshness: null };
  }

  /** 选组 = 命令 `group.use`：POST 之后刷新快照，返回新的当前组。 */
  async function useGroup(ref) {
    if (!ref) throw new Error("先选一个账号组");
    const result = await request("/api/groups/current", { method: "POST", body: { group: String(ref) } });
    await bootstrap({ force: true });
    return result.current ?? current();
  }

  /** 改名 = 命令 `group.rename`：只改显示名，组 id 与组内账号、排期都不动。 */
  async function renameGroup(ref, name) {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("组名不能为空");
    const result = await request(`/api/groups/${encodeURIComponent(ref)}/rename`, {
      method: "POST",
      body: { group: String(ref), name: clean },
    });
    await bootstrap({ force: true });
    return result;
  }

  /** 建组 = 命令 `group.add`：服务端建组即进入，页面不需要再补一次 group.use。 */
  async function addGroup(name) {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("请填写账号组名称");
    const result = await request("/api/groups", { method: "POST", body: { name: clean } });
    await bootstrap({ force: true });
    return result;
  }

  /** 登记账号 = 命令 `account.add`：成功后刷新快照，回账号页立刻能看到它。 */
  async function addAccount({ platform, name, group } = {}) {
    const clean = String(name ?? "").trim();
    if (!platform) throw new Error("先选一个平台");
    if (!clean) throw new Error("请填写平台账号名");
    const groupId = group ?? current()?.id;
    if (!groupId) throw new Error("先选一个账号组");
    const result = await request("/api/accounts", {
      method: "POST",
      body: { platform, name: clean, group: groupId },
    });
    await bootstrap({ force: true });
    return result;
  }

  /** 重新登录 = 命令 `account.reauth`；返回的 next 是给人在电脑前照做的那一步。 */
  async function reauthAccount(accountId) {
    if (!accountId) throw new Error("先选一个账号");
    const result = await request(`/api/accounts/${encodeURIComponent(accountId)}/reauth`, {
      method: "POST",
      body: { accountId },
    });
    await bootstrap({ force: true });
    return result;
  }

  /** 移除账号 = 命令 `account.remove`：只让出槽位，不删历史。 */
  async function removeAccount(accountId) {
    if (!accountId) throw new Error("先选一个账号");
    const result = await request(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    await bootstrap({ force: true });
    return result;
  }

  /** 自动 / 仅手动 = 命令 `account.mode`。 */
  async function setAccountMode(accountId, mode) {
    if (mode !== "auto" && mode !== "manual") throw new Error("模式只能是 auto 或 manual");
    const result = await request(`/api/accounts/${encodeURIComponent(accountId)}/mode`, {
      method: "POST",
      body: { accountId, mode },
    });
    await bootstrap({ force: true });
    return result;
  }

  function query(params = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue;
      search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : "";
  }

  /** 日常页面入口守卫：没有当前组时落到选组页，而不是渲染一个空壳。 */
  function requireGroup({ entry = "/system#groups" } = {}) {
    if (current()) return current();
    location.replace(entry);
    return null;
  }

  /* ---------------------------------------------------------------- 排期
   *
   * 日历是「作品」的投影，不是 publish 行：一次排期 = 一个 work + N 条 publish。
   * 服务端的 schedule.list 已经按作品聚合、算好撞车，这里只做两件事：
   *   1. 预拉一个足够宽的窗口（前后各几个月），页面按天/周/月切片是纯内存操作；
   *   2. 把时间在「毫秒时间戳」与「本地 YYYY-MM-DDTHH:MM」之间转一次，页面只见后者。
   */
  const SCHEDULE_PAD_DAYS = 120;
  let schedule = { from: 0, to: 0, cards: [], conflicts: [], counts: {} };

  const pad2 = (n) => String(n).padStart(2, "0");

  /** 本地时间字符串：日历按人的本地日界线分格，不能用 toISOString（那是 UTC）。 */
  function toLocalStamp(ms) {
    const d = new Date(Number(ms));
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** 页面里输入的本地时间 -> 毫秒；非法时间返回 NaN，由调用方拒绝。 */
  function fromLocalStamp(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(text ?? "").trim());
    if (!m) return NaN;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
  }

  function dayStart(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  async function loadSchedule({ force = false } = {}) {
    const now = Date.now();
    if (!force && schedule.from && now >= schedule.from && now <= schedule.to) return schedule;
    const from = dayStart(now - SCHEDULE_PAD_DAYS * 864e5);
    const to = dayStart(now + SCHEDULE_PAD_DAYS * 864e5) + 864e5 - 1;
    const data = await request(`/api/schedule${query({ from, to, group: current()?.id ?? null })}`);
    schedule = {
      from,
      to,
      cards: (data.cards ?? []).map((card) => ({
        id: card.workId,
        workId: card.workId,
        group: current()?.id ?? null,
        title: card.title,
        at: toLocalStamp(card.at),
        atMs: card.at,
        state: card.state,
        conflict: Boolean(card.conflict),
        conflicts: card.conflicts ?? [],
        platforms: (card.platforms ?? []).map((p) => ({
          id: p.platform,
          platform: p.platform,
          state: p.state,
          publishState: p.publishState,
          accountId: p.accountId,
          publishId: p.publishId,
        })),
      })),
      /* 服务端的撞车条目是 {a:{workId,at,...}, b:{...}}；设计稿页面按
       * {platform, at, a:<cardId>, b:<cardId>} 用，这里转一次，页面不改。 */
      conflicts: (data.conflicts ?? []).map((c) => ({
        platform: c.platform,
        at: toLocalStamp(Math.max(c.a?.at ?? 0, c.b?.at ?? 0)),
        a: c.a?.workId,
        b: c.b?.workId,
        gapMin: c.gapMin,
      })),
      counts: data.counts ?? { works: 0, publishes: 0, conflicts: 0 },
    };
    return schedule;
  }

  /** 同步读：窗口已经拉过；没拉过就先给空，页面在 ready() 之后重渲染。 */
  function scheduled() {
    return schedule.cards;
  }

  function scheduledBetween(_group, fromDay, toDay) {
    return schedule.cards.filter((card) => {
      const day = card.at.slice(0, 10);
      return day >= fromDay && day <= toDay;
    });
  }

  /** 设计稿页面按 Set 用（`.has(id)`）；服务端给的是作品卡片，这里转成 id 集合。 */
  function conflictIds() {
    return new Set(schedule.cards.filter((card) => card.conflict).map((card) => card.id));
  }

  /** 改期 = 命令 schedule.move：整作品一起移；撞车未 force 时服务端会拒绝并回结构化冲突。 */
  async function scheduleMove(workId, atText, { force = false } = {}) {
    const at = fromLocalStamp(atText);
    if (!Number.isFinite(at)) throw new Error("时间格式不对：" + atText);
    const result = await request(`/api/schedule/${encodeURIComponent(workId)}/move`, {
      method: "POST",
      body: { workId, at, force },
    });
    // 撞车时服务端是 200 + saved:false（不是错误码）：不在这里转成异常，页面就会以为改成功了。
    if (!result.saved) {
      const first = (result.conflicts ?? [])[0];
      const gap = first?.gapMin ? `相隔 ${first.gapMin} 分钟` : "同一账号时间太近";
      const err = new Error(`和「${first?.b?.title ?? first?.a?.title ?? "另一条排期"}」撞车（${gap}）`);
      err.code = result.code ?? "E_SCHEDULE_CONFLICT";
      err.conflicts = result.conflicts ?? [];
      throw err;
    }
    await loadSchedule({ force: true });
    return result;
  }

  /** 取消排期 = 命令 schedule.cancel；作品本身不删。 */
  async function scheduleCancel(workId) {
    const result = await request(`/api/schedule/${encodeURIComponent(workId)}/cancel`, {
      method: "POST",
      body: { workId },
    });
    await loadSchedule({ force: true });
    return result;
  }

  /* 原型门面里还有 groupLabel / url / platforms 三件套：设计稿页面按短 id（bili/xhs）
   * 取平台名，真实数据用全名（bilibili/xiaohongshu）。这里做一次别名归一，页面不用改写。 */
  const PLATFORM_ALIAS = { bili: "bilibili", xhs: "xiaohongshu" };

  const PLATFORM_NAME = {
    xiaohongshu: "小红书", douyin: "抖音", bilibili: "B站", youtube: "YouTube", tiktok: "TikTok",
  };
  const PLATFORM_LOGO = {
    xiaohongshu: "pl-xhs", douyin: "pl-douyin", bilibili: "pl-bili", youtube: "pl-youtube", tiktok: "pl-tiktok",
  };
  const PLATFORM_AUTH = {
    xiaohongshu: "扫码登录", douyin: "扫码登录", bilibili: "授权登录", youtube: "Google 授权", tiktok: "TikTok 授权",
  };

  /** 平台展示信息：列由服务端矩阵决定，名字/标识/授权方式在这里补齐。
   *  不依赖具体页面模块，日历页与账号页共用同一份。 */
  function platformMap() {
    const map = {};
    for (const column of snapshot?.matrix?.columns ?? []) {
      const platform = column.platform;
      const entry = {
        name: PLATFORM_NAME[platform] ?? column.label ?? platform,
        logo: PLATFORM_LOGO[platform] ?? "pl-generic",
        auth: PLATFORM_AUTH[platform] ?? "授权登录",
        id: platform,
      };
      map[platform] = entry;
      for (const alias of column.aliases ?? []) map[alias] = entry;
    }
    for (const [short, full] of Object.entries(PLATFORM_ALIAS)) if (map[full] && !map[short]) map[short] = map[full];
    return map;
  }

  function groupLabel(ref) {
    return group(ref)?.name ?? String(ref ?? "");
  }

  function currentId() {
    return current()?.id ?? null;
  }

  function url(page, groupRef) {
    const id = groupRef ?? currentId();
    return id ? `${page}${page.includes("?") ? "&" : "?"}group=${encodeURIComponent(id)}` : page;
  }

  /* ---------------------------------------------------------------- v2 页面数据
   *
   * 今天、作品、作品详情都只读 core 算好的结果（overview.buildToday / store.workView），
   * 页面不自己聚合、不自己推导状态：口径改一处就够。
   */
  const media = (versionId) => `/media/${encodeURIComponent(String(versionId ?? ""))}`;

  const today = () => request("/api/today");
  const works = () => request("/api/works");
  const work = (workId) => {
    if (!workId) throw new Error("先指定一个作品");
    return request(`/api/works/${encodeURIComponent(workId)}`);
  };

  /* 确认、改、跳过、重试：每一个都对应 commands.mjs 里的命令，页面不自己拼状态。
   * 成功后由页面重新拉一次 today / work——数字只认服务端那一份。 */
  /** when：scheduled（预约发，默认）或 now（现在发）。整批在成片面板底栏选（ACC-v3-time-08）。 */
  async function approveCut(cutId, when = "scheduled") {
    if (!cutId) throw new Error("先指定一支成片");
    return request("/api/publishes/approve", { method: "POST", body: when === "now" ? { cutId, when } : { cutId } });
  }

  /** 改内容 = 命令 cut.edit：一次提交；rev 是打开编辑时读到的成片版本号。 */
  async function editCut(cutId, { rev, language = null, generic = null, platforms = null }) {
    if (!cutId) throw new Error("先指定一支成片");
    const body = { cutId, rev };
    if (language) body.language = language;
    if (generic && Object.keys(generic).length) body.generic = generic;
    if (platforms && Object.keys(platforms).length) body.platforms = platforms;
    return request(`/api/cuts/${encodeURIComponent(cutId)}/edit`, { method: "POST", body });
  }

  async function approvePublish(publishId) {
    if (!publishId) throw new Error("先指定一条平台稿");
    return request("/api/publishes/approve", { method: "POST", body: { publishId } });
  }

  async function publishNow(publishId) {
    if (!publishId) throw new Error("先指定一条平台稿");
    return request(`/api/publishes/${encodeURIComponent(publishId)}/now`, { method: "POST", body: { publishId } });
  }

  async function publishManual(publishId) {
    if (!publishId) throw new Error("先指定一条平台稿");
    return request(`/api/publishes/${encodeURIComponent(publishId)}/manual`, { method: "POST", body: { publishId } });
  }

  async function skipCut(cutId) {
    if (!cutId) throw new Error("先指定一支成片");
    return request(`/api/cuts/${encodeURIComponent(cutId)}/skip`, { method: "POST", body: { cutId } });
  }

  /** 改标题 / 改时间 = 命令 publish.edit；时间是毫秒，页面传本地时间字符串。 */
  async function editPublish(publishId, { title = null, at = null, body: text = null, tags = null } = {}) {
    if (!publishId) throw new Error("先指定一条平台稿");
    const body = { publishId };
    if (title != null) body.title = String(title).trim();
    if (text != null) body.body = String(text);
    if (tags != null) body.tags = Array.isArray(tags) ? tags : VK.parseTags(tags);
    if (at != null) {
      const ms = typeof at === "number" ? at : fromLocalStamp(at);
      if (!Number.isFinite(ms)) throw new Error("时间格式不对：" + at);
      body.at = ms;
    }
    return request(`/api/publishes/${encodeURIComponent(publishId)}/edit`, { method: "POST", body });
  }

  async function retryPublish(publishId) {
    if (!publishId) throw new Error("先指定一条平台稿");
    return request(`/api/publishes/${encodeURIComponent(publishId)}/retry`, { method: "POST", body: { publishId } });
  }

  /**
   * 账号的登录状态，对人展示的唯一一份说法（系统页账号表与侧栏底部摘要共用，所以两处数字不会不一样）。
   * 读的是 account.list 的 displayState：ok 超过 24 小时没检查会变成 unconfirmed（待确认），不再显示「正常」。
   * key: ok 正常 · unconfirmed 待确认 · relogin 要重新登录 · down 没连上
   */
  function loginState(account) {
    const state = account?.displayState ?? account?.state ?? "unknown";
    if (state === "ok") return { key: "ok", label: "正常", cls: "done" };
    if (state === "unconfirmed") return { key: "unconfirmed", label: "待确认", cls: "wait" };
    if (state === "expiring" || state === "expired") return { key: "relogin", label: "要重新登录", cls: "bad" };
    if (state === "banned") return { key: "relogin", label: "被平台限制", cls: "bad" };
    return { key: "down", label: "没连上", cls: "bad" };
  }

  /** 一个账号组的账号（account.list --group）：带 displayState、lastCheckedAt、quota（今天还能发）。 */
  async function groupAccounts(groupId) {
    const id = groupId ?? current()?.id;
    if (!id) return [];
    const data = await request("/api/accounts" + query({ group: id }));
    return data.accounts ?? [];
  }

  VK.request = request;
  VK.loginState = loginState;
  VK.groupAccounts = groupAccounts;
  VK.bootstrap = bootstrap;
  VK.ready = ready;
  VK.snapshot = () => snapshot;
  VK.current = current;
  VK.groups = groups;
  VK.group = group;
  VK.platforms = platforms;
  VK.platformOf = platformOf;
  VK.account = account;
  VK.accounts = accounts;
  VK.groupCounts = groupCounts;
  VK.groupFreshness = groupFreshness;
  VK.counts = counts;
  VK.freshness = freshness;
  VK.matrix = matrix;
  VK.rollup = rollup;
  VK.useGroup = useGroup;
  VK.addGroup = addGroup;
  VK.renameGroup = renameGroup;
  VK.addAccount = addAccount;
  VK.reauthAccount = reauthAccount;
  VK.removeAccount = removeAccount;
  VK.setAccountMode = setAccountMode;
  VK.query = query;
  VK.requireGroup = requireGroup;
  VK.loadSchedule = loadSchedule;
  VK.scheduled = scheduled;
  VK.scheduledBetween = scheduledBetween;
  VK.conflictIds = conflictIds;
  VK.conflicts = () => schedule.conflicts;
  VK.scheduleMove = scheduleMove;
  VK.scheduleRemove = scheduleCancel;
  VK.platformMap = platformMap;
  VK.groupLabel = groupLabel;
  VK.currentId = currentId;
  VK.url = url;
  VK.toLocalStamp = toLocalStamp;
  VK.fromLocalStamp = fromLocalStamp;
  VK.platsOf = (item) => (item?.platforms ?? []).map((p) => (typeof p === "string" ? { id: p, state: item.state ?? "scheduled" } : p));
  VK.countsOf = (list) => ({
    works: list.length,
    publishes: list.reduce((n, item) => n + (item.platforms?.length ?? 0), 0),
  });
  VK.media = media;
  VK.today = today;
  VK.works = works;
  VK.work = work;
  VK.approveCut = approveCut;
  VK.editCut = editCut;
  VK.approvePublish = approvePublish;
  VK.publishNow = publishNow;
  VK.publishManual = publishManual;
  VK.skipCut = skipCut;
  /** 话题输入：逗号、顿号、空格、# 都能分；去掉 # 和重复。 */
  VK.parseTags = (text) => [...new Set(String(text ?? "").split(/[,，、\s]+/).map((t) => t.trim().replace(/^#+/, "")).filter(Boolean))];
  VK.editPublish = editPublish;
  VK.retryPublish = retryPublish;
})();
