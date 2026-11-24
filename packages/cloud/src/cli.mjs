#!/usr/bin/env node

import { CLOUD_COMMANDS } from "../../core/src/commands.mjs";
import { publicOrigin, sessionCookieName } from "./server.mjs";

const args = process.argv.slice(2);
try {
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    console.log(["vk-cloud serve", ...CLOUD_COMMANDS.map(({ cli, summary }) => `${cli.usage}  ${summary}`)].join("\n"));
  } else if (args.length === 1 && args[0] === "serve") {
    await import("./serve.mjs");
  } else {
    const command = CLOUD_COMMANDS.find(({ name }) => name === args.join("."));
    if (!command) throw new Error("未知 Hifabu 命令。请运行 vk-cloud --help。");
    const origin = publicOrigin(process.env.HIFABU_ORIGIN);
    if (command.cli.browserPath) {
      console.log(JSON.stringify({ loginUrl: new URL(command.cli.browserPath, origin).href }));
    } else {
      const token = process.env.HIFABU_SESSION_TOKEN;
      if (token && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Hifabu 会话凭据格式不正确。");
      const { method, path } = command.http;
      const headers = { Origin: origin, ...(token && { Cookie: `${sessionCookieName}=${token}` }) };
      const response = await fetch(new URL(path, origin), { method, headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
      console.log(JSON.stringify(await response.json()));
      if (!response.ok) process.exitCode = 1;
    }
  }
} catch (error) {
  const message = error instanceof TypeError ? "无法访问 Hifabu 账号服务，请检查公开地址和服务状态。" : error.message;
  console.error(message);
  process.exitCode = 1;
}
