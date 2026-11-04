# 配置参考

所有配置都来自环境变量，每次读取时实时生效，测试和本地开发服务器可以随时覆盖。在 Vercel 上修改环境变量后，需要**重新部署**才会生效。

本地开发时把变量写进 `.env.local`，模板见 [`.env.example`](../.env.example)。

## 模型

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENROUTER_API_KEY` | （必填） | 模型的 API Key |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | 任何兼容 Responses API 的地址，请求发到 `{BASE_URL}/responses` |
| `OPENROUTER_MODEL` | `openai/gpt-6-luna` | 模型 ID |
| `OPENROUTER_EXTRA_BODY` | 空 | JSON 对象，原样合并进每次请求的请求体，见下文 |
| `OPENROUTER_EXTRA_HEADERS` | 空 | JSON 对象，作为额外的请求头，例如 `{"X-Title":"my-bot"}` |
| `OPENROUTER_TIMEOUT_MS` | `120000` | 单次模型请求的超时时间（毫秒） |

`OPENROUTER_EXTRA_BODY` 的常见写法：

```bash
# 锁定供应商、禁止回退
OPENROUTER_EXTRA_BODY='{"provider":{"only":["openai"],"allow_fallbacks":false}}'
# 再加上推理强度
OPENROUTER_EXTRA_BODY='{"provider":{"only":["openai"],"allow_fallbacks":false},"reasoning":{"effort":"high"}}'
```

它可以覆盖 `model`，但不能覆盖 `instructions`、`input`、`tools`、`tool_choice`，这几项由 agent loop 控制。JSON 写错时请求会直接报错，`/api/health` 的 `extraBody` 字段会显示解析结果。

## Agent

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_TIMEZONE` | `Asia/Shanghai` | 消息头里时间使用的时区 |
| `AGENT_MAX_STEPS` | `40` | 私聊或被 @ 时，一轮最多调用模型的次数 |
| `AGENT_MAX_DURATION_SECONDS` | `300` | 函数的时间上限，要和 `vercel.json` 的 `maxDuration` 保持一致。剩余不到 90 秒时，下一步就是最后一步 |
| `AGENT_HISTORY_LIMIT` | `100` | 每个私聊保留的消息条数 |
| `AGENT_GROUP_HISTORY_LIMIT` | `200` | 每个群保留的消息条数（包括所有人的消息） |
| `AGENT_HISTORY_TTL_DAYS` | `7` | 会话连续多少天没有新消息就整个删除 |
| `AGENT_AMBIENT_INTERVAL_SECONDS` | `10` | 群里没 @ 的消息，每个群每隔多少秒最多触发一次模型；`0` 表示只记录、不触发 |
| `AGENT_AMBIENT_CONTEXT` | `40` | 旁观时模型能看到的最近消息条数 |
| `AGENT_AMBIENT_MAX_STEPS` | `3` | 旁观时一轮最多调用模型的次数 |

历史条数是防止资源耗尽的安全上限，不是给模型的上下文预算，详见 [Agent 与对话](agent.md#历史与缓存)。

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
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | 空 | Upstash Redis，Vercel Marketplace 集成会自动注入这两个变量 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 空 | 直接使用 Upstash 时的变量名，优先级高于上面两个 |
| `UPSTASH_VECTOR_REST_URL` / `UPSTASH_VECTOR_REST_TOKEN` | 空 | Upstash Vector，用于长期记忆；为空时记忆工具不启用 |

Redis 未配置时退化为内存存储：单实例能用，但多实例之间历史不共享，去重和采样也会失效。

## 工具

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | 启用 `web_search`、`web_fetch`、`get_search_balance` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek 接口地址 |
| `SANDBOX_ENABLED` | 自动 | 部署在 Vercel 上或本地有 `VERCEL_OIDC_TOKEN` 时自动启用；设为 `0` 关闭，设为 `1` 强制启用 |
| `SANDBOX_REGION` | `iad1` | 沙盒和工作区盘所在的区域。盘建好以后区域不能再改，请在第一次使用前设置 |
| `SANDBOX_COMMAND_TIMEOUT_SECONDS` | `60` | 单条 `bash` 命令的时间上限，临近函数时限时会自动缩短 |
| `STICKER_BASE_URL` | 梗鲸 CDN | 表情包图片的根地址，自托管时修改 |
