import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLoopback } from "../../cloud/src/transport.mjs";

const pluginManifest = new URL("../.claude-plugin/plugin.json", import.meta.url);
const marketplace = "https://hifabu.com/plugin/marketplace.json";
const updateCommand = "claude plugin marketplace update hifabu && claude plugin update hifabu@hifabu";
const numeric = /^\d+$/;

function parseVersion(value) {
  if (typeof value !== "string" || value.length > 128) return;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match || match[0] !== value) return;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^0\d+$/.test(part))) return;
  return { release: match.slice(1, 4).map(BigInt), prerelease };
}

function isNewer(latest, current) {
  for (let i = 0; i < current.release.length; i++) {
    if (latest.release[i] !== current.release[i]) return latest.release[i] > current.release[i];
  }
  const a = latest.prerelease;
  const b = current.prerelease;
  if (!a.length || !b.length) return a.length < b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const aNumeric = numeric.test(a[i]);
    const bNumeric = numeric.test(b[i]);
    if (aNumeric && bNumeric) return BigInt(a[i]) > BigInt(b[i]);
    if (aNumeric !== bNumeric) return bNumeric;
    return a[i] > b[i];
  }
  return a.length > b.length;
}

function localDay(now) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

// A loopback override lets offline runs verify the same protocol with a local marketplace.
function marketplaceUrl(offline) {
  const override = process.env.HIFABU_PLUGIN_MARKETPLACE_URL;
  if (!override) return offline ? null : marketplace;
  const url = new URL(override);
  if (isLoopback(url) && ["http:", "https:"].includes(url.protocol) &&
      !url.username && !url.password && !url.search && !url.hash) return url;
  return null;
}

export async function checkPluginUpdate({ dataDir, offline }) {
  let logFile;
  const checkedAt = new Date();
  const day = localDay(checkedAt);
  try {
    const url = marketplaceUrl(offline);
    if (!url) return;
    const { version: current } = JSON.parse(readFileSync(pluginManifest, "utf8"));
    const installed = parseVersion(current);
    if (!installed) return;

    const directory = join(dataDir, "plugin-updates");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, day + ".json");
    // Claim the day's check before sending the request so concurrent commands
    // and failed checks still produce at most one attempt.
    writeFileSync(path, JSON.stringify({ checked_at: checkedAt }), { flag: "wx", mode: 0o600 });
    logFile = path;

    const response = await fetch(url, {
      credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(500),
    });
    if (!response.ok) throw new Error("插件市场请求失败。");
    const { name, plugins } = await response.json();
    const latest = Array.isArray(plugins) && plugins.find((plugin) => plugin?.name === "hifabu")?.version;
    const published = parseVersion(latest);
    if (name !== "hifabu" || !published) throw new Error("插件市场版本无效。");
    if (localDay(new Date()) === day && isNewer(published, installed)) {
      return { current, latest, command: updateCommand };
    }
  } catch {
    if (logFile) {
      try {
        writeFileSync(logFile, JSON.stringify({
          checked_at: checkedAt,
          event: "plugin.update_check_failed",
          error_code: "plugin_update_check_failed",
          message: "无法取得 Hifabu 插件的最新版本。",
        }));
      } catch {
        // The day's claim may remain if local storage becomes unavailable.
      }
    }
  }
}
