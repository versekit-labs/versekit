// 登录弹窗里的「验证」按钮定位：文案可能带空格、外层容器也含「验证」，
// 所以必须是「包含匹配 + 取最小元素」。这条规则被打回过一次，用测试钉住。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VK_HOME ??= mkdtempSync(join(tmpdir(), "vk-click-"));
const { openAccount, closeAccount } = await import("../../driver-browser/src/index.mjs");

const FIND = `(() => {
  const cands = [...document.querySelectorAll('div,button,span')].filter((e) => {
    if (!/验\\s*证/.test((e.innerText || '').trim())) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.width < 240;
  });
  cands.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return ra.width * ra.height - rb.width * rb.height;
  });
  const b = cands[0];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]);
})()`;

const PAGE = `<!doctype html><meta charset="utf-8"><body>
<div id="modal" style="position:fixed;left:35%;top:30%;width:260px;height:180px;background:#fff">
  <div class="title">短信验证码验证</div>
  <input placeholder="请输入验证码">
  <div class="wrapper" style="width:260px;height:60px">
    <div class="btn" id="verify" style="width:72px;height:30px;background:#eee">验 证</div>
  </div>
</div>
<script>
window.hit = 0;
document.getElementById('verify').onclick = () => { window.hit++ };
</script>
</body>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

after(async () => {
  server.close();
});

test("弹窗带空格且外层也含「验证」时，仍能点到真正的按钮", async () => {
  const tab = await openAccount({ accountId: "click-fixture", url: `http://127.0.0.1:${port}/`, headless: true });
  try {
    const spot = await tab.eval(FIND);
    assert.ok(spot, "应该找到按钮坐标");
    await tab.click(JSON.parse(spot));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await tab.eval("window.hit"), 1);
  } finally {
    await tab.close();
    await closeAccount("click-fixture");
  }
});
