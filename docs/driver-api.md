# 浏览器驱动接口（Driver API）

**状态**：Round 0 冻结。`packages/driver-browser` 的实现按此收敛；适配器只依赖这里列出的方法。
**依据**：`docs/adapter-contract.md` §3 的 14 条硬规则、`docs/BLUEPRINT.md` §2.10（每账号一个 profile）。

---

## 1. 为什么冻结

TikTok / 小红书 / 抖音 三个适配器共用一套 CDP。接口一 freeze，三个适配器可以并行写，谁都不需要
读别人的实现；驱动内部怎么改（选择器、重试、端口分配）不影响适配器。

**禁止**：适配器自己 `spawn` Chrome、自己连 `ws://`、自己维护 profile 路径。

---

## 2. 入口

```js
import { openAccount, browserReady, accountProfile, accountPort } from "@versekit-app/driver-browser";

const tab = await openAccount({ accountId: "acc_xxx" });   // 复用/新建该账号的 tab
await tab.goto("https://www.tiktok.com/tiktokstudio/content");
// …
await tab.close();                                          // 只关 tab，不关 Chrome
```

| 函数 | 语义 |
|---|---|
| `openAccount({ accountId, url? })` | 用该账号的 profile 打开（或复用）一个 tab。返回 `tab` |
| `browserReady()` | `null` = 可用；否则一句人话（缺 Chrome、端口占用…） |
| `accountProfile(accountId)` | `state/browser/<accountId>/`，绝不复用别的账号 |
| `accountPort(accountId)` | 从 9333 起按账号稳定分配（同账号每次相同，不同账号不撞） |
| `findChrome()` | 探测本机 Chrome 路径 |

**隔离规则**（D3/D8）：一个账号一个 Chrome 实例 + 一个 profile + 一个端口；同时最多 4 个（池上限），
超出的排队。同账号的发布/采集/检查由 core 的 lane 串行，驱动不负责加锁，但**不得**为同一账号开第二个实例。

---

## 3. tab 方法

| 方法 | 说明 |
|---|---|
| `tab.send(method, params, timeout?)` | 原始 CDP，逃生口；业务代码优先用下面的方法 |
| `tab.eval(fn, ...args)` | 页面内求值，`returnByValue`；异常原样抛出 |
| `tab.waitFor(fn, args?, opts?)` | 轮询直到真值；`{timeout, every, what}`，超时信息带 `what` |
| `tab.point(findFn, arg)` | 先 `scrollIntoView({behavior:'instant'})` 再取中心点 |
| `tab.click([x,y])` | **真实鼠标**（moved → pressed → released），不用 `element.click()` |
| `tab.clickText(texts, opts?)` | 中英双匹配点文案；找不到时抛错并带候选 |
| `tab.type(text)` | `Input.insertText`，适合中文/emoji |
| `tab.key(key, code?, keyCode?)` | 单键；回车、Tab、Escape 走这里 |
| `tab.selectAll()` | Draft.js 友好的全选（`commands:['selectAll']`） |
| `tab.clear(assertEmptyFn)` | 全选 + 删除 + **断言已空**，不空就抛 |
| `tab.upload(selectorExpr, files[])` | `DOM.setFileInputFiles`；先等控件出现 |
| `tab.clickInShadow(host, text)` | 封闭 shadow root 里的按钮（小红书） |
| `tab.collectJson(match, run, opts?)` | 拦截页面自己发出的 JSON 响应（已签名），返回 `[{url, body}]` |
| `tab.screenshot()` | PNG Buffer |
| `tab.goto(url)` | 导航并等 `load` |
| `tab.url()` | 当前地址（用于判断是否被踢到 /login） |
| `tab.close()` | 关 tab |

**每条发布/采集都必须能留下现场**：`tab.screenshot()` + `error.evidence.screenshot` 路径，
失败信息里带绝对路径（规则 12）。

---

## 4. 超时与等待

| 动作 | 默认上限 |
|---|---|
| 视频上传 | 20 min |
| 发布结果判定 | 3 min |
| 普通元素出现 | 30 s |
| 封面处理 | 4 s 级短等待（过渡动画，非同步手段） |

`sleep` 只允许作为动画级过渡；主同步一律 `waitFor`。

---

## 5. 失败语义

驱动只抛普通 `Error`（页面没按预期走），由适配器翻译成 `AdapterError(code)`：
- 被重定向到 `/login` → 适配器判 `auth`
- 等不到预期响应 → `flaky_ui`
- 上传被平台拒绝 → `asset_invalid`

驱动**不知道**平台业务，也不该知道。
