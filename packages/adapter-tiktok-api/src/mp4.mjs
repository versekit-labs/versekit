// 读 MP4 / MOV 的时长（mvhd 盒），用来在上传之前对照 creator_info 的最长时长。
// 只读盒头、不整文件读入：moov 在文件尾也能找到。读不出来返回 null（交给 TikTok 在处理阶段判）。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return n === length ? buf : buf.subarray(0, n);
}

/** 返回秒数（可能带小数），读不出来返回 null。 */
export function mp4DurationSeconds(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const scan = (start, end) => {
      let pos = start;
      while (pos + 8 <= end) {
        const head = readAt(fd, pos, 16);
        if (head.length < 8) return null;
        let boxSize = head.readUInt32BE(0);
        const type = head.toString("latin1", 4, 8);
        let headerSize = 8;
        if (boxSize === 1) {
          if (head.length < 16) return null;
          boxSize = Number(head.readBigUInt64BE(8));
          headerSize = 16;
        } else if (boxSize === 0) {
          boxSize = end - pos;
        }
        if (boxSize < headerSize) return null;
        if (type === "moov") {
          const found = scan(pos + headerSize, Math.min(pos + boxSize, end));
          if (found != null) return found;
        } else if (type === "mvhd") {
          const body = readAt(fd, pos + headerSize, 32);
          const version = body[0];
          if (version === 1 && body.length >= 32) return Number(body.readBigUInt64BE(24)) / body.readUInt32BE(20);
          if (body.length >= 20) return body.readUInt32BE(16) / body.readUInt32BE(12);
          return null;
        }
        pos += boxSize;
      }
      return null;
    };
    return scan(0, size);
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}
