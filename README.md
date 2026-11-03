# channel-agent-gateway

部署在 Vercel Serverless 上的多渠道消息网关：各 IM 平台通过 **Webhook** 把消息推过来 → 按渠道解析、验签 → 跑 **agent loop**（OpenRouter 模型 + 工具调用）→ 用该渠道的 API 回复。

```
QQ 开放平台 ──┐                         ┌─► QQ  /v2/users|groups/{id}/messages
Telegram ────┼─► /api/webhook/:channel ─┤
任意 HTTP ───┘    验签 → ACK → waitUntil  └─► Telegram sendMessage / HTTP 同步返回
                       │
                       ▼
            去重 → 读历史 → agent loop ⇄ tools → 存历史
                       (Responses API)
```

## 为什么用 Webhook

Serverless 函数是"请求进来才运行、用完即销毁"的，**无法维持 WebSocket 长连接**（QQ 默认的接入方式需要常驻进程做心跳和断线续传）。各平台都提供 HTTP 回调模式，这正好契合 Vercel Functions：

| 平台 | Webhook 鉴权 | 回执要求 |
|---|---|---|
| QQ | Ed25519 签名（种子由 AppSecret 派生），`op:13` 回调地址验证 | 立即返回 `{"op":12,"d":0}`，否则平台重推 |
| Telegram | `X-Telegram-Bot-Api-Secret-Token` 头 | 返回 200 |
| HTTP | `Authorization: Bearer <HTTP_CHANNEL_TOKEN>` | 同步返回 `{ "reply": "多条用换行拼接", "messages": ["…", "…"] }` |

模型推理通常要好几秒，所以 QQ / Telegram 是**先 ACK、后处理**：用 `@vercel/functions` 的 `waitUntil` 让函数在返回响应后继续跑 agent loop 并发送回复（`maxDuration` 设为 300 秒）。平台的重推用 `eventId` + Redis `SET NX` 去重。

## 目录

```
api/webhook/[channel].ts   # Vercel Function 入口：POST /api/webhook/{qq|telegram|http}
api/health.ts              # GET /api/health：查看各渠道是否已配置
src/webhook.ts             # 路由：选适配器 → 验签解析 → waitUntil / 同步回复
src/channels/              # 渠道适配器（qq.ts / telegram.ts / http.ts），实现 ChannelAdapter
src/agent/loop.ts          # agent loop（Responses API，工具调用循环）
src/agent/system-prompt.ts # 系统提示词（「大肥鱼」人设），直接改这个文件
src/agent/tools.ts         # 工具注册：send_message、get_current_time、calculate，按需扩展
src/agent/web-tools.ts     # web_search / web_fetch（DeepSeek 工具 API）
src/agent/account-tools.ts # get_search_balance / get_llm_key_limit
src/agent/handle.ts        # 去重、消息头、/reset 命令、历史读写
src/store/index.ts         # Upstash Redis（REST），未配置时退化为内存
scripts/dev-server.ts      # 本地开发服务器
scripts/selftest.ts        # 离线端到端测试（mock fetch）
```

## 部署

1. 导入到 Vercel（或运行 `npx vercel`），在 **Settings → Environment Variables** 中填写 `.env.example` 里的变量。至少需要 `OPENROUTER_API_KEY`，再加上至少一个渠道的凭据。
2. **会话存储**：在 Vercel Marketplace 添加 Upstash Redis，`KV_REST_API_URL` / `KV_REST_API_TOKEN` 会被自动注入。不配也能运行，但多实例之间历史不共享、去重也会失效。
3. 部署后访问 `https://<域名>/api/health`，确认各渠道是否显示为已配置。

### QQ 机器人

1. 在 [q.qq.com](https://q.qq.com) 创建机器人，拿到 AppID / AppSecret，填入 `QQ_APP_ID` / `QQ_APP_SECRET`。
2. 进入 **开发 → 回调配置**：
   - 回调地址填 `https://<域名>/api/webhook/qq`，保存时平台会发 `op:13`，由本服务自动完成签名验证。
   - 勾选事件：`C2C_MESSAGE_CREATE`（单聊）、`GROUP_AT_MESSAGE_CREATE`（群 @），频道可加 `AT_MESSAGE_CREATE` / `DIRECT_MESSAGE_CREATE`。
3. ⚠️ **IP 白名单**：QQ 开放平台对调用 OpenAPI（换 token、发消息）的来源 IP 有白名单限制。Vercel 函数的出口 IP 不固定，如果遇到"IP 不在白名单"之类的报错，可以选择：
   - 使用 Vercel 的 Static IPs（付费功能）；
   - 让发消息请求经过一个固定 IP 的代理。
4. 回复采用**被动回复**（带 `msg_id`、`msg_seq` 递增），同一条消息最多回 4 段。如果超出被动回复的时间窗口，平台会拒绝。主动推送不在本项目范围内。

### Telegram

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://<域名>/api/webhook/telegram&secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

私聊会直接回复。群聊中只有 @ 到机器人才会回复，前提是配置了 `TELEGRAM_BOT_USERNAME`。

### 通用 HTTP

```bash
curl -X POST https://<域名>/api/webhook/http \
  -H "Authorization: Bearer $HTTP_CHANNEL_TOKEN" \
  -H "content-type: application/json" \
  -d '{"conversationId":"demo","text":"现在上海几点？"}'
```

在任意渠道发送 `/reset` 可以清空当前会话的历史。

## 模型（Responses API）

`src/agent/loop.ts` 直接 `fetch` 请求 `POST {OPENROUTER_BASE_URL}/responses`。没有使用 SDK，这样自定义参数可以原样透传，`OPENROUTER_BASE_URL` 也可以换成任何兼容 Responses API 的网关。

每次请求的 body 由三部分合并而成：

```
{ model, ...OPENROUTER_EXTRA_BODY, instructions, input, tools, tool_choice }
```

`OPENROUTER_EXTRA_BODY` 是一个 JSON 对象，会按原样（snake_case）合入请求体：

- 它可以覆盖 `model`；
- 不能覆盖 `instructions`、`input`、`tools`、`tool_choice`，这几项由 agent loop 控制。

常见用法：

```bash
# 锁定供应商、禁止回退
OPENROUTER_EXTRA_BODY='{"provider":{"only":["openai"],"allow_fallbacks":false}}'
# 再加上推理强度和输出上限
OPENROUTER_EXTRA_BODY='{"provider":{"only":["openai"],"allow_fallbacks":false},"reasoning":{"effort":"high"},"max_output_tokens":4000}'
```

如果 JSON 写错，会在请求时直接报错。`GET /api/health` 的 `extraBody` 字段可以看到解析结果。另外，`OPENROUTER_EXTRA_HEADERS` 可以添加额外的请求头。

**agent loop 的流程**：OpenRouter 的 Responses API 是无状态的，不支持 `previous_response_id`，所以每一轮都要重放完整记录：

1. 把上一轮返回的 `output`（reasoning、message、function_call）按顺序原样追加到 `input`；
2. 为每个 `function_call` 追加一条对应 `call_id` 的 `function_call_output`；
3. 再次请求模型，直到模型不再调用工具为止。

最多执行 `AGENT_MAX_STEPS` 步，最后一步会强制 `tool_choice: "none"`，确保一定有回答。

## 系统提示词与消息头

系统提示词写在 `src/agent/system-prompt.ts` 里，修改后 push 并重新部署即可生效。每次请求时，代码会在它后面自动追加该渠道的格式要求，例如 QQ 会要求纯文本、不使用 Markdown。

每条用户消息的开头，代码都会自动加一行消息头，并且这一行会一起存进历史：

```
[2026/11/03周二 20:43 Asia/Shanghai｜群聊｜发送人 #3B6834]
大肥鱼你又在摸鱼？
```

加这一行有两个作用：

- 模型始终知道当前时间，不会再猜错日期；
- 在群聊里能分清每句话是谁说的。

关于这一行的格式：

- **发送人**：QQ 只提供每个机器人独立的 openid，所以发送人显示为 openid 的后 6 位；Telegram 会额外带上昵称。
- **时区**：默认 `Asia/Shanghai`，可以通过 `AGENT_TIMEZONE` 修改。

## 发消息：send_message 工具

模型通过调用 `send_message` 发言，调用一次就发出一条消息：

- **连发**：可以连续调用几次，像真人一样分几条发。每收到一条消息最多回 5 条，文字和表情包合计。
- **边查边说**：可以先发一句"等我查查"，再去调用搜索工具，查到后再发结果。
- **兜底**：如果模型一次都没调用 `send_message`，而是直接输出了正文，就把这段正文作为一条消息发出去。
- **QQ 的 `msg_seq`**：同一条入站消息下的多次回复，`msg_seq` 会跨调用依次递增。

### QQ 被动回复规则

规则来自腾讯 bot-docs 的 `send.md`：

| 场景 | 有效期（从用户发消息的时间算起） | 每条消息最多回复 |
|---|---|---|
| 单聊 | 60 分钟 | 5 次 |
| 群聊 | 5 分钟 | 5 次 |
| 频道 | 5 分钟 | 5 次 |

- **时间起点**：取 QQ 事件里的 `timestamp`，即用户发消息的时间，而不是我们收到回调的时间。如果事件里没有这个字段，就用当前时间。
- **超出限制提前拒绝**：超过有效期，或者已经回了 5 条，代码会**在调用 QQ 接口之前**直接拒绝，并把错误作为工具结果返回给模型，不会白白请求一次再被平台拒绝。
- **群聊要注意 5 分钟**：如果模型先搜索、再长时间思考，超过 5 分钟回复就发不出去了。
- **主动消息**：不针对某条消息、机器人主动发的消息，每月只有 4 条，本项目不使用。

## 表情包：send_sticker 工具

`send_sticker({ name })` 用于发一张「大肥鱼」表情包。`name` 是枚举值，可选的表情和各自的使用场景定义在 `src/agent/stickers.ts`：

- **情绪类**：28 张 Q 版动态 GIF，比如笑死、红温了、已老实、你礼貌吗、退退退、吃瓜、贴贴、晚安等。
- **梗图类**：10 张大肥鱼经典梗图，比如得加钱、摆烂、蹭饭、用户别走、无可奉告等。

**图片不在本仓库里**：表情包图片版权归原作者，本仓库不包含、也不再分发这些图片。代码发送表情包时，直接引用原站公开 CDN 上的图片地址，例如 `https://img.aigengtu.com/meme/3153.gif`。原站 README 明确说明欢迎开发者这样热链。

- **尺寸统一为最长边 512px**：QQ 会按图片的像素尺寸来决定显示大小。Q 版 GIF 的原图本来就是 512×512；梗图的原图有 700–1250px，所以改用原站提供的 512px 预览版（`0_preview/meme/NNN.webp`），这样两类表情包在聊天里显示的大小一致。
- **QQ 已实测**：GIF 和 webp 都能正常发送。
- **自托管**：想用自己托管的图片，就按相同的路径（`meme/NNN.gif`、`0_preview/meme/NNN.webp`）放到你自己的地址下，再设置 `STICKER_BASE_URL`，例如 `https://你的域名/stickers`。

**各渠道的发送方式**：

| 渠道 | 发送方式 |
|---|---|
| QQ 私聊 / 群聊 | 先调 `POST /v2/{users\|groups}/{id}/files` 上传，参数为 `file_type: 1` 加图片 URL，拿到 `file_info` 后缓存起来；再发送 `msg_type: 7` 消息。图片和文字共用 `msg_seq` 计数 |
| QQ 频道 | 在消息中直接带 `image: url` |
| Telegram | GIF 用 `sendAnimation`，其他图片用 `sendPhoto` |
| HTTP | 不发图，用文字代替：`[表情包：名字] URL` |

**历史记录**：发出的表情包会以 `[表情包：名字]` 的形式记入历史。

## 表情包出处与版权

> 本项目使用的「蓝色大肥鱼 / DeepSeek 娘」表情包来自社区整理的
> **[梗鲸 GengJing · 蓝色大肥鱼表情包档案馆](https://aigengtu.com)**
> （GitHub：[the-beating-light-of-the-nail/deepseek-chan-meme-pack](https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack)）。
>
> - 角色形象与原始画作的版权归原作者及社区创作者所有，本仓库**不包含任何图片文件**，只按原站公开的直链规则引用。
> - 原站说明：非营利的粉丝向玩梗可以随意使用，**商用请先联系原作者**。
> - 如果你是某张图片的权利人，请通过 [原仓库的侵权举报入口](https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack/issues/new?template=takedown-report.yml) 联系，或在本仓库提 issue，我们会移除对应条目。
> - 本仓库的 MIT 协议只适用于代码，不适用于这些表情包。

**换表情包或新增表情包**：在 `src/agent/stickers.ts` 里加一条记录（名字、站点编号、使用场景）即可。

## 工具

| 工具 | 说明 | 启用条件 |
|---|---|---|
| `send_message` | 发一条消息到当前会话（见上） | 始终启用 |
| `send_sticker` | 发一张大肥鱼表情包（见上） | 始终启用 |
| `get_current_time` | 当前时间（可指定时区） | 始终启用 |
| `calculate` | 四则运算、取模、乘方 | 始终启用 |
| `web_search` | 调用 DeepSeek 搜索接口 `POST /v1/tools/search`，支持 `site:`、`lang:`、`after:` 等搜索语法 | 配置了 `DEEPSEEK_API_KEY` |
| `web_fetch` | 调用 DeepSeek 抓取接口 `POST /v1/tools/fetch`，以 Markdown 返回网页正文（截断到 12k 字符） | 配置了 `DEEPSEEK_API_KEY` |
| `get_search_balance` | 查询 DeepSeek 账户余额（`GET /user/balance`），区分赠送余额和充值余额，并按 ¥5/千次估算还能搜索多少次 | 配置了 `DEEPSEEK_API_KEY` |
| `get_llm_key_limit` | 查询模型 Key 的额度（`GET {OPENROUTER_BASE_URL}/key`）：限额、剩余额度、重置周期，以及今日、本周、本月和累计用量（美元），另外返回最先触发拦截的预算 | 配置了 `OPENROUTER_API_KEY` |

> 余额和额度属于账户信息。机器人如果对外开放（比如进了群），任何人都能问到这些信息。介意的话，在 `src/agent/tools.ts` 里把这两个工具移除即可。

DeepSeek 的这两个接口是普通 HTTP API，所以由本服务作为函数工具来执行，和使用哪个模型无关。计费方式是每 1000 次成功请求 5 元；账号级 QPS 上限为 Search 100、Fetch 25。

**添加工具**：在 `src/agent/tools.ts` 的 `tools` 数组中追加 `{ name, description, parameters, run, enabled? }`。

## 添加渠道

实现 `src/channels/types.ts` 中的 `ChannelAdapter`：

- `receive`：验签并解析成 `InboundMessage`；
- `send`：发送回复（不实现 `send` 时为同步模式）。

然后在 `src/channels/index.ts` 中注册，路由会自动生成 `/api/webhook/<name>`。

## 本地开发

```bash
npm install
cp .env.example .env.local   # 填写变量
npm run dev                  # http://localhost:3000/api/webhook/{qq,telegram,http}
npm test                     # 离线端到端测试（不调用真实接口）
npm run typecheck
```

如果要在本地接收真实的 QQ / Telegram 回调，可以用 `cloudflared tunnel` 或 `ngrok` 把 3000 端口暴露出去。
