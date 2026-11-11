/* versekit Web 数据层：一次拉 /api/bootstrap 快照，之后读是同步的。
 *
 * 为什么是「同步门面」：本地应用的数据量很小，页面不需要为每次读都写一套 loading 状态；
 * 打开页面先拉一次快照，渲染时直接读内存。写操作（选组 / 建组）一律 POST 命令表派生的
 * HTTP 路由，成功后再刷新快照——页面看到的数字与 `vk --json`、`/api/bootstrap` 是同一份。
 *
 * 当前账号组存在守护进程的 meta 表里，不存 localStorage：换一台浏览器打开也还是同一个组，
 * 且 `vk group use` 与页面切组是同一条命令，不会出现「页面记的和 CLI 记的不一样」。
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
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error?.message ?? `HTTP ${res.status}`);
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

  function groupCounts(groupId) {
    const id = groupId ?? current()?.id;
    return group(id)?.counts ?? { works: 0, publishes: 0, publishedPublishes: 0 };
  }

  function groupFreshness(groupId) {
    const id = groupId ?? current()?.id;
    return group(id)?.freshness ?? snapshot?.freshness ?? { total: 0, fresh: 0, stale: 0, failing: 0, unknown: 0 };
  }

  /** 当前组口径（与总览页、`vk bootstrap --json` 同一份），不是跨组汇总。 */
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

  /** 建组 = 命令 `group.add`：服务端建组即进入，页面不需要再补一次 group.use。 */
  async function addGroup(name) {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("请填写账号组名称");
    const result = await request("/api/groups", { method: "POST", body: { name: clean } });
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
  function requireGroup({ entry = "/groups.html" } = {}) {
    if (current()) return current();
    location.replace(entry);
    return null;
  }

  VK.request = request;
  VK.bootstrap = bootstrap;
  VK.ready = ready;
  VK.snapshot = () => snapshot;
  VK.current = current;
  VK.groups = groups;
  VK.group = group;
  VK.accounts = accounts;
  VK.groupCounts = groupCounts;
  VK.groupFreshness = groupFreshness;
  VK.counts = counts;
  VK.freshness = freshness;
  VK.matrix = matrix;
  VK.rollup = rollup;
  VK.useGroup = useGroup;
  VK.addGroup = addGroup;
  VK.query = query;
  VK.requireGroup = requireGroup;
})();
