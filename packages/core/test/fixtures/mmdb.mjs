// 测试用的最小 MMDB 写入器：自造一个小库，不下载真实 IP 库（#310）。
// 只支持这几个测试要用的：IPv4 / IPv6 树、record_size 24/28/32、map / 字符串 / 布尔。
import { Buffer } from "node:buffer";

const enc = {
  str(s) {
    const b = Buffer.from(s, "utf8");
    return Buffer.concat([ctrl(2, b.length), b]);
  },
  uint(type, n) {
    const bytes = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
    return Buffer.concat([ctrl(type, bytes.length), Buffer.from(bytes)]);
  },
  map(obj) {
    const parts = [ctrl(7, Object.keys(obj).length)];
    for (const [k, v] of Object.entries(obj)) parts.push(enc.str(k), value(v));
    return Buffer.concat(parts);
  },
  bool: (v) => ctrl(14, v ? 1 : 0),
};
const ctrl = (type, size) => {
  if (size >= 29) throw new Error("fixture 不写长数据");
  return type < 8 ? Buffer.from([(type << 5) | size]) : Buffer.from([size, type - 7]);
};
const value = (v) => (typeof v === "string" ? enc.str(v) : typeof v === "number" ? enc.uint(6, v) : typeof v === "boolean" ? enc.bool(v) : enc.map(v));

const bitsOf = (cidr, ipVersion) => {
  const [ip, lenText] = cidr.split("/");
  const parts = ip.includes(":") ? null : ip.split(".").map(Number);
  const bits = [];
  if (ipVersion === 6) for (let i = 0; i < 96; i++) bits.push(0);
  for (const octet of parts) for (let i = 7; i >= 0; i--) bits.push((octet >> i) & 1);
  return bits.slice(0, (ipVersion === 6 ? 96 : 0) + Number(lenText));
};

/** entries: [{ cidr: "203.0.113.0/24", data: {…} }]（都是 IPv4 段）。 */
export function buildMmdb(entries, { ipVersion = 4, recordSize = 24, type = "fixture" } = {}) {
  const nodes = [[null, null]];
  const data = [];
  let dataLen = 0;
  for (const { cidr, data: record } of entries) {
    const bits = bitsOf(cidr, ipVersion);
    let node = 0;
    for (let i = 0; i < bits.length - 1; i++) {
      let next = nodes[node][bits[i]];
      if (next == null || next.node == null) {
        next = { node: nodes.length };
        nodes.push([null, null]);
        nodes[node][bits[i]] = next;
      }
      node = next.node;
    }
    const bytes = enc.map(record);
    nodes[node][bits[bits.length - 1]] = { data: dataLen };
    data.push(bytes);
    dataLen += bytes.length;
  }
  const nodeCount = nodes.length;
  const rec = (c) => (c == null ? nodeCount : c.node != null ? c.node : nodeCount + 16 + c.data);
  const tree = Buffer.alloc((nodeCount * recordSize * 2) / 8);
  const nb = (recordSize * 2) / 8;
  nodes.forEach(([l, r], i) => {
    const L = rec(l);
    const R = rec(r);
    const o = i * nb;
    if (recordSize === 24) {
      tree.writeUIntBE(L, o, 3);
      tree.writeUIntBE(R, o + 3, 3);
    } else if (recordSize === 32) {
      tree.writeUInt32BE(L, o);
      tree.writeUInt32BE(R, o + 4);
    } else {
      tree[o] = (L >> 16) & 255;
      tree[o + 1] = (L >> 8) & 255;
      tree[o + 2] = L & 255;
      tree[o + 3] = (((L >> 24) & 15) << 4) | ((R >> 24) & 15);
      tree[o + 4] = (R >> 16) & 255;
      tree[o + 5] = (R >> 8) & 255;
      tree[o + 6] = R & 255;
    }
  });
  const meta = enc.map({ node_count: nodeCount, record_size: recordSize, ip_version: ipVersion, database_type: type, binary_format_major_version: 2, binary_format_minor_version: 0, build_epoch: 1700000000 });
  return Buffer.concat([tree, Buffer.alloc(16), ...data, Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com")]), meta]);
}

/** DB-IP City Lite 的记录形状。 */
export const city = (iso, country, cityName = null) => ({ country: { iso_code: iso, names: { en: country } }, ...(cityName ? { city: { names: { en: cityName } } } : {}) });
/** IPinfo Lite 的记录形状（没有「机房」布尔，只有 AS 名）。 */
export const asn = (code, asName, domain) => ({ country_code: code, as_name: asName, as_domain: domain });
