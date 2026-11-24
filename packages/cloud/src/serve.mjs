import { createCloudServer } from "./server.mjs";

const env = process.env;
let server;
try {
  const port = Number(env.HIFABU_PORT ?? 8791);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error();
  server = createCloudServer({
    origin: env.HIFABU_ORIGIN,
    dataDir: env.HIFABU_DATA_DIR,
    logRetentionDays: Number(env.HIFABU_LOG_RETENTION_DAYS ?? 30),
    google: {
      clientId: env.HIFABU_GOOGLE_CLIENT_ID,
      clientSecret: env.HIFABU_GOOGLE_CLIENT_SECRET,
    },
  });
  server.once("error", () => {
    console.error("Hifabu 无法启动，请检查监听端口。");
    process.exitCode = 1;
    server.close();
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Hifabu 账号服务监听 127.0.0.1:${server.address().port}`);
  });
} catch {
  console.error("Hifabu 无法启动，请检查服务地址、端口、数据目录、日志保留期和 Google 配置。");
  process.exitCode = 1;
}

if (server) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
}
