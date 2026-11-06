# 配置参考

下面的配置都可以在[管理端](admin.md)（`/admin`）里填写，存进数据库，改完 30 秒内生效，不用重新部署。每一项按这个顺序取值：**管理端 → 同名环境变量 → 默认值**，所以也可以照旧只用环境变量。直接改环境变量时，需要**重新部署**才会生效。

只能用环境变量设置的有：`ADMIN_PASSWORD`（管理端密码，也用来加密存进数据库的 key）、数据库连接（`SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`POSTGRES_URL_NON_POOLING`），以及 `AGENT_MAX_DURATION_SECONDS`。

本地开发时把变量写进 `.env.local`，模板见 [`.env.example`](../.env.example)。

## 模型

网关调用的是 OpenAI 的 Responses API 协议（`POST {BASE_URL}/responses`），任何兼容这个协议的服务都能用：OpenRouter、OpenAI 官方、自建网关等。默认地址是 OpenRouter。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENAI_RESPONSES_API_KEY` | （必填） | 模型的 API Key |
| `OPENAI_RESPONSES_BASE_URL` | `https://openrouter.ai/api/v1` | 任何兼容 Responses API 的地址，请求发到 `{BASE_URL}/responses`。用 OpenAI 官方时填 `https://api.openai.com/v1` |
| `OPENAI_RESPONSES_MODEL` | `openai/gpt-6-luna` | 模型 ID，格式以服务商为准（OpenRouter 是 `厂商/模型`） |
| `OPENAI_RESPONSES_EXTRA_BODY` | 空 | JSON 对象，原样合并进每次请求的请求体，见下文 |
| `OPENAI_RESPONSES_EXTRA_HEADERS` | 空 | JSON 对象，作为额外的请求头，例如 `{"X-Title":"my-bot"}` |
| `OPENAI_RESPONSES_TIMEOUT_MS` | `280000` | 单次模型请求的超时上限（毫秒）。运行中还会按函数剩余时间缩短（剩余时间减 20 秒），取两者较小的 |
| `MODEL_PRICE_INPUT` / `MODEL_PRICE_CACHED` / `MODEL_PRICE_OUTPUT` | 空 | 美元 / 百万 token。接口不返回花费时，用它们估算每个聊天的花费（每群额度按它算）。OpenRouter 会返回花费，可以不填 |

`OPENAI_RESPONSES_EXTRA_BODY` 的常见写法（`provider` 是 OpenRouter 特有的参数）：

```bash
# 锁定供应商、禁止回退
OPENAI_RESPONSES_EXTRA_BODY='{"provider":{"only":["openai"],"allow_fallbacks":false}}'
# 再加上推理强度
OPENAI_RESPONSES_EXTRA_BODY='{"provider":{"only":["openai"],"allow_fallbacks":false},"reasoning":{"effort":"high"}}'
```

它可以覆盖 `model`，但不能覆盖 `instructions`、`input`、`tools`、`tool_choice`，这几项由 agent loop 控制。JSON 写错时请求会直接报错，`/api/health` 的 `extraBody` 字段会显示解析结果。

**旧变量名**：早期版本用的是 `OPENROUTER_API_KEY`、`OPENROUTER_BASE_URL` 等 `OPENROUTER_` 开头的名字，现在仍然能读。新旧名字同时存在时以新名字为准。还在用旧名字时，`/api/health` 会多出一个 `legacyEnv` 字段列出它们，按上表改名后重新部署即可。

## Agent

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_TIMEZONE` | `Asia/Shanghai` | 消息头里时间使用的时区 |
| `AGENT_MAX_STEPS` | `40` | 一轮最多调用模型的次数（旁观轮次也一样；不插话时只用 1 次） |
| `AGENT_MAX_DURATION_SECONDS` | `300` | 函数的时间上限，要和 `vercel.json` 的 `maxDuration` 保持一致。剩余不到 100 秒时不开新的一步，交给新的 worker 接着做，见[步数与时间](agent.md#步数与时间) |
| `AGENT_CONTEXT_TOKENS` | `200000` | 上下文预算（token）。请求输入超过它的 80% 时，较早的对话会被压缩成摘要，见[上下文压缩](agent.md#上下文压缩) |
| `AGENT_AMBIENT_INTERVAL_SECONDS` | `10` | 群里没 @ 的消息，每个群每隔多少秒最多唤起一次 agent；`0` 表示只记录、不唤起 |

每次唤起，模型看到的都是这个聊天的完整事件流（超过预算的部分已压缩）。在很热闹的群里，旁观唤起的频率直接决定模型费用，见[资源消耗](deployment.md#免费额度与资源消耗)。

## 管理端

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 空 | 管理端密码，只能用环境变量设置。不设置时管理端打不开，也不能在管理端保存 key |
| `CHAT_DEFAULT_MODE` | `normal` | 没单独设置过的聊天怎么回复：`normal`、`mention`（只回 @）、`record`（只记录）、`block`（屏蔽），见[每个聊天的设置](admin.md#每个聊天的设置) |
| `HISTORY_RETENTION_DAYS` | `30` | 管理端里的聊天记录保留多少天 |

## 渠道

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QQ_APP_ID` | 空 | QQ 机器人的 AppID |
| `QQ_APP_SECRET` | 空 | QQ 机器人的 AppSecret，同时用于派生 Webhook 验签密钥 |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram Bot Token |
| `TELEGRAM_WEBHOOK_SECRET` | 空 | 调用 `setWebhook` 时传的 `secret_token` |
| `TELEGRAM_BOT_USERNAME` | 空 | 机器人用户名（不带 @）。群里只回复 @ 它的消息；不配置时群里不回复 |
| `HTTP_CHANNEL_TOKEN` | 空 | 通用 HTTP 渠道的 Bearer Token；为空时该渠道关闭 |

没有配置凭据的渠道会返回 503，`/api/health` 的 `channels` 字段会显示为 `false`。

## 存储

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SUPABASE_URL` | 空 | Supabase 项目地址，Vercel Marketplace 集成会自动注入 |
| `SUPABASE_SECRET_KEY` | 空 | 服务端密钥（`sb_secret_…`），集成会自动注入 |
| `UPSTASH_VECTOR_REST_URL` / `UPSTASH_VECTOR_REST_TOKEN` | 空 | Upstash Vector，用于长期记忆；为空时记忆工具不启用 |

没配置 Supabase 时退化为内存存储：单实例能用，但多实例之间历史不共享，锁、去重和采样也会失效。Supabase 需要先执行 [`supabase/schema.sql`](../supabase/schema.sql)，见[部署文档](deployment.md#存储supabase)。聊天数据保留多久见[数据保留](deployment.md#存储supabase)。

## 工具

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | 启用 `web_search`、`web_fetch`、`get_search_balance` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek 接口地址 |
| `SANDBOX_ENABLED` | 自动 | 部署在 Vercel 上或本地有 `VERCEL_OIDC_TOKEN` 时自动启用；设为 `0` 关闭，设为 `1` 强制启用 |
| `SANDBOX_REGION` | `iad1` | 沙盒和工作区盘所在的区域。盘建好以后区域不能再改，请在第一次使用前设置 |
| `SANDBOX_COMMAND_TIMEOUT_SECONDS` | `60` | 单条 `bash` 命令的时间上限，临近函数时限时会自动缩短 |
| `WORKER_SECRET` | 由其他密钥派生 | 请求 `/api/worker` 的签名密钥。不设置时用模型 Key 和渠道密钥派生；建议设成一个随机字符串 |
| `STICKER_BASE_URL` | 梗鲸 CDN | 表情包图片的根地址，自托管时修改 |

## 画图

`generate_image` 调用 OpenRouter 的 Image API（`POST {IMAGE_BASE_URL}/images`）。配置了 `IMAGE_API_KEY` 并且沙盒可用时才启用（生成的图要存进工作区，再用 `send_file` 发出去）。变量名后半段和接口字段一致。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `IMAGE_API_KEY` | 空 | 图像接口的 API Key，不设置时不启用画图。和模型 Key 是分开的，用同一个 OpenRouter Key 也可以 |
| `IMAGE_BASE_URL` | `https://openrouter.ai/api/v1` | 请求发到 `{IMAGE_BASE_URL}/images` |
| `IMAGE_MODEL` | `openai/gpt-image-2.6-sunburst` | 图像模型 |
| `IMAGE_QUALITY` | `low` | 对应接口的 `quality`：`auto`、`low`、`medium`、`high`、`xhigh`、`max`。只能在这里设，模型不能自己调高，因为它决定价格 |
| `IMAGE_RESOLUTION` | 空（不发） | 对应接口的 `resolution`：`512`、`768`、`1K`、`1.5K`、`2K`、`4K`，只对支持它的模型有用（看 OpenRouter `GET /api/v1/images/models` 里模型的 `supported_parameters`）。默认的 gpt-image 系列**不支持**，发了也会被忽略，按画幅出约 1024px 的图（1024×1024、1024×1536、1536×1024）。结果都会再缩到 1920×1080 以内（横竖都算）再保存 |
| `IMAGE_EXTRA_BODY` | 空 | JSON 对象，合并进请求体，例如 `{"provider":{"options":{"openai":{"moderation":"low"}}}}` |
| `IMAGE_TIMEOUT_MS` | `180000` | 单次请求的超时时间（毫秒），临近函数时限时会自动缩短 |
| `IMAGE_SELF_REFERENCE` | `assets/persona/dafeiyu.webp` | 大肥鱼的形象图：部署里的文件路径或 https 链接，画她自己时作为参考图（`include_self`）。填 `none` 关闭。放进仓库的新文件要在 `vercel.json` 的 `includeFiles` 里能匹配到（现在整个 `assets/` 都会打包），体积尽量小 |

## 语音

`send_voice` 调用 OpenAI 兼容的语音接口（`POST {TTS_BASE_URL}/audio/speech`），默认是 OpenRouter 上的 Fish Audio Drama 3。配置了 `TTS_API_KEY` 才启用。变量名后半段和接口字段一致。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TTS_API_KEY` | 空 | 语音接口的 API Key，不设置时不启用语音。用同一个 OpenRouter Key 也可以 |
| `TTS_BASE_URL` | `https://openrouter.ai/api/v1` | 请求发到 `{TTS_BASE_URL}/audio/speech` |
| `TTS_MODEL` | `fish-audio/drama-3` | 语音模型，模型调用工具时不能改。已适配 `fish-audio/drama-3` 和 `bytedance-seed/seed-audio-1-0`（工具描述会教对应的写法）；换别的模型要确认它支持 `pcm` 输出，克隆声音还要支持 `input_references` |
| `TTS_VOICE` | 空 | 对应接口的 `voice`，填服务商的音色 ID。只在不克隆（模型选了音色 `none`，或没有参考音频）时发送 |
| `TTS_REFERENCE_AUDIO` | `assets/voice/dafeiyu.mp3` | 要克隆的声音：部署里的文件路径（相对项目根目录），或 https 链接；填 `none` 不克隆。放进仓库的新文件要在 `vercel.json` 的 `includeFiles` 里能匹配到，体积尽量小（单声道、32 kbps 左右的 mp3 就够） |
| `TTS_REFERENCE_TEXT` | 内置参考音频的文字稿 | 参考音频说的话，有助于克隆。换了参考音频要一起改，不填就不发 |
| `TTS_SING_REFERENCE_AUDIO` | 空 | 可选：同一个声音**唱歌**的参考音频（文件或 https 链接）。设置后模型多一个音色 `dafeiyu_sing` 可选 |
| `TTS_SING_REFERENCE_TEXT` | 空 | 唱歌参考音频里唱的词 |
| `TTS_INSTRUCTIONS` | 空 | 对应接口的 `instructions`：每条语音都带的语气，例如 `软萌可爱的小女孩`。模型调用时给的 `instructions` 会接在后面 |
| `TTS_EXTRA_BODY` | 空 | JSON 对象，合并进请求体，例如 `{"speed":1.1}` |
| `TTS_TIMEOUT_MS` | `120000` | 单次请求的超时时间（毫秒），临近函数时限时会自动缩短 |
