// The daemon is the only writer, so its contract is worth pinning: wrong verb ≠ missing route,
// bad args are 400 not 500, and the unix socket behaves exactly like the loopback port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Writable } from "node:stream";

const HOME = mkdtempSync(join(tmpdir(), "vk-daemon-"));
process.env.VK_HOME = HOME;

const core = await import("../src/index.mjs");
const { startDaemon, coerceArgs, createDispatcher } = await import("../src/daemon.mjs");
const { findCommand } = await import("../src/commands.mjs");

let daemon;
let base;

const unix = (method, path, body) =>
  new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(
      {
        socketPath: daemon.socketPath,
        path,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

before(async () => {
  core.migrate();
  const db = core.open();
  db.prepare("INSERT INTO account (id, platform, handle, created_at) VALUES ('a1','tiktok','@x',1)").run();
  db.prepare("INSERT INTO work (id, title, asset_path, created_at) VALUES ('w1','t','/tmp/a.mp4',1)").run();
  db.prepare("INSERT INTO publish (id, work_id, account_id, state, created_at, updated_at) VALUES ('p1','w1','a1','failed',1,1)").run();

  daemon = await startDaemon({
    runQueue: false,
    port: 0,
    socketPath: join(HOME, "vk.sock"),
    handlers: {
      now: () => ({ accounts: { total: 1 }, queue: { queued: 0, running: 0, failed: 0 } }),
      "publish.retry": ({ publishId }) => ({ publishId, state: "queued" }),
      "stats.works": ({ range }) => ({ range, rows: [] }),
    },
  });
  base = `http://127.0.0.1:${daemon.port}`;
});

after(async () => {
  await daemon?.close();
});

test("GET /api/now returns the handler's shape", async () => {
  const res = await fetch(`${base}/api/now`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.total, 1);
});

test("an unknown path is 404, a known path with the wrong verb is 405", async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/now`, { method: "POST" })).status, 405);
});

test("bad args are a 400 with a readable reason, not a 500", async () => {
  const res = await fetch(`${base}/api/publishes/p1/retry`, { method: "POST", body: JSON.stringify({ publishId: "x" }) });
  // parseArgs merges path params, so this one succeeds; use an unknown field to provoke a rejection
  assert.equal(res.status, 200);
  const bad = await fetch(`${base}/api/stats/works?range=7d&nope=1`);
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.match(body.error.message, /nope/);
});

test("query strings reach the handler as declared types", async () => {
  const res = await fetch(`${base}/api/stats/works?range=7d`);
  const body = await res.json();
  assert.equal(body.range, "7d");
});

test("a command with no handler is 501, not a silent 200", async () => {
  const res = await fetch(`${base}/api/doctor`);
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error.code, "not_implemented");
});

test("the unix socket serves the same dispatcher as loopback", async () => {
  const viaSocket = await unix("GET", "/api/now");
  assert.equal(viaSocket.status, 200);
  assert.equal(viaSocket.body.accounts.total, 1);
});

test("a mutating command over the socket is audited", async () => {
  const before = core.open().prepare("SELECT COUNT(*) n FROM command_audit WHERE name='publish.retry'").get().n;
  const res = await unix("POST", "/api/publishes/p1/retry", {});
  assert.equal(res.status, 200);
  assert.equal(res.body.state, "queued");
  const rows = core.open().prepare("SELECT * FROM command_audit WHERE name='publish.retry' ORDER BY created_at").all();
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].result, "ok");
  assert.equal(rows[0].origin, "cli");
});

test("coerceArgs only converts types the command declares", () => {
  const collect = findCommand("collect.now");
  assert.deepEqual(coerceArgs(collect, { publishId: "p1" }), { publishId: "p1" });
  const create = findCommand("publish.create");
  const out = coerceArgs(create, { to: "tiktok,bilibili", dryRun: "false", schedule: "1700000000000" });
  assert.deepEqual(out.to, ["tiktok", "bilibili"]);
  assert.equal(out.dryRun, false);
  assert.equal(out.schedule, 1700000000000);
});

// ---------------------------------------------------------------- 静态页与资产上传

test("本地控制台首页就是今天的待办，静态资源带了正确类型", async () => {
  // v2 外壳（#148）：`/` 进今天页。旧的九页在 #148 之后不再有页面，首页也不能再指向它们，
  // 否则导航一定会漂回旧 UI。
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  const html = await index.text();
  assert.match(html, /versekit/);
  assert.match(html, /data-page="today"/, "首页必须是今天页");

  const css = await fetch(`${base}/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);

  const js = await fetch(`${base}/shell.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  const shell = await (await fetch(`${base}/shell.js`)).text();
  for (const href of ["/today", "/works", "/data", "/system"]) {
    assert.match(shell, new RegExp(`href: "${href}"`), `共享导航必须指向 ${href}`);
  }
});

test("旧单页已下线：index.html / app.js / style.css 不再提供", async () => {
  for (const path of ["/index.html", "/app.js", "/style.css"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, `${path} 应该已删除`);
  }
});

test("v2 四个页面都能打开，侧栏四项顺序与设计稿一致，没做的页面说「还没做」", async () => {
  const PAGES = [
    ["/today", "today"],
    ["/works", "works"],
    ["/work", "works"],
    ["/data", "data"],
    ["/system", "system"],
  ];
  for (const [path, page] of PAGES) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} 必须返回页面，不能 404（ACC-v2-web-01）`);
    const html = await res.text();
    assert.match(html, /src="\/api\.js"/, `${path} 必须由 api.js 拉真实数据`);
    assert.match(html, /src="\/shell\.js"/, `${path} 必须用同一个外壳`);
    assert.doesNotMatch(html, /src=["'][^"']*store\.js/, `${path} 不能引用原型 store.js 的假数据`);
    assert.match(html, new RegExp(`data-page="${page}"`), `${path} 的 data-page 应该是 ${page}`);
    assert.doesNotMatch(html, /演示数据|露营小记/, `${path} 不能带原型的演示数据`);

    // 导航：正好四项，顺序 today → works → data → system，且只有一个当前页。
    const nav = html.match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const items = [...nav.matchAll(/href="([a-z0-9-]+\.html)"/g)].map((m) => m[1]);
    assert.deepEqual(items, ["today.html", "works.html", "data.html", "system.html"], `${path} 的侧栏顺序不对`);
    assert.equal((nav.match(/aria-current="page"/g) ?? []).length, 1, `${path} 的当前页标记必须正好一处`);
  }

  // 还没做的页面要有空状态，不能是一片空白或者一句看不懂的话。（作品与作品详情 #149 已做完，不在此列。）
  for (const path of ["/data", "/system"]) {
    assert.match(await (await fetch(`${base}${path}`)).text(), /这一页还没做/, `${path} 要显示「还没做」的空状态`);
  }

  // 设计闸门按设计稿文件名取页面：两个名字都要能打开。
  for (const path of ["/today.html", "/works.html", "/work.html", "/data.html", "/system.html"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, `${path} 应该能打开`);
  }
});

test("所有导航目标都存在，页面之间没有死链", async () => {
  const shell = await (await fetch(`${base}/shell.js`)).text();
  const hrefs = [...shell.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]).filter((h) => h.startsWith("/"));
  assert.equal(hrefs.length, 4, "v2 外壳只有四个页面");
  for (const href of new Set(hrefs)) {
    const res = await fetch(`${base}${href}`);
    assert.equal(res.status, 200, `导航 ${href} 必须是可打开的页面`);
    assert.doesNotMatch(await res.text(), /404/, `${href} 不能是 404 页`);
  }
});

test("静态目录之外的文件一律 404（不许用 .. 读仓库）", async () => {
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/nope.html`)).status, 404);
});

test("应用外壳：选组页与 api.js 由守护进程托管，数据只从 /api 来", async () => {
  const page = await fetch(`${base}/groups.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /src="\/api\.js"/, "选组页必须由 api.js 拉真实快照");
  assert.doesNotMatch(html, /src=["'][^"']*store\.js/, "不能引用原型 store.js 的假数据");

  const api = await fetch(`${base}/api.js`);
  assert.equal(api.status, 200);
  assert.match(api.headers.get("content-type"), /javascript/);
  assert.match(await api.text(), /\/api\/bootstrap/, "api.js 必须真的拉 /api/bootstrap");

  // 日常页面也要接同一个外壳：今天页加载 api.js 与 shell.js，导航只有一份来源。
  const index = await fetch(`${base}/today`);
  const indexHtml = await index.text();
  assert.match(indexHtml, /src="\/api\.js"/);
  assert.match(indexHtml, /src="\/shell\.js"/);
  assert.match(indexHtml, /data-page="today"/);
  assert.match(indexHtml, /\/api\/today|VK\.today/, "今天页必须读 /api/today");
});

test("账号与旧流程仍在：添加账号、账号组、发布台、任务页能打开，旧页面不再冒充新页面", async () => {
  // 账号与登录的流程这一轮先留在旧页面上（#148 的「不可动」），从系统页给入口。
  for (const path of ["/accounts/add", "/groups", "/groups.html", "/publish", "/runs", "/tasks"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} 应该返回页面`);
    assert.match(res.headers.get("content-type"), /text\/html/, `${path} 必须是 HTML`);
    const html = await res.text();
    assert.match(html, /src="\/api\.js"/, "页面必须由 api.js 拉真实快照");
    assert.doesNotMatch(html, /src=["'][^"']*store\.js/, "不能引用原型 store.js 的假数据");
  }

  const add = await (await fetch(`${base}/accounts/add`)).text();
  assert.match(add, /id="platform-grid"/, "添加页要有平台选择网格");
  assert.match(add, /id="group-name"/, "添加页要显示锁定的账号组");
  assert.match(add, /VK\.addAccount|account\.add/, "完成后走命令 account.add");
  assert.match(add, /\/api\/accounts/, "占用者读命令 account.list --group 的 occupants");

  // /accounts 不再返回旧账号墙：它落到系统页（账号管理并入系统）。旧页面文件本身已经删除。
  const accounts = await fetch(`${base}/accounts`);
  assert.equal(accounts.status, 200);
  const accountsHtml = await accounts.text();
  assert.match(accountsHtml, /data-page="system"/, "/accounts 应该落到系统页");
  assert.doesNotMatch(accountsHtml, /id="slots"|id="detail"/, "旧的账号墙已经不存在了");

  // 删掉的四个页面：旧 URL 与旧文件名都不再提供（不是 200 的旧页面）。
  for (const path of ["/account-wall.html", "/overview", "/overview.html", "/matrix", "/matrix.html", "/calendar", "/calendar.html"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, `${path} 应该已经删除`);
  }

  // 发布计划按 PRD 不再单独成页：/plan 进今天页看「接下来要发」。
  const plan = await fetch(`${base}/plan`);
  assert.equal(plan.status, 200);
  assert.match(await plan.text(), /data-page="today"/, "/plan 应该落到今天页");
});

test("资产上传落到 state/assets，文件名被清洗，内容是原样", async () => {
  const res = await fetch(`${base}/api/assets`, {
    method: "POST",
    headers: { "x-vk-filename": encodeURIComponent("../我的 视频.mp4"), "content-type": "application/octet-stream" },
    body: Buffer.from("video-bytes"),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.path.includes("/assets/"), body.path);
  assert.ok(!body.path.includes(".."), "文件名里的 .. 必须被清掉");
  assert.ok(existsSync(body.path));
  assert.equal(readFileSync(body.path, "utf8"), "video-bytes");
});

test("空文件上传会被拒绝，而不是留下一个 0 字节素材", async () => {
  const res = await fetch(`${base}/api/assets`, { method: "POST", headers: { "x-vk-filename": "empty.mp4" }, body: Buffer.alloc(0) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "empty_asset");
});

// ---------------------------------------------------------------- /media（今天页看片）

function addVersion(id, assetPath, language = id) {
  const db = core.open();
  if (!db.prepare("SELECT 1 FROM cut WHERE id = 'cut_media'").get()) {
    db.prepare("INSERT INTO cut (id, work_id, title, position, created_at) VALUES ('cut_media','w1','长片',0,1)").run();
  }
  db.prepare(
    "INSERT INTO cut_version (id, cut_id, language, asset_path, created_at) VALUES (?, 'cut_media', ?, ?, 1)",
  ).run(id, language, assetPath);
}

/** 走 dispatcher 本身：访问控制与路由都在它里面，不需要真占一个端口。 */
function fakeDispatch() {
  const out = { status: 0, headers: {}, body: "" };
  const res = new Writable({
    write(chunk, _enc, cb) {
      out.body += chunk.toString("utf8");
      cb();
    },
  });
  res.writeHead = (status, headers) => {
    out.status = status;
    out.headers = headers ?? {};
  };
  return { res, out };
}

const dispatchOnce = async (req) => {
  const { res, out } = fakeDispatch();
  const finished = new Promise((resolve) => res.on("finish", resolve));
  await createDispatcher({ handlers: {} })(req, res);
  await finished;
  return out;
};

test("ACC-v2-web-02 /media 按 versionId 交素材：正常、Range、HEAD", async () => {
  const file = join(HOME, "clip.mp4");
  const bytes = Buffer.from("0123456789abcdef");
  writeFileSync(file, bytes);
  addVersion("ver_media_ok", file);

  const full = await fetch(`${base}/media/ver_media_ok`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("cache-control"), "no-store");
  assert.equal(await full.text(), bytes.toString("utf8"));

  const ranged = await fetch(`${base}/media/ver_media_ok`, { headers: { range: "bytes=0-3" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 0-3/${bytes.length}`);
  assert.equal(await ranged.text(), "0123");

  const tail = await fetch(`${base}/media/ver_media_ok`, { headers: { range: "bytes=-4" } });
  assert.equal(tail.status, 206);
  assert.equal(await tail.text(), "cdef");

  const unsatisfiable = await fetch(`${base}/media/ver_media_ok`, { headers: { range: "bytes=999-1000" } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${bytes.length}`);

  const head = await fetch(`${base}/media/ver_media_ok`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("/media 只认库里的版本：未知 id、穿越、文件不在、类型不支持都不给文件", async () => {
  const file = join(HOME, "clip.mp4");
  if (!existsSync(file)) writeFileSync(file, "0123456789abcdef");

  // 未知版本
  const unknown = await fetch(`${base}/media/ver_nope`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "not_found");

  // 穿越：URL 里的路径片段只会被当成一个 id 去查库，不会被当路径用。
  for (const path of ["/media/..%2F..%2Fpackage.json", "/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, `${path} 不能拿到文件`);
    const text = await res.text();
    assert.doesNotMatch(text, /root:/, "不能把系统文件发出去");
    assert.doesNotMatch(text, /"name":\s*"versekit"/, "不能把仓库文件发出去");
  }

  // 库里有这一行，但文件已经不在：说人话，不静默。
  addVersion("ver_media_gone", join(HOME, "moved-away.mp4"));
  const gone = await fetch(`${base}/media/ver_media_gone`);
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error.code, "media_missing");

  // 类型不在白名单（不是视频也不是图片）：不给下载。
  const txt = join(HOME, "notes.txt");
  writeFileSync(txt, "secret");
  addVersion("ver_media_txt", txt);
  const unsupported = await fetch(`${base}/media/ver_media_txt`);
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json()).error.code, "media_unsupported");
});

test("/media 的访问控制和 /api 一样：非本机请求拿不到任何字节", async () => {
  const file = join(HOME, "clip.mp4");
  if (!existsSync(file)) writeFileSync(file, "0123456789abcdef");
  if (!core.open().prepare("SELECT 1 FROM cut_version WHERE id = 'ver_media_ok'").get()) addVersion("ver_media_ok", file);

  const remote = await dispatchOnce({ method: "GET", url: "/media/ver_media_ok", headers: {}, socket: { remoteAddress: "192.168.1.7" } });
  assert.equal(remote.status, 403, "局域网里的设备不能直接读素材文件");
  assert.equal(remote.body.includes("0123"), false);

  // 同一个 dispatcher 只放行 loopback：本机能拿到字节。
  const local = await dispatchOnce({ method: "GET", url: "/media/ver_media_ok", headers: {}, socket: { remoteAddress: "127.0.0.1" } });
  assert.equal(local.status, 200);
  assert.equal(local.body, "0123456789abcdef");
});

test("GET /api/stream 推实时状态，第一帧就带队列与通道", async () => {
  const res = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: daemon.port, path: "/api/stream", headers: { accept: "text/event-stream" } }, resolve);
    req.on("error", reject);
    req.end();
  });
  assert.match(res.headers["content-type"], /text\/event-stream/);

  const dataLine = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`6 秒内没有收到 data 帧：${buf.slice(0, 120)}`)), 6000);
    res.on("data", (chunk) => {
      buf += chunk.toString();
      const line = buf.split("\n").find((l) => l.startsWith("data: "));
      if (!line) return;
      clearTimeout(timer);
      resolve(line.slice(6));
    });
  });

  const frame = JSON.parse(dataLine);
  assert.ok(frame.status.queue && typeof frame.status.queue.queued === "number");
  assert.ok(Array.isArray(frame.publishes));
  assert.ok(Array.isArray(frame.runs));
  res.destroy();
});
