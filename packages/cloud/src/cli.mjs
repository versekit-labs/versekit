#!/usr/bin/env node

import { CLOUD_COMMANDS } from "../../core/src/commands.mjs";
import { sessionCookieName } from "./server.mjs";
import { callCloud, cloudTextArgs, publicOrigin } from "./transport.mjs";

const args = process.argv.slice(2);
// The registry remains the source for arguments. This CLI presents the new executable name.
const usage = (cli) => cli.usage.replace(/^vk-cloud\b/, "hifabu-cloud");
try {
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    console.log(["hifabu-cloud serve", ...CLOUD_COMMANDS.map(({ cli, summary }) => `${usage(cli)}  ${summary}`)].join("\n"));
  } else if (args.length === 1 && args[0] === "serve") {
    await import("./serve.mjs");
  } else {
    const command = CLOUD_COMMANDS.find(({ name }) => name === args.slice(0, name.split(".").length).join("."));
    if (!command) throw new Error("未知 Hifabu 命令。请运行 hifabu-cloud --help。");
    const values = args.slice(command.name.split(".").length);
    const keys = Object.keys(command.args);
    if (values.length > keys.length || (command.cli.browserPath && values.length)) throw new Error(usage(command.cli));
    const origin = publicOrigin(process.env.HIFABU_ORIGIN);
    if (command.cli.browserPath) {
      console.log(JSON.stringify({ loginUrl: new URL(command.cli.browserPath, origin).href }));
    } else {
      const token = process.env.HIFABU_SESSION_TOKEN;
      if (token && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Hifabu 会话凭据格式不正确。");
      const credential = process.env.HIFABU_DEVICE_CREDENTIAL;
      const machineRequest = command.permission === "link" || command.permission === "device";
      if (machineRequest && !/^[A-Za-z0-9_-]{43}$/.test(credential ?? "")) throw new Error("请提供有效的 Hifabu 机器凭据。");
      const headers = machineRequest ? { Authorization: `Bearer ${credential}` } : token ? { Cookie: `${sessionCookieName}=${token}` } : {};
      const params = cloudTextArgs(command, Object.fromEntries(values.map((value, index) => [keys[index], value])));
      try {
        console.log(JSON.stringify(await callCloud(origin, command.name, params, headers)));
      } catch (error) {
        if (!error.status) throw error;
        console.log(JSON.stringify({ error_code: error.code, message: error.message }));
        process.exitCode = 1;
      }
    }
  }
} catch (error) {
  const message = error instanceof TypeError ? "无法访问 Hifabu 账号服务，请检查公开地址和服务状态。" : error.message;
  console.error(message);
  process.exitCode = 1;
}
