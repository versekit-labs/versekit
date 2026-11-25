import { createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

function configure(configFile, keyFile) {
  const publicPem = readFileSync(keyFile, "utf8");
  if (!publicPem.startsWith("-----BEGIN PUBLIC KEY-----") ||
      createPublicKey(publicPem).asymmetricKeyType !== "ed25519") {
    throw new Error("请提供 Hifabu 的 Ed25519 PEM 公钥。");
  }

  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (!isObject(config) || (config.relay !== undefined && !isObject(config.relay))) {
    throw new Error("中转配置必须包含 JSON 对象。");
  }
  const relay = config.relay ??= {};
  if (relay.allow_legacy_tokens !== undefined && typeof relay.allow_legacy_tokens !== "boolean") {
    throw new Error("relay.allow_legacy_tokens 必须为 true 或 false。");
  }
  relay.allow_legacy_tokens ??= relay.machine_public_key_file == null;
  relay.machine_public_key_file = resolve(keyFile);

  const temp = mkdtempSync(join(dirname(configFile), ".hifabu-"));
  try {
    const next = join(temp, "config.json");
    writeFileSync(next, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    renameSync(next, configFile);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

try {
  if (process.argv.length !== 4) throw new Error("用法：node configure-hifabu.mjs <config.json> <Hifabu 公钥 PEM>");
  configure(...process.argv.slice(2));
  console.log("Hifabu 公钥已写入中转配置。请重启 versekit-relay。");
} catch (error) {
  // JSON parsing errors may contain excerpts of config.json, which holds fixed tokens.
  console.error(error instanceof SyntaxError ? "中转配置不是有效 JSON，请检查 config.json。" : error.message);
  process.exitCode = 1;
}
