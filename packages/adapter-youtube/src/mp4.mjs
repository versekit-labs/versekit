// 读 MP4 / MOV 的时长（mvhd）与画面宽高（tkhd）：判断是不是 Shorts（竖版或方形、时长在上限内）。
// 只读盒头：moov 在文件头或尾都能找到，不整文件读入。读不出来返回 null，由调用方按「不是 Shorts」处理并说明。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_MOOV = 32 * 1024 * 1024; // moov 只有索引，正常远小于这个数；防止坏文件让我们读一大块

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return n === length ? buf : buf.subarray(0, n);
}

function findBox(fd, start, end, type) {
  let pos = start;
  while (pos + 8 <= end) {
    const head = readAt(fd, pos, 16);
    if (head.length < 8) return null;
    let size = head.readUInt32BE(0);
    const name = head.toString("latin1", 4, 8);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header) return null;
    if (name === type) return { pos, size, header };
    pos += size;
  }
  return null;
}

/** 返回 { durationSec, width, height }；任何一项读不出来就是 null。 */
export function mp4Info(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const total = fstatSync(fd).size;
    const moov = findBox(fd, 0, total, "moov");
    if (!moov || moov.size > MAX_MOOV) return { durationSec: null, width: null, height: null };
    const inner = [moov.pos + moov.header, moov.pos + moov.size];
    let durationSec = null;
    const mvhd = findBox(fd, ...inner, "mvhd");
    if (mvhd) {
      const body = readAt(fd, mvhd.pos + mvhd.header, 32);
      const v1 = body[0] === 1;
      const timescale = v1 ? body.readUInt32BE(20) : body.readUInt32BE(12);
      const duration = v1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
      if (timescale) durationSec = duration / timescale;
    }
    let width = null;
    let height = null;
    let pos = inner[0];
    while (width == null) {
      const trak = findBox(fd, pos, inner[1], "trak");
      if (!trak) break;
      const tkhd = findBox(fd, trak.pos + trak.header, trak.pos + trak.size, "tkhd");
      if (tkhd) {
        const body = readAt(fd, tkhd.pos + tkhd.header, tkhd.size - tkhd.header);
        const v1 = body[0] === 1;
        const off = v1 ? 88 : 76; // width / height 是 16.16 定点数，放在盒尾
        if (body.length >= off + 8) {
          const w = body.readUInt32BE(off) / 65536;
          const h = body.readUInt32BE(off + 4) / 65536;
          // 手机竖拍常存成横版再靠变换矩阵旋转 90°：矩阵的 a、b 项（16.16）里 |b| 大于 |a| 就是转了，宽高对调。
          const a = Math.abs(body.readInt32BE(off - 36));
          const b = Math.abs(body.readInt32BE(off - 32));
          if (w > 0 && h > 0) {
            [width, height] = b > a ? [h, w] : [w, h];
          }
        }
      }
      pos = trak.pos + trak.size;
    }
    return { durationSec, width, height };
  } catch {
    return { durationSec: null, width: null, height: null };
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/** YouTube 官方：Shorts 是竖版或方形、时长不超过上限（2024-10 起 3 分钟）。读不出画幅 → null（不猜）。 */
export const SHORTS_MAX_SECONDS = 180;
export function shortsVerdict({ durationSec, width, height }) {
  if (!width || !height) return { short: false, reason: "读不出画面比例，按普通视频处理" };
  if (height < width) return { short: false, reason: "横版，按普通视频处理" };
  if (durationSec == null) return { short: false, reason: "读不出时长，按普通视频处理" };
  if (durationSec > SHORTS_MAX_SECONDS) return { short: false, reason: `竖版但超过 ${SHORTS_MAX_SECONDS} 秒（Shorts 上限），会作为普通视频发布` };
  return { short: true, reason: `竖版、${Math.ceil(durationSec)} 秒，按 Shorts 处理` };
}
