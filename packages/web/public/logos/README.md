# 平台官方标志（ACC-v3-fid-09）

徽章读 `packages/web/public/logos/<文件名>.svg`：文件在 → 用标志（品牌色 / 灰色 / 红底白色三态，靠 CSS mask，所以要**单色路径的 SVG**）；文件不在 → 回落到字母徽章。

**不要自己画、不要用第三方图标库（Simple Icons 等）冒充。** 只放各平台品牌资源页的正式文件。每个 SVG 文件头必须有注释：来源 URL、取得日期、许可证/使用条款。

| 文件 | 平台 | 去哪拿（品牌资源页） | 状态 |
|---|---|---|---|
| `xiaohongshu.svg` | 小红书 | 小红书品牌/商务合作素材页（需所有者向官方索取） | 缺 |
| `douyin.svg` | 抖音 | 抖音品牌素材（抖音开放平台 / 品牌规范） | 缺 |
| `shipinhao.svg` | 视频号 | 微信品牌/视频号素材（微信公众平台品牌资源） | 缺 |
| `bilibili.svg` | B站 | 哔哩哔哩品牌规范素材 | 缺 |
| `tiktok.svg` | TikTok（含 tiktok-api） | TikTok 开发者「品牌/UX 规范」下载；**界面遵守 TikTok 品牌规范**（不得改形状、不得改比例） | 缺 |
| `youtube.svg` | YouTube | youtube.com/howyoutubeworks/resources/brand-resources 的图标包（遵守 YouTube 品牌规则：用官方图标、不改形） | 缺 |
| `web.svg` | 官网 | 自家品牌，无外部来源 | 缺 |
| `gongzhonghao.svg` | 公众号 | 微信公众平台品牌资源 | 缺 |

补文件后把文件名（不带 .svg）加进 `logos/index.json`，不用改代码。品牌色在 `app.css` 的 `.pf.<类名>{--brand:…}`，换成官方色值时一并改。
