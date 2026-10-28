#!/usr/bin/env node
// 三端一致门禁（BLUEPRINT §3.9「commands-parity」/ ARCHITECTURE §12）。
//
// 三端一致律：命令只在 packages/core/src/commands.mjs 定义一次，CLI / HTTP / 卡片按钮都由它派生。
// 派生不等于一致——只要有人手写第二张表，就会漂。这个脚本把四件事钉在一起：
//
//   1. 除引导命令 init 外，每条命令都必须有 http { method, path }——CLI 与 Web 走同一个
//      守护进程，没有路由就等于没有实现。localOnly 是另一个维度：能不能被卡片按钮触发。
//      「忘了写 http」和「决定只能本机触发」长得一样，只有 localOnly 能把它们区分开。
//   2. buildRoutes() 无重复，且每条路由都能被 matchRoute 匹配回自己（含 :param 与查询串）。
//   3. cardButtons() 的每个按钮都能在命令表里找到，且那条命令 remote === true。
//      按钮能远程触发 = 它能写东西，所以必须有 remote / 幂等 / 审计三件套。
//   4. 真正 spawn `node packages/cli/src/vk.mjs commands`，解析 JSON，与注册表投影逐字段比对：
//      命令集合、http「方法 路径」、卡片 label（外加 remote，防止按钮语义漂移）。
//      这是三端一致的执行版：不是读同一份源码，而是读产品真实吐出来的东西。
//
// 失败：打印「哪条断言 · 实际差异 · 怎么修」，process.exit(1)。
// 可重复运行、无副作用：只读注册表，CLI 子进程跑的是 commands（不建库、不联网）。
//
// 用法：node scripts/ci/parity.mjs   （npm run check:parity）

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NAME = "三端一致门禁 parity";

const results = [];
const ok = (id, detail) => results.push({ id, ok: true, detail });
const bad = (id, detail, fix) => results.push({ id, ok: false, detail, fix });
const skip = (id, reason) => results.push({ id, ok: null, detail: reason });

// ---------------------------------------------------------------- 加载注册表
//
// 动态 import：routes.mjs 在模块顶层就 buildRoutes()，路由写坏时 import 本身会抛错。
// 静态 import 会让脚本直接崩掉、看不到「哪条断言」，所以这里把加载失败也变成一条断言。

let COMMANDS = null;
let findCommand = null;
let routesApi = null;

try {
  ({ COMMANDS, findCommand } = await import("../../packages/core/src/commands.mjs"));
} catch (err) {
  bad("parity.registry.commands-load", `加载 commands.mjs 失败：${err.message}`, "命令表必须能独立 import；先修 commands.mjs 的语法或顶层代码");
}

try {
  routesApi = await import("../../packages/core/src/routes.mjs");
} catch (err) {
  bad(
    "parity.routes.load",
    `加载 routes.mjs 失败：${err.message}`,
    "路由在模块加载阶段就 buildRoutes()：重复的 method+path、非法 HTTP 方法或路径都会让它抛错，先修 commands.mjs 的 http 字段",
  );
}

// ---------------------------------------------------------------- 1. 命令的 http / localOnly

if (COMMANDS) {
  const missing = COMMANDS.filter((c) => c.name !== "init" && c.http == null);
  if (missing.length) {
    bad(
      "parity.commands.http-required",
      `${missing.length} 条命令没有 http 路由：${missing.map((c) => c.name).join(", ")}`,
      "给命令补 http: { method, path }；只有 init 能在落库之前没有服务可调",
    );
  } else {
    const withHttp = COMMANDS.filter((c) => c.http != null).length;
    ok("parity.commands.http-required", `${COMMANDS.length} 条命令：${withHttp} 条有 http，init 为引导命令`);
  }

  const contradictions = [];
  for (const c of COMMANDS) {
    if (c.localOnly !== true) continue;
    if (c.remote === true) contradictions.push(`${c.name} 既 localOnly=true 又 remote=true（本机专属命令不可能被卡片按钮触发）`);
    if (c.card != null) contradictions.push(`${c.name} 既 localOnly=true 又有卡片按钮`);
  }
  if (contradictions.length) {
    bad(
      "parity.commands.local-only-contradiction",
      contradictions.join("；"),
      "localOnly 的意思是「不能被卡片触发」：去掉 remote / card，或去掉 localOnly 并补上远程触发所需的幂等键与审计",
    );
  } else {
    ok("parity.commands.local-only-contradiction", "没有 localOnly 与卡片 / remote 自相矛盾的命令");
  }
}

// ---------------------------------------------------------------- 2. 路由无重复 + 自匹配

if (!routesApi) {
  skip("parity.routes.unique", "上游 routes.mjs 加载失败");
  skip("parity.routes.match-self", "上游 routes.mjs 加载失败");
  skip("parity.routes.query-string", "上游 routes.mjs 加载失败");
} else {
  let routes = null;
  try {
    routes = routesApi.buildRoutes();
    ok("parity.routes.unique", `${routes.length} 条路由，method + path 无重复`);
  } catch (err) {
    bad("parity.routes.unique", `buildRoutes() 抛错：${err.message}`, "让每条命令的 http.method + http.path 组合唯一；两条命令抢一条路由时，先决定归谁");
  }

  if (!routes) {
    skip("parity.routes.match-self", "上游 parity.routes.unique 失败");
    skip("parity.routes.query-string", "上游 parity.routes.unique 失败");
  } else {
    // :param 换成具体值再匹配，确认「路由能回到定义它的那条命令」。
    const concretePath = (path) =>
      path
        .split("/")
        .map((segment) => (segment.startsWith(":") ? `probe-${segment.slice(1)}` : segment))
        .join("/");

    const notBack = [];
    for (const route of routes) {
      const concrete = concretePath(route.path);
      const hit = routesApi.matchRoute(route.method, concrete, routes);
      if (!hit) {
        notBack.push(`${route.command}: ${route.method} ${concrete} 没有匹配到任何路由`);
        continue;
      }
      if (hit.command !== route.command) {
        notBack.push(`${route.command}: ${route.method} ${concrete} 匹配到了 ${hit.command}`);
        continue;
      }
      const wantKeys = [...route.names].sort().join(",");
      const gotKeys = Object.keys(hit.params).sort().join(",");
      if (wantKeys !== gotKeys) {
        notBack.push(`${route.command}: 参数名 ${JSON.stringify(gotKeys)} ≠ 定义的 ${JSON.stringify(wantKeys)}`);
        continue;
      }
      for (const name of route.names) {
        if (hit.params[name] !== `probe-${name}`) {
          notBack.push(`${route.command}: 参数 ${name} 回读为 ${JSON.stringify(hit.params[name])}，期望 "probe-${name}"`);
        }
      }
    }
    if (notBack.length) {
      bad("parity.routes.match-self", notBack.join("；"), "路由编译（compile）与 matchRoute 必须使用同一张表；检查 :param 命名和正则转义，别让路径里的特殊字符吃掉路由");
    } else {
      ok("parity.routes.match-self", `${routes.length} 条路由都能 matchRoute 回自己，:param 正常回填`);
    }

    // 调用方传的是原始 request target（`/api/stats/works?range=7d`），查询串必须在唯一的匹配器里剥掉。
    const queryMiss = [];
    for (const route of routes) {
      const hit = routesApi.matchRoute(route.method, `${concretePath(route.path)}?probe=1`, routes);
      if (!hit || hit.command !== route.command) queryMiss.push(`${route.method} ${route.path}?probe=1`);
    }
    if (queryMiss.length) {
      bad("parity.routes.query-string", `带查询串后匹配失败：${queryMiss.join("；")}`, "matchRoute 必须去掉 ?query 与 #hash 再匹配，否则 HTTP 层直接 404");
    } else {
      ok("parity.routes.query-string", "带 ?query 的 request target 仍然匹配到原命令");
    }
  }
}

// ---------------------------------------------------------------- 3. 卡片按钮

if (!routesApi || !findCommand) {
  skip("parity.cards.registered", "上游模块加载失败");
} else {
  let buttons = null;
  try {
    buttons = routesApi.cardButtons();
    ok("parity.cards.registered", `${buttons.length} 个卡片按钮在命令表里有对应命令，且 remote === true`);
  } catch (err) {
    bad("parity.cards.registered", `cardButtons() 抛错：${err.message}`, "卡片按钮只能挂在 remote === true 的命令上；给命令补 remote: true + 幂等键 + audit: \"always\"，或删掉按钮");
  }

  if (buttons) {
    const orphan = buttons.filter((b) => {
      const cmd = findCommand(b.command);
      return !cmd || cmd.remote !== true;
    });
    if (orphan.length) {
      bad("parity.cards.orphan", `这些按钮指向不存在的命令或非远程命令：${orphan.map((b) => b.command).join(", ")}`, "每个按钮的 command 必须能在 COMMANDS 里找到；命令改名时按钮要一起改");
    } else {
      const byLabel = buttons.map((b) => `${b.command}「${b.label}」`).join("、");
      ok("parity.cards.orphan", `${buttons.length} 个按钮全部有归属：${byLabel}`);
    }
  }
}

// ---------------------------------------------------------------- 4. CLI 投影（真 spawn）

if (!COMMANDS) {
  skip("parity.cli.commands", "上游 commands.mjs 加载失败");
} else {
  let cli = null;
  try {
    const stdout = execFileSync(process.execPath, ["packages/cli/src/vk.mjs", "commands"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error(`vk commands 输出的不是数组（收到 ${typeof parsed}）`);
    cli = parsed;
    ok("parity.cli.commands", `vk commands 成功输出 ${parsed.length} 条命令的 JSON`);
  } catch (err) {
    const stderr = String(err.stderr ?? "")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" | ");
    bad(
      "parity.cli.commands",
      `运行 "node packages/cli/src/vk.mjs commands" 失败：${err.message}${stderr ? `（stderr: ${stderr}）` : ""}`,
      "保证 CLI 能独立跑 commands；Node 22.5 上 core 的 node:sqlite 需要 NODE_OPTIONS=--experimental-sqlite",
    );
  }

  if (cli) {
    const byName = new Map(cli.map((c) => [c.name, c]));

    // 命令集合：既比「有没有多/少」，也比顺序（顺序是 help 与文档的稳定契约）。
    const wantNames = COMMANDS.map((c) => c.name);
    const gotNames = cli.map((c) => c.name);
    const missing = wantNames.filter((n) => !gotNames.includes(n));
    const extra = gotNames.filter((n) => !wantNames.includes(n));
    if (missing.length || extra.length) {
      bad(
        "parity.cli.command-set",
        `${missing.length ? `CLI 缺少：${missing.join(", ")}` : ""}${missing.length && extra.length ? "；" : ""}${extra.length ? `CLI 多出：${extra.join(", ")}` : ""}`,
        "CLI 的命令列表必须由 COMMANDS 直接投影，不能手写；检查 vk.mjs 的 cmdCommands() 是否过滤/排序过",
      );
    } else if (JSON.stringify(wantNames) !== JSON.stringify(gotNames)) {
      bad("parity.cli.command-set", `命令集合相同但顺序不同：注册表 ${wantNames.join(" → ")}；CLI ${gotNames.join(" → ")}`, "命令顺序只能来自 COMMANDS 的数组顺序");
    } else {
      ok("parity.cli.command-set", `${gotNames.length} 条命令与注册表顺序一致`);
    }

    const httpDiffs = [];
    for (const cmd of COMMANDS) {
      const row = byName.get(cmd.name);
      if (!row) continue;
      const want = cmd.http ? `${cmd.http.method} ${cmd.http.path}` : null;
      const got = row.http ?? null;
      if (got !== want) httpDiffs.push(`${cmd.name}: 注册表 ${JSON.stringify(want)} ≠ CLI ${JSON.stringify(got)}`);
    }
    if (httpDiffs.length) {
      bad("parity.cli.http", httpDiffs.join("；"), "CLI 的 http 字段必须原样投影命令表；不要拼接、不要补全，两边写法不一致时以注册表为准");
    } else {
      ok("parity.cli.http", "每条命令的「方法 路径」在注册表与 CLI 输出里完全相同");
    }

    const cardDiffs = [];
    for (const cmd of COMMANDS) {
      const row = byName.get(cmd.name);
      if (!row) continue;
      const want = cmd.card?.label ?? null;
      const got = row.card?.label ?? null;
      if (got !== want) cardDiffs.push(`${cmd.name}: 注册表 ${JSON.stringify(want)} ≠ CLI ${JSON.stringify(got)}`);
    }
    if (cardDiffs.length) {
      bad("parity.cli.card-label", cardDiffs.join("；"), "卡片 label 是用户看到的那句话，只能来自命令表的 card.label；CLI 不许另起一套文案");
    } else {
      ok("parity.cli.card-label", "卡片按钮 label 在注册表与 CLI 输出里完全相同");
    }

    const remoteDiffs = [];
    for (const cmd of COMMANDS) {
      const row = byName.get(cmd.name);
      if (!row) continue;
      if (row.remote !== (cmd.remote === true)) remoteDiffs.push(`${cmd.name}: 注册表 remote=${cmd.remote === true} ≠ CLI remote=${row.remote}`);
    }
    if (remoteDiffs.length) {
      bad("parity.cli.remote", remoteDiffs.join("；"), "remote 决定卡片按钮能否异地触发，CLI 输出必须反映注册表的原值");
    } else {
      ok("parity.cli.remote", "remote 标记在注册表与 CLI 输出里一致");
    }
  } else {
    skip("parity.cli.command-set", "上游 parity.cli.commands 失败");
    skip("parity.cli.http", "上游 parity.cli.commands 失败");
    skip("parity.cli.card-label", "上游 parity.cli.commands 失败");
    skip("parity.cli.remote", "上游 parity.cli.commands 失败");
  }
}

// ---------------------------------------------------------------- 输出

console.log(`▸ ${NAME}`);
for (const r of results) {
  const mark = r.ok === true ? "✓" : r.ok === null ? "⊘" : "✗";
  console.log(`  ${mark} ${r.id.padEnd(42)}${r.detail}`);
  if (r.ok === false) console.log(`      ↳ 怎么修：${r.fix}`);
}

const failed = results.filter((r) => r.ok === false);
const passed = results.filter((r) => r.ok === true);
const skipped = results.filter((r) => r.ok === null);

if (failed.length) {
  console.log(`\n✗ ${NAME}失败：${failed.length} 条断言未通过（通过 ${passed.length}，跳过 ${skipped.length}）`);
  console.log("  复现：npm run check:parity");
  process.exit(1);
}
console.log(`\n✓ ${NAME}通过：${passed.length} 条断言${skipped.length ? `（跳过 ${skipped.length}）` : ""} —— 命令表 = HTTP 路由 = 卡片按钮 = CLI 输出`);
