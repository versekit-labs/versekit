# 第三方声明

VerseKit 本身的许可见 `LICENSE`。下面列出仓库里**移植**（不是依赖）过来的第三方代码，
以及它们各自的许可全文。VerseKit 没有任何运行时依赖，这里收录的都是「读懂流程后用 Node 重写」的部分，
移植方式见 `docs/adr-0002-sau-backend.md` §4.1 方式 B（带声明的移植）。

## social-auto-upload

- 项目：<https://github.com/dreammis/social-auto-upload>
- 版本：`3847fff01f5434a8a32829833163cd6723cabc59`（`3847fff`）
- 许可：MIT
- 移植了哪个文件：`uploader/douyin_uploader/main.py`
- 移植到哪里：`packages/adapter-douyin/`（`src/index.mjs`、`src/page.mjs` 文件头都有
  `// ported from dreammis/social-auto-upload@3847fff uploader/douyin_uploader/main.py`）
- 移植范围：只搬上传、填表、封面、话题这部分页面流程知识（上传页与发布页地址、上传控件、
  「重新上传」判断上传完成、标题与正文编辑器的定位、封面弹窗里该用哪个上传控件、浮层清理），
  用 `packages/driver-browser` 重写。**没有**搬：扫码登录、验证码输入、cookie 持久化、账号名与目录约定、
  固定话题、固定等待秒数、自主声明 / 合集 / 商品链接 / 定时发布。
- 没有 vendor、没有打包、没有 Python 运行时依赖。

```
MIT License

Copyright (c) 2023 dreammis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
