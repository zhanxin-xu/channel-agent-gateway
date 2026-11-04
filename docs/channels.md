# 渠道接入

每个渠道对应一个 Webhook 地址：`POST https://<域名>/api/webhook/<渠道名>`。

| 渠道 | 鉴权方式 | 回复方式 |
|---|---|---|
| `qq` | Ed25519 签名（密钥由 AppSecret 派生） | 先回执，后台调用 QQ OpenAPI 回复 |
| `telegram` | `X-Telegram-Bot-Api-Secret-Token` 请求头 | 先回执，后台调用 Bot API 回复 |
| `http` | `Authorization: Bearer <HTTP_CHANNEL_TOKEN>` | 同步：等 agent 跑完，直接在响应里返回 |

**为什么用 Webhook 而不是 WebSocket**：Serverless 函数只在有请求时运行，无法维持长连接；QQ 默认的 WebSocket 接入需要常驻进程做心跳和断线续传。各平台都提供 HTTP 回调模式，正好适合 Vercel Functions。

在任意渠道发送 `/reset` 可以清空当前会话的历史（群里需要 @ 机器人）。

## QQ

### 创建与配置

1. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，把 AppID 和 AppSecret 分别填入 `QQ_APP_ID`、`QQ_APP_SECRET`。
2. 进入 **开发 → 回调配置**，回调地址填 `https://<域名>/api/webhook/qq`。保存时平台会发来 `op: 13` 的地址校验请求，服务会自动完成签名响应。在中国大陆使用时必须用[自定义域名](deployment.md#自定义域名)。
3. 勾选需要的事件：

   | 事件 | 场景 |
   |---|---|
   | `C2C_MESSAGE_CREATE` | 单聊 |
   | `GROUP_AT_MESSAGE_CREATE` | 群里 @ 机器人 |
   | `GROUP_MESSAGE_CREATE` | 群里所有消息（可选，见下文） |
   | `AT_MESSAGE_CREATE` / `DIRECT_MESSAGE_CREATE` | 频道 @ 和频道私信 |

4. **IP 白名单**：QQ 开放平台会限制调用 OpenAPI 的来源 IP，而 Vercel 函数的出口 IP 不固定。如果遇到"IP 不在白名单"之类的报错，可以使用 Vercel 的 Static IPs（付费功能），或者让请求经过一个固定 IP 的代理。

### 群聊全量消息

订阅 `GROUP_MESSAGE_CREATE` 后，机器人也能看到群里没有 @ 它的消息。这还需要**群主在手机 QQ 的群设置里给机器人开启"接收全部消息"的权限**，平台才会推送，详见 QQ 机器人官方 FAQ。

开启后，群消息分两类处理：

| | 群里没 @ 的消息 | @ 机器人 / 私聊 |
|---|---|---|
| 写入事件流 | 每条都写 | 每条都写 |
| 唤起 agent | 每个群每 10 秒最多一次，由模型决定要不要插话，默认不说话 | 每次都唤起，一定回复 |
| 已经有 agent 在跑时 | 只写入，正在跑的 agent 下一步就能看到 | 同左 |

几个人同时 @ 机器人，只会有一个 agent 来处理，它在一轮里分别回应每个人，详见 [Agent 与对话](agent.md#两个解耦的部分)。

这些数字都可以配置，见[配置参考](configuration.md#agent)。处理细节：

- **怎样算 @ 了机器人**：事件类型是 `GROUP_AT_MESSAGE_CREATE`，或者 `mentions[].is_you` 为真，或者正文里有 `<@!AppID>`，满足任意一个即可。
- **同一条消息可能推两次**：一条 @ 消息可能同时作为全量消息和 @ 消息推送。服务按消息 ID 去重，只记录一次、只回复一次。
- **采样锁存在共享存储里**，多个实例共享同一个时间窗口。
- **忽略其他机器人**：其他机器人发的消息直接丢弃，避免互相刷屏。

### 被动回复规则

机器人的回复都是被动回复：带上用户消息的 `msg_id`，`msg_seq` 依次递增。平台规则如下：

| 场景 | 有效期（从用户发消息时算起） | 每条消息最多回复 |
|---|---|---|
| 单聊 | 60 分钟 | 5 次 |
| 群聊 | 5 分钟 | 5 次 |
| 频道 | 5 分钟 | 5 次 |

- **时间起点**取事件里的 `timestamp`，即用户发消息的时间，而不是收到回调的时间。
- **超出限制会提前拒绝**：过了有效期或已经回了 5 条时，服务在调用 QQ 接口之前就拒绝，并把错误作为工具结果交给模型。
- 文字、表情包、文件共用这 5 次额度。回复次数和 `msg_seq` 存在共享存储里，跨轮次延续，不会出现重复的 `msg_seq`。
- 多条消息合并处理时，默认回复最新一条还能回复的 @ 消息；模型也可以用 `reply_to` 回复其中任意一条。
- 群聊里如果模型先长时间搜索、思考，超过 5 分钟后回复就发不出去了。
- 不针对任何消息的主动推送每月只有 4 条，本项目不使用。

### 图片、语音和文件

收到的附件（事件里的 `attachments`）按类型处理：

| 附件 | 处理方式 |
|---|---|
| 图片 | 收到时下载，缩到最长边 512px 存进共享存储（每条最多 4 张、每张原图不超过 8 MB），之后每次都以 base64 交给模型（`detail: "low"`），以前的图片模型也能再看 |
| 语音 | 使用 QQ 自带的转写文字 `asr_refer_text`，记为 `[语音] 文字` |
| 视频、文件 | 记为 `[视频]`、`[文件：文件名]`，模型打不开 |

服务会自己下载图片，而不是把地址交给模型：模型服务商在海外，很可能拉不到 QQ 的 CDN，而且附件链接过一段时间就会失效。

发出去的图片和文件走 QQ 的富媒体接口：先调用 `POST /v2/{users|groups}/{id}/files` 上传，拿到 `file_info`，再发送 `msg_type: 7` 的消息。

| 内容 | 上传方式 |
|---|---|
| 表情包 | 传图片 URL（`file_type: 1`），`file_info` 会缓存复用 |
| 工作区文件 | 直接上传文件内容（`file_data`，base64，5 MB 以内），`file_type` 按扩展名判断：png/jpg/gif 是图片，mp4 是视频，mp3/wav/silk 是语音，其他是文件 |

频道里的表情包直接在消息中带 `image: url`；频道不支持发文件。

## Telegram

1. 向 [@BotFather](https://t.me/BotFather) 申请机器人，填入 `TELEGRAM_BOT_TOKEN`。
2. 自己生成一个随机字符串填入 `TELEGRAM_WEBHOOK_SECRET`，然后注册 Webhook：

   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://<域名>/api/webhook/telegram&secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```

3. 私聊会直接回复。群聊里只有 @ 到机器人才回复，需要配置 `TELEGRAM_BOT_USERNAME`（不带 @）。

表情包用 `sendAnimation`（GIF）或 `sendPhoto` 发送，工作区文件用 `sendPhoto`、`sendAnimation` 或 `sendDocument` 上传。

## 通用 HTTP

适合接入自己的应用或做调试。配置 `HTTP_CHANNEL_TOKEN` 后启用。

```bash
curl -X POST https://<域名>/api/webhook/http \
  -H "Authorization: Bearer $HTTP_CHANNEL_TOKEN" \
  -H "content-type: application/json" \
  -d '{"conversationId":"demo","text":"现在上海几点？"}'
```

请求体字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | 是 | 消息内容 |
| `conversationId` | 否 | 会话 ID，同一个 ID 共享历史 |
| `userId` / `userName` | 否 | 发送人 |
| `chatType` | 否 | `private`（默认）或 `group` |

响应：`{ "reply": "多条消息用换行拼接", "messages": ["…", "…"] }`。HTTP 渠道不能发图片和文件，表情包会以 `[表情包：名字] URL` 的文字形式返回。

## 新增渠道

实现 [`src/channels/types.ts`](../src/channels/types.ts) 里的 `ChannelAdapter`，然后在 [`src/channels/index.ts`](../src/channels/index.ts) 里注册，路由会自动生成 `/api/webhook/<name>`。

| 成员 | 必需 | 作用 |
|---|---|---|
| `name` | 是 | 渠道名，也是 URL 里的路径 |
| `isConfigured()` | 是 | 凭据是否齐全，不齐全时返回 503 |
| `receive(req, rawBody)` | 是 | 验签并解析成 `InboundMessage`；也可以直接返回一个响应（比如地址校验） |
| `send(message, text)` | 否 | 发送一条文字回复。不实现时，该渠道为同步模式 |
| `sendImage(message, url)` | 否 | 按 URL 发图片（表情包）。不实现时用文字代替 |
| `sendFile(message, file)` | 否 | 上传并发送文件。不实现时 `send_file` 会返回错误 |
| `typing(message)` | 否 | 显示"正在输入" |
| `promptHint` | 否 | 追加到系统提示词后面的格式要求，例如"不要用 Markdown" |

`InboundMessage.replyContext` 用来保存回复时需要的平台信息（比如 QQ 的 `msg_id` 和 `msg_seq` 计数），在同一轮的多次发送之间共享。
