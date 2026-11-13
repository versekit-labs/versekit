// 素材类型判定的唯一实现：扩展名 → video / image / null（判不出来）。
//
// 为什么放在 core：发布台要在「创建行之前」拦住平台发不了的素材（ACC-publish-04），适配器
// 也要在打开浏览器之前再挡一次。两边各写一张扩展名表，迟早会出现「发布台说能发、适配器
// 说不能发」的分裂。判不出来（未知扩展名 / 没有扩展名）时返回 null，不装懂：交给适配器
// 在 dry-run 或真正上传时给出它自己的判断。

import { extname } from "node:path";

export const ASSET_KINDS = ["video", "image"];

export const ASSET_KIND_LABEL = { video: "视频", image: "图片" };

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".flv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".bmp", ".avif", ".tif", ".tiff"]);

export function assetKindOf(file) {
  if (file == null) return null;
  const ext = extname(String(file)).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}