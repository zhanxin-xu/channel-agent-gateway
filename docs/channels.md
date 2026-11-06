# 渠道接入

每个渠道对应一个 Webhook 地址：`POST https://<域名>/api/webhook/<渠道名>`。

| 渠道 | 鉴权方式 | 回复方式 | 实测情况 |
|---|---|---|---|
| `qq` | Ed25519 签名（密钥由 AppSecret 派生） | 先回执，后台调用 QQ OpenAPI 回复 | ✅ 生产环境在用 |
| `telegram` | `X-Telegram-Bot-Api-Secret-Token` 请求头 | 先回执，后台调用 Bot API 回复 | 仅离线测试 |
| `http` | `Authorization: Bearer <HTTP_CHANNEL_TOKEN>` | 同步：等 agent 跑完，直接在响应里返回 | 仅离线测试 |

> **目前只有 QQ 机器人在真实环境里跑过。** Telegram 和 HTTP 渠道由 `npm test` 的离线端到端测试覆盖（平台接口是模拟的），还没有用真实账号验证过。用的时候遇到问题，欢迎[提 Issue](https://github.com/zhanxin-xu/serverless-agent-gateway/issues)。

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

QQ 频道（`AT_MESSAGE_CREATE` / `DIRECT_MESSAGE_CREATE`）只按官方文档实现，还没用真实消息验证过。

### 常见的坑

| 现象 | 原因与解决 |
|---|---|
| 保存回调地址时校验失败（"签名校验不通过"），Vercel 日志里却一条请求都没有 | 在中国大陆，QQ 开放平台的服务器访问不了 `*.vercel.app`，请求根本没到你的函数。绑定[自定义域名](deployment.md#自定义域名)，用它填回调地址；DNS 若在 Cloudflare，记得关掉代理（灰色云朵） |
| 群里只有 @ 机器人才有反应，没 @ 的消息完全收不到 | 只勾选 `GROUP_MESSAGE_CREATE` 不够，还要**群主在手机 QQ 里给这个机器人"设置权限"，开启"接收全量消息"**，平台才会推送。这是按群设置的，每个群都要单独开。详见下文[群聊全量消息](#群聊全量消息) |
| 日志里大量 `ConnectTimeoutError`（连 `api.sgroup.qq.com` 超时），机器人不说话 | Vercel 机房到 QQ 接口服务器的网络临时不通。网关会自动重试一次连接，还不通就结束这一轮，不让模型反复重发；之后的新消息会重新尝试。一般几分钟内自己恢复 |
| 群里回复发不出去，报主动消息没权限 | 群聊的被动回复只在用户发消息后 5 分钟内有效；过了就改发主动消息，这需要群主在群设置里开启「机器人主动在群聊内发言」。发不出去的内容，下次群里有人说话时它会补上，见[被动回复和主动消息](#被动回复和主动消息) |
| 调用 OpenAPI 报"IP 不在白名单" | Vercel 函数的出口 IP 不固定，见上面的第 4 步 |
| 改了环境变量但没有生效 | 已经在运行的部署读不到新值，要重新部署一次，见[部署文档](deployment.md#部署到-vercel) |

### 群聊全量消息

订阅 `GROUP_MESSAGE_CREATE` 后，机器人也能看到群里没有 @ 它的消息。这还需要**群主在手机 QQ 里给机器人"设置权限"，开启"接收全量消息"**，平台才会推送，详见 QQ 机器人官方 FAQ。

开启后，群消息分两类处理：

| | 群里没 @ 的消息 | @ 机器人 / 私聊 |
|---|---|---|
| 写入事件流 | 每条都写 | 每条都写 |
| 唤起 agent | 每个群每 10 秒最多一次，由模型决定要不要插话，默认不说话 | 每次都唤起，一定回复 |
| 已经有 agent 在跑时 | 只写入，正在跑的 agent 下一步就能看到 | 同左 |

几个人同时 @ 机器人，只会有一个 agent 来处理，它在一轮里分别回应每个人，详见 [Agent 与对话](agent.md#两个解耦的部分)。

这些数字都可以配置，见[配置参考](configuration.md#agent)。处理细节：

- **怎样算 @ 了机器人**：`mentions` 里有一项 `is_you` 为真、并且不是 @全体成员（QQ 给 @全体成员 也标 `is_you`，`scope` 为 `"all"`），或者正文里有 `<@!AppID>`，或者事件类型是 `GROUP_AT_MESSAGE_CREATE` 且消息里没有 @全体成员。@别人、正文里的 "@" 符号都不算。
- **表情**：正文里的 `<faceType=…,faceId="…",ext="…">` 会解码成 `[表情：名字]`（名字取自 base64 JSON 的 `text`）；`ext` 里如果还有别的字段，原样跟在名字后面（比如骰子点数），并打一行 `[qq] face` 日志。
- **同一条消息可能推两次**：一条 @ 消息可能同时作为全量消息和 @ 消息推送。服务按消息 ID 去重，只记录一次、只回复一次。
- **采样窗口存在会话行里**，多个实例共享同一个时间窗口。
- **忽略其他机器人**：其他机器人发的消息直接丢弃，避免互相刷屏。
- **@ 别人**：消息里的 @ 标记（`<@openid>` 或 `<qqbot-at-user id="…" />`）换成模型认得的写法：`@昵称 #编号`（昵称取自事件的 `mentions` 列表），`<qqbot-at-everyone />` 换成 `@全体成员`；@ 机器人自己的标记去掉，消息头里已经有"@你"。被 @ 的人和发送人的 openid 一起记进事件流（模型看不到），用来认人。
- **机器人 @ 别人**：模型在群消息里写 `@#编号`（比如 `@#AB2C08`）。QQ 群里只有 **Markdown 消息**能 @ 人（[文本交互](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html)：群聊 @用户 只支持 Markdown，id 填 `member_openid`；普通文本里的标签会原样显示），所以带 @ 的这条消息改用 `msg_type: 2` 发，`@#编号` 换成 `<qqbot-at-user id="member_openid" />`，其余文字转义掉 Markdown 符号（`*`、`_`、`` ` ``、`[`、行首的 `#`、`-` 等）。群聊 Markdown 从 2026-04-23 起所有机器人都能发，不用申请。QQ 拒收 Markdown 时退回普通文本，@ 写成 `@昵称`；QQ 连不上时不重发，免得发两遍。只有这个群的事件流里出现过、而且记下了完整 openid 的人能被真的 @；只知道昵称的（升级前的旧消息）写成 `@昵称`，完全没见过的编号原样发出。私聊里不转换。要查编号用 `chat_members` 工具。QQ 不给机器人群成员列表，所以没说过话的人查不到。

### 引用回复

发消息的工具（`send_message`、`send_sticker`、`send_voice`、`send_file`）都有 `quote` 参数，由模型决定要不要引用：设为 `true` 时，这条回复在 QQ 里显示成引用框，引用的就是 `reply_to` 那条消息。实现是在发送时加 `message_reference: { message_id: "REFIDX_…" }`，`REFIDX_…` 取自那条消息事件里 `message_scene.ext` 的 `msg_idx=…`，收消息时存进回复上下文。QQ 文档里没写这个字段，用法参照 NoneBot 的 QQ 适配器；QQ 拒收带引用的回复时，去掉引用再发一次，消息不会丢。长文本拆成几段时只有第一段带引用；升级前收到的消息没存 `msg_idx`，引用不了，照常回复。

### 被动回复和主动消息

在有效期内，机器人的回复是被动回复：带上用户消息的 `msg_id`，`msg_seq` 依次递增。平台规则如下：

| 场景 | 有效期（从用户发消息时算起） | 每条消息最多回复 |
|---|---|---|
| 单聊 | 60 分钟 | 5 次 |
| 群聊 | 5 分钟 | 5 次 |
| 频道 | 5 分钟 | 5 次 |

- **时间起点**取事件里的 `timestamp`，即用户发消息的时间，而不是收到回调的时间。
- **过了有效期改发主动消息**：群聊和单聊里，过了有效期的回复不带 `msg_id`，作为一条普通消息发到同一个群或私聊里。QQ 现在允许群聊主动消息（[消息收发概述](https://bot.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)：每群每分钟 20 条、每天 1000 条），前提是群主在群设置里开启「机器人主动在群聊内发言」；私聊要对方没有关闭接收主动消息。频道里过了有效期仍然发不出去。
- **QQ 拒收主动消息时**（错误码 40034105 没权限，或 40034100 / 22009 超频），工具结果会说明原因，并告诉模型别再挑旧消息重试、先挂断；之后每一轮开头都会提醒它有哪些消息没发出去，下次群里有人说话时补上。
- **已经回了 5 条时会提前拒绝**：服务在调用 QQ 接口之前就拒绝，并把错误作为工具结果交给模型。主动消息也算在这 5 次里，防止模型刷屏。
- 文字、表情包、文件共用这 5 次额度。回复次数和 `msg_seq` 存在数据库里，跨轮次延续，不会出现重复的 `msg_seq`。
- 多条消息合并处理时，默认回复最新一条还在有效期内的 @ 消息；都过期了才用主动消息。模型也可以用 `reply_to` 回复其中任意一条。
- 管理端代发和悄悄话遵循同样的规则：有效期内挂在最近的消息上，过了就作为主动消息发出。

### 图片、语音和文件

收到的附件（事件里的 `attachments`）按类型处理：

| 附件 | 处理方式 |
|---|---|
| 图片 | 收到时下载，缩到最长边 512px 存进数据库（每条最多 4 张、每张原图不超过 8 MB），之后每次都以 base64 交给模型（`detail: "low"`），以前的图片模型也能再看 |
| 语音 | 使用 QQ 自带的转写文字 `asr_refer_text`，记为 `[语音] 文字` |
| 视频、文件 | 记为 `[视频]`、`[文件：文件名]` |

**引用回复**：用户在 QQ 里"回复"某条消息时，被引用的原消息也会跟着推过来，网关把它放在正文前面：`[引用 你 的消息：……]`（引用的是机器人自己的消息就写"你"，否则写昵称和 `#ID`）。被引用消息里的图片、文件也算作这条消息的附件，排在它自己的附件后面，所以模型能看到原图，也能用 `save_attachment` 取原图来改。这几个字段 QQ 文档里没写，用法参照 NoneBot、nanobot 等开源适配器：`message_type` 为 103，`message_scene.ext` 里的 `ref_msg_idx=X` 对应 `msg_elements` 中 `msg_idx` 为 X 的那一项。

图片、语音、视频、文件的**原始链接**都会跟消息一起记进事件流（模型看不到链接）。模型要处理原文件时（修图、读文档、转格式），调用 [`save_attachment`](tools.md#沙盒工作区) 把原图或原文件存进沙盒的 `/workspace/inbox/`，不限大小。QQ 的附件链接过一段时间会失效，太久以前的消息可能取不到，这时模型会请对方重发。

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
| `label` | 是 | 给人看的平台名（“QQ”），管理端显示用 |
| `isConfigured()` | 是 | 凭据是否齐全，不齐全时返回 503 |
| `receive(req, rawBody)` | 是 | 验签并解析成 `InboundMessage`；也可以直接返回一个响应（比如地址校验） |
| `send(message, text)` | 否 | 发送一条文字回复。不实现时，该渠道为同步模式 |
| `sendImage(message, url)` | 否 | 按 URL 发图片（表情包）。不实现时用文字代替 |
| `sendFile(message, file)` | 否 | 上传并发送文件。不实现时 `send_file` 会返回错误 |
| `typing(message)` | 否 | 显示"正在输入" |
| `promptHint` | 否 | 追加到系统提示词后面的格式要求，例如"不要用 Markdown" |
| `maxRepliesPerMessage` | 否 | 平台对一条消息最多允许几次回复（QQ 是 5）。不设置时用网关默认的 5 次，防止模型刷屏 |
| `replyRule` | 否 | 给人看的发送限制（QQ：只能回复最近的消息），管理端代发发不出去时显示 |
| `verify()` | 否 | 管理端的“检查”：验证凭据能用（比如取一次 token） |
| `connect(origin)` | 否 | 管理端的“设置 Webhook”：向平台登记回调地址，返回要顺便保存的设置 |

渠道的凭据写在配置目录 [`src/settings/catalog.ts`](../src/settings/catalog.ts) 里：加一个 `channel` 指向渠道名的设置组，管理端的引导页和配置页就会显示它。`connect` 会自动填的项标 `setByConnect`，可以由管理端随机生成的密钥标 `generate`。

`InboundMessage.replyContext` 用来保存回复时需要的平台信息（比如 QQ 的 `msg_id` 和 `msg_seq` 计数），在同一轮的多次发送之间共享。
