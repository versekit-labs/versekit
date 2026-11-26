import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";

const extensions = new Map([
  ["video", [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".mxf"]],
  ["image", [".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".avif", ".tiff"]],
  ["copy", [".md", ".markdown", ".txt", ".srt", ".vtt", ".ass"]],
].flatMap(([kind, suffixes]) => suffixes.map((suffix) => [suffix, kind])));
const perKind = 100;

export function scanProject({ root }) {
  try {
    const directory = realpathSync(root);
    const pending = [""];
    const files = [];
    while (pending.length) {
      const parent = pending.pop();
      for (const entry of readdirSync(join(directory, parent), { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const path = parent ? parent + "/" + entry.name : entry.name;
        const kind = extensions.get(extname(entry.name).toLowerCase());
        if (!entry.isDirectory() && !(entry.isFile() && kind)) continue;
        const info = lstatSync(join(directory, path), { throwIfNoEntry: false });
        if (info?.isDirectory()) pending.push(path);
        else if (info?.isFile() && kind) files.push({ path, kind, mtimeMs: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
    const counts = new Map();
    const recent = files.filter(({ kind }) => {
      const count = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, count);
      return count <= perKind;
    });
    return { root: directory, files: recent, truncated: recent.length !== files.length };
  } catch (error) {
    throw Object.assign(new Error(`无法扫描项目目录（${error.code ?? "scan_error"}）。`), {
      code: "scan_failed",
      hint: "检查项目根目录是否存在且可读取后重试。",
    });
  }
}
