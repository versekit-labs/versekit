import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const begin = "    # >>> Hifabu account service (managed by deploy/hifabu) >>>";
const end = "    # <<< Hifabu account service <<<";

export function renderNginx(config, snippet) {
  const lines = config.split("\n");
  const matching = (pattern) => lines.flatMap((line, index) => pattern.test(line) ? [index] : []);
  const servers = matching(/^\s*server\s*\{\s*(?:#.*)?$/);
  const listeners = matching(/^\s*listen\s/);
  const roots = matching(/^\s*root\s+\/var\/www\/hifabu\s*;/);
  if (servers.length !== 1 || listeners.length !== 1 || roots.length !== 1 ||
      listeners[0] <= servers[0] || roots[0] <= servers[0] ||
      !/^\s*listen\s+127\.0\.0\.1:8081(?:\s+[^;]+)?\s*;/.test(lines[listeners[0]])) {
    throw new Error("hifabu.conf 须有一个 server 块、一个 127.0.0.1:8081 监听和 /var/www/hifabu 静态根目录。");
  }

  const start = servers[0] + 1;
  const starts = matching(/# >>> Hifabu account service /);
  const ends = matching(/# <<< Hifabu account service /);
  if (starts.length !== ends.length || starts.length > 1 ||
      (starts.length && (starts[0] !== start || ends[0] <= start))) {
    throw new Error("hifabu.conf 的账号服务标记不完整或位置已变动。");
  }
  lines.splice(start, starts.length ? ends[0] - start + 1 : 0, begin, snippet.trimEnd(), end);
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [config, snippet] = process.argv.slice(2).map((path) => readFileSync(path, "utf8"));
    process.stdout.write(renderNginx(config, snippet));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
