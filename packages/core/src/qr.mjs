// ported from nayuki/QR-Code-generator@bcfe1b018cec5f1f91b5705eca5bb4cdd34e9f8d typescript-javascript/qrcodegen.ts
// Copyright (c) Project Nayuki. (MIT License) https://www.nayuki.io/page/qr-code-generator-library
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
// following conditions: the above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software. The Software is provided "as is", without warranty of
// any kind.
//
// 移植范围（只剥离、不改算法）：只保留「字节模式」——交接链接是 ASCII URL，不需要数字/字母/汉字/ECI 分段；
// 去掉 TypeScript 类型与 namespace；新增 qrSvg() 把矩阵画成 SVG。零运行时依赖。

const MIN_VERSION = 1;
const MAX_VERSION = 40;
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// ordinal 对应下面两张表的行号；formatBits 是格式信息里的 2 位纠错等级码。
export const ECC = {
  LOW: { ordinal: 0, formatBits: 1 },
  MEDIUM: { ordinal: 1, formatBits: 0 },
  QUARTILE: { ordinal: 2, formatBits: 3 },
  HIGH: { ordinal: 3, formatBits: 2 },
};

const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const assert = (cond) => {
  if (!cond) throw new Error("Assertion error");
};
const getBit = (x, i) => ((x >>> i) & 1) !== 0;

function appendBits(val, len, bb) {
  if (len < 0 || len > 31 || val >>> len !== 0) throw new RangeError("Value out of range");
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

function getNumRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  assert(result >= 208 && result <= 29648);
  return result;
}

function getNumDataCodewords(ver, ecl) {
  return Math.floor(getNumRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
}

function reedSolomonMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonComputeDivisor(degree) {
  const result = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= reedSolomonMultiply(coef, factor);
    });
  }
  return result;
}

class QrCode {
  constructor(version, ecl, dataCodewords, msk) {
    this.version = version;
    this.errorCorrectionLevel = ecl;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    const row = new Array(this.size).fill(false);
    for (let i = 0; i < this.size; i++) {
      this.modules.push(row.slice());
      this.isFunction.push(row.slice());
    }

    this.drawFunctionPatterns();
    this.drawCodewords(this.addEccAndInterleave(dataCodewords));

    if (msk === -1) {
      let minPenalty = 1000000000;
      for (let i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        const penalty = this.getPenaltyScore();
        if (penalty < minPenalty) {
          msk = i;
          minPenalty = penalty;
        }
        this.applyMask(i);
      }
    }
    this.mask = msk;
    this.applyMask(msk);
    this.drawFormatBits(msk);
    this.isFunction = [];
  }

  getModule(x, y) {
    return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x];
  }

  drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);
    const alignPatPos = this.getAlignmentPatternPositions();
    const numAlign = alignPatPos.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0))) {
          this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
        }
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFormatBits(mask) {
    const data = (this.errorCorrectionLevel.formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, this.size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, color);
      this.setFunctionModule(b, a, color);
    }
  }

  drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  addEccAndInterleave(data) {
    const ver = this.version;
    const ecl = this.errorCorrectionLevel;
    if (data.length !== getNumDataCodewords(ver, ecl)) throw new RangeError("Invalid argument");
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
    const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const rsDiv = reedSolomonComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = reedSolomonComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
      });
    }
    assert(result.length === rawCodewords);
    return result;
  }

  drawCodewords(data) {
    if (data.length !== Math.floor(getNumRawDataModules(this.version) / 8)) throw new RangeError("Invalid argument");
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
    assert(i === data.length * 8);
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0; break;
          default: throw new Error("Unreachable");
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  getPenaltyScore() {
    let result = 0;
    for (let y = 0; y < this.size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
    }
    for (let x = 0; x < this.size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < this.size; y++) {
        if (this.modules[y][x] === runColor) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
    }
    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const color = this.modules[y][x];
        if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] && color === this.modules[y + 1][x + 1]) result += PENALTY_N2;
      }
    }
    let dark = 0;
    for (const row of this.modules) dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  getAlignmentPatternPositions() {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  finderPenaltyCountPatterns(runHistory) {
    const n = runHistory[1];
    const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  }

  finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
    if (currentRunColor) {
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size;
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  }

  finderPenaltyAddHistory(currentRunLength, runHistory) {
    if (runHistory[0] === 0) currentRunLength += this.size;
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }
}

/** 字节模式编码（对应上游 QrCode.encodeBinary + QrSegment.makeBytes）。 */
export function encodeBytes(data, ecl = ECC.MEDIUM) {
  const bytes = [...data];
  const seg = { modeBits: 0x4, numChars: bytes.length, bits: [] };
  for (const b of bytes) appendBits(b, 8, seg.bits);
  const countBits = (version) => (version <= 9 ? 8 : 16);

  let version;
  let dataUsedBits;
  for (version = MIN_VERSION; ; version++) {
    const capacity = getNumDataCodewords(version, ecl) * 8;
    const used = 4 + countBits(version) + seg.bits.length;
    if (seg.numChars >= 1 << countBits(version)) {
      if (version >= MAX_VERSION) throw new RangeError("Data too long");
      continue;
    }
    if (used <= capacity) {
      dataUsedBits = used;
      break;
    }
    if (version >= MAX_VERSION) throw new RangeError("Data too long");
  }
  for (const newEcl of [ECC.MEDIUM, ECC.QUARTILE, ECC.HIGH]) {
    if (dataUsedBits <= getNumDataCodewords(version, newEcl) * 8) ecl = newEcl;
  }

  const bb = [];
  appendBits(seg.modeBits, 4, bb);
  appendBits(seg.numChars, countBits(version), bb);
  for (const b of seg.bits) bb.push(b);
  assert(bb.length === dataUsedBits);

  const capacityBits = getNumDataCodewords(version, ecl) * 8;
  appendBits(0, Math.min(4, capacityBits - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);
  for (let padByte = 0xec; bb.length < capacityBits; padByte ^= 0xec ^ 0x11) appendBits(padByte, 8, bb);

  const dataCodewords = new Array(bb.length / 8).fill(0);
  bb.forEach((b, i) => {
    dataCodewords[i >>> 3] |= b << (7 - (i & 7));
  });
  return new QrCode(version, ecl, dataCodewords, -1);
}

/** 文本 → QR 矩阵（UTF-8 字节模式）。 */
export function qrMatrix(text, ecl = ECC.MEDIUM) {
  const qr = encodeBytes(Buffer.from(String(text), "utf8"), ecl);
  const rows = [];
  for (let y = 0; y < qr.size; y++) {
    const row = [];
    for (let x = 0; x < qr.size; x++) row.push(qr.getModule(x, y));
    rows.push(row);
  }
  return { size: qr.size, version: qr.version, rows };
}

/** 文本 → 可直接内嵌的 SVG 字符串（带 4 格静区，深色模块用 currentColor 以外的固定黑白，保证扫码对比度）。 */
export function qrSvg(text, { border = 4, ecl = ECC.MEDIUM, label = "二维码" } = {}) {
  const { size, rows } = qrMatrix(text, ecl);
  const parts = [];
  rows.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    }),
  );
  const dim = size + border * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${parts.join("")}" fill="#000"/></svg>`;
}
