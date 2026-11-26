#!/usr/bin/env node
// 离线模拟页的静态服务：只监听 127.0.0.1，把 /creator-micro/... 映射到本目录的手搭页面。
// 它不是抖音：没有任何抖音资源，也不连任何外网。用法：
//   node packages/adapter-douyin/fixtures/serve.mjs [--port=8099] [--mode=ok]
//   HIFABU_DOUYIN_BASE=http://127.0.0.1:8099 vk publish --platform douyin --dry-run ...
// 模式（页面启动时读 /__config）：ok | login | risk | limited | risk-on-save | risk-on-manage | cover-required | draft-lost

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = {
  "/creator-micro/content/upload": "upload.html",
  "/creator-micro/content/publish": "publish.html",
  "/creator-micro/content/post/video": "publish.html",
  "/creator-micro/content/manage": "manage.html",
  "/creator-micro/home": "home.html",
  "/login": "login.html",
};

export function startFixtureServer({ port = 0, mode = "ok", uploadMs = 900 } = {}) {
  const state = { mode, uploadMs };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__config") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(state));
    }
    if (url.pathname === "/__mode") {
      state.mode = url.searchParams.get("set") ?? "ok";
      return res.end("ok");
    }
    const file = PAGES[url.pathname];
    if (!file) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(readFileSync(join(HERE, file)));
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        setMode: (m) => (state.mode = m),
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
  const s = await startFixtureServer({ port: Number(arg("port", 8099)), mode: arg("mode", "ok") });
  console.log(`模拟页 ${s.url}（模式 ${arg("mode", "ok")}，Ctrl+C 退出）`);
}
