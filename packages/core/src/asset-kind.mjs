// 素材类型判定的唯一实现：扩展名 → video / image / null（判不出来）。
//
// 为什么放在 core：发布台要在「创建行之前」拦住平台发不了的素材（ACC-publish-04），适配器
// 也要在打开浏览器之前再挡一次。两边各写一张扩展名表，迟早会出现「发布台说能发、适配器
// 说不能发」的分裂。判不出来（未知扩展名 / 没有扩展名）时返回 null，不装懂：交给适配器
// 在 dry-run 或真正上传时给出它自己的判断。
//
// 多图（ACC-publish-06）：一个作品仍然只有一个 asset 字段（不改 schema / api 形状），目录就是
// 「图集」——目录里按文件名自然排序的 1–18 张图片。排序和数量限制放在这里，是为了让发布台、
// 核心和适配器对「第几张图」有同一份判断，而不是各排各的。

import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

export const ASSET_KINDS = ["video", "image"];

export const ASSET_KIND_LABEL = { video: "视频", image: "图片" };

/** 小红书图文单篇最多 18 张（平台规则；只做图文的平台目前只有小红书）。 */
export const MAX_IMAGE_NOTE = 18;

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".flv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".bmp", ".avif", ".tif", ".tiff"]);

export function assetKindOf(file) {
  if (file == null) return null;
  const ext = extname(String(file)).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

// 自然排序：01-red.png < 2-blue.png < 10-green.png，而不是字典序把 10 排到 2 前面。
// 「按顺序上传」的证据就是这组顺序，所以选项一旦定下就不能在别处各写一份。
const FILENAME_ORDER = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

/**
 * 一个作品的素材文件列表：单文件 → [该文件]；目录 → 目录里的文件（自然排序、跳过隐藏项）。
 *
 * 路径不存在、是空目录、读不出来时返回 []，由调用方给出带路径的人话错误——这里不抛异常，
 * 因为「判不出来」和「素材非法」是两种处置（见文件头）。返回的路径保持调用方给的形式，
 * 适配器在 planImageNote 里再 resolve 成绝对路径（上传控件只收绝对路径）。
 */
export function assetFilesOf(asset) {
  if (asset == null) return [];
  const path = String(asset);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [path];
  let names;
  try {
    names = readdirSync(path);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith("."))
    .map((name) => join(path, name))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => FILENAME_ORDER.compare(basename(a), basename(b)));
}

/**
 * 素材集合的判定结果。`kind` 只有在所有文件都能判定成同一种时才有值；`mixed` 是「图片和视频
 * 同时存在」——这种作品根本不该创建（ACC-publish-06）。
 */
export function assetSetOf(asset) {
  const files = assetFilesOf(asset);
  const kinds = files.map((file) => assetKindOf(file));
  const known = [...new Set(kinds.filter(Boolean))];
  return {
    files,
    kinds,
    kind: known.length === 1 ? known[0] : null,
    mixed: known.length > 1,
    unknown: kinds.includes(null),
  };
}
