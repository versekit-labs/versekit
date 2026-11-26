# Hifabu 交付接口 v1

制作机把一期的清单和素材交给中转，发布机下载、校验并入库。平台稿要等人在发布机或飞书确认。清单的机器可读约定见 [JSON Schema](../schemas/delivery-v1.json)。

## 清单

| 字段 | 含义 |
|---|---|
| `schema` | 固定为 `hifabu.delivery/1`。 |
| `work.key` | `<项目 id>/<期标识>`。项目 id 随项目约定保存，期标识在项目内保持稳定。 |
| `work.title`、`work.language` | 作品标题和可选的语言标记。省略语言时使用发布机的默认标记。 |
| `cuts[]` | 至少一支成片。每支有 `video`，可以有 `cover`、`copy` 和 `title`。多支成片建议使用稳定的标题。省略时，多支成片按清单顺序使用「成片 1」「成片 2」等标题，单支成片使用作品标题。 |
| `cuts[].video`、`cuts[].cover` | 每个文件包含 `name`、`sha256`、`size`，分别为文件名、64 位十六进制 SHA-256 和正整数文件字节数。 |
| `cuts[].copy` | `default` 是通用文案。`bilibili`、`douyin`、`shipinhao`、`tiktok`、`xiaohongshu`、`youtube` 是平台覆盖，只写要替换的 `title`、`body` 或 `tags`。 |
| `target.group` | 发布机上的账号组名，必填。 |
| `from.client`、`from.device` | 客户端标识必填，制作机的公开设备标识可省略。 |

### 清单示例

```json
{
  "schema": "hifabu.delivery/1",
  "work": { "key": "p_7Q3M9X2K/17", "title": "AI 算法简史", "language": "zh" },
  "cuts": [
    {
      "video": {
        "name": "17_AI算法简史_v3.mp4",
        "sha256": "cf5664a86426afa42799efd6c0e8b2e9df0ef34c9024dc89e132032872edf938",
        "size": 104857600
      },
      "cover": {
        "name": "17_AI算法简史_封面.png",
        "sha256": "60c65a30689df94fb07714beda0e0314ecb03a67906e24be94b1c87de322d7bf",
        "size": 812345
      },
      "copy": {
        "default": { "title": "AI 算法简史", "body": "从感知机讲起。", "tags": ["AI", "算法"] },
        "xiaohongshu": { "title": "3 分钟看懂 AI 算法简史" }
      }
    }
  ],
  "target": { "group": "南竹" },
  "from": { "client": "hifabu-plugin/0.2.0", "device": "01ARZ3NDEKTSV4RRFFQ69G5FAV" }
}
```

```json
{
  "schema": "hifabu.delivery/1",
  "work": { "key": "p_7Q3M9X2K/18", "title": "注意力机制" },
  "cuts": [
    {
      "video": {
        "name": "18.mp4",
        "sha256": "ddb0e55b5ef55efb671a2f26d13e1b77d5225dc36593832c769c2ae1f6cf1cac",
        "size": 2048
      }
    }
  ],
  "target": { "group": "南竹" },
  "from": { "client": "hifabu-plugin/0.2.0" }
}
```

## 文件身份与更新

- 文件身份为 SHA-256 与大小。中转在同一账号内按 SHA-256 存一份。`name` 用于显示和判断扩展名。`vk work push` 读取与清单同目录的文件、核对哈希和大小，再沿用中转的断点续传。
- 清单各层都禁止本机路径。以 `/`、`\`、`~` 或盘符开头，以及含 `..` 的字符串，会在中转和发布机被拒收，错误码为 `local_path_in_manifest`。`work.key` 中的单个 `/` 是项目与期标识的分隔符。文件 `name` 只写文件名。
- 中转把 v1 清单原样保存在现有投递对象的 `manifest` 字段。`group` 要与 `target.group` 一致，`blobs` 只登记清单引用的文件身份。发布机验证后，在接口边界将 `video` 映射为 `versions[].asset` 的本地素材路径，并继续走现有的作品入库和平台稿生成流程。
- 同一中转账号再次交相同的 `work.key` 会更新作品。未发的平台稿跟随新的成片、封面和文案，同时保留人工编辑和原有排期。已发的平台稿沿用发布时的素材和文案，回报里会列出保留的稿件。不同项目、不同期或不同中转账号独立匹配。
- 插件 0.1.0 的清单没有 `schema`，仍按原有 `source` 路径匹配。旧记录无需迁移。

## 版本兼容

发布机的 `POST /v1/deliveries/pull` 携带 `accepts: ["hifabu.delivery/1"]`。`GET /v1/ping` 可读取同账号发布机最近一次声明的 `accepts`。制作机上传 v1 前先核对版本，发布机尚未声明支持时提示更新发布机。旧发布机仍能用原有拉取接口领取旧清单。

读端忽略同一主版本的未知字段，中转仍原样保存，且检查所有字段中是否含本机路径。含不可识别主版本的清单会被中转拒绝。若发布机在已有投递中遇到该清单，会回报 `failed` 和 `schema_unsupported`。制作机可通过 `vk delivery show <投递号>` 读到失败原因和更新发布机的下一步。

## 账号组快照

发布机每轮拉取时在同一请求里发送 `groupSnapshot`。中转按 Hifabu 账号保存最后一次收到的快照。制作机使用自己的中转令牌调用 `GET /v1/group-snapshot`，返回 `{ "snapshot": null }` 或以下结构。对应的 JS 客户端方法为 `getGroupSnapshot`。

```json
{
  "snapshot": {
    "device": { "id": "01ARZ3NDEKTSV4RRFFQ69G5FAW", "name": "客厅的 Mac mini" },
    "reportedAt": 1795680000000,
    "groups": [
      {
        "name": "南竹",
        "default": true,
        "accounts": [
          { "platform": "xiaohongshu", "name": "南竹笔记" },
          { "platform": "bilibili", "name": "南竹" }
        ]
      }
    ]
  }
}
```

`reportedAt` 是发布机生成快照的 Unix 时间戳（毫秒）。`default` 仅在发布机配置了默认组时填入。快照字段限于设备标识和显示名、同步时间、组名、平台键和账号显示名。没有显示名的账号使用平台名称。登录凭据、Cookie、令牌、账号 id、本机路径都不会传输。当前接口面向同一账号的一台发布机。
