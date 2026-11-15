#!/usr/bin/env node
// 假 Chrome：只实现驱动用到的 CDP HTTP 端点 + 最小 WebSocket 握手；收到 Browser.close 就退出。
// FAKE_CHROME_PAGES（JSON 数组，URL 列表）决定 /json/list 里有哪些页面。
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const port = Number(arg("remote-debugging-port"));
const pages = JSON.parse(process.env.FAKE_CHROME_PAGES ?? '["about:blank"]');
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/json/version")) return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
  if (req.url.startsWith("/json/new")) return res.end(JSON.stringify({ id: "t1", type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/t1` }));
  if (req.url.startsWith("/json/list")) return res.end(JSON.stringify(pages.map((url, i) => ({ id: String(i), type: "page", url }))));
  res.end("{}");
});
server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const browser = req.url.includes("/browser/");
  socket.on("data", (buf) => {
    // 客户端帧一律带掩码；这里只处理 < 126 字节的单帧文本，够 CDP 小命令用。
    if ((buf[0] & 0x0f) !== 1) return; // 关闭帧等非文本帧忽略
    const len = buf[1] & 0x7f;
    const mask = buf.subarray(2, 6);
    const text = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString();
    const msg = JSON.parse(text);
    if (browser && msg.method === "Browser.close") process.exit(0);
    const out = Buffer.from(JSON.stringify({ id: msg.id, result: {} }));
    socket.write(Buffer.concat([Buffer.from([0x81, out.length]), out]));
  });
  socket.on("error", () => {});
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
