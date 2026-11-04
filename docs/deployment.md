# 部署

本项目是一个标准的 Vercel 项目：`api/` 目录下的文件就是 Vercel Functions，不需要构建配置。

## 准备

- 一个 Vercel 账号，Hobby（免费）套餐即可。
- 一个模型 API Key，默认使用 [OpenRouter](https://openrouter.ai)。
- 至少一个渠道的凭据，见[渠道接入](channels.md)。

## 部署到 Vercel

1. 在 Vercel 导入本仓库，或者在本地运行 `npx vercel`。
2. 在项目的 **Settings → Environment Variables** 里填写环境变量，完整列表见[配置参考](configuration.md)。
3. 部署完成后访问 `https://<域名>/api/health`，检查返回结果：

   | 字段 | 含义 |
   |---|---|
   | `apiKey` | 是否配置了模型 API Key |
   | `extraBody` | `OPENROUTER_EXTRA_BODY` 的解析结果 |
   | `tools` | 当前启用的工具 |
   | `store` | `upstash` 或 `memory` |
   | `memory` / `sandbox` | 长期记忆和沙盒是否启用 |
   | `channels` | 各渠道是否已配置凭据 |

**修改环境变量后要重新部署。** 已经在运行的部署不会读到新值。可以在 Deployments 页面对最新一次部署点 Redeploy，或者再运行一次 `npx vercel --prod`。

**敏感变量读不出来。** 标记为 Sensitive 的变量保存后无法再查看原值，修改时只能整段重写。像 `OPENROUTER_EXTRA_BODY` 这种不含密钥的配置，建议存成普通变量（CLI 加 `--no-sensitive`），方便以后查看和修改。

## 函数时长

`vercel.json` 把 Webhook 函数的 `maxDuration` 设为 300 秒，这是 Hobby 套餐的上限。平台要求很快拿到回执，所以函数先返回回执，再用 `waitUntil` 在后台继续处理，后台处理同样受 300 秒限制。

如果你修改了 `maxDuration`，记得同步修改 `AGENT_MAX_DURATION_SECONDS`，agent 会根据它决定何时收尾。剩余时间不够开始新的一轮、又还有消息没处理时，它会调用内部接口 `/api/worker`（同样设置了 300 秒），由新的函数实例接着处理。

## 存储

存储保存每个聊天的事件流、图片、运行锁、去重记录和采样锁，生产环境必需。不配置时退化为内存存储，只适合本地开发：Serverless 会同时启动多个实例，内存在实例之间不共享，锁也就失效了，表现为"机器人记不住上下文"和重复回复。

支持两种存储，接口完全一样，用 `STORE_BACKEND` 选择（不设置时优先 Supabase）：

### Supabase（推荐）

免费版 API 请求不限次数，只按数据量和流量限制，适合消息多的群。

1. 在项目的 **Storage** 页面添加 Supabase：Free 套餐，区域选 Singapore（和函数所在的 `sin1` 同区）。连接项目后会自动注入 `SUPABASE_URL`、`SUPABASE_SECRET_KEY` 等变量。
2. 打开 Supabase 控制台的 **SQL Editor**，执行 [`supabase/schema.sql`](../supabase/schema.sql)。它会在私有 schema `gateway` 里建表（开启 RLS），在 `public` 里建一组只有服务端密钥能调用的函数，并用 pg_cron 每天清理过期数据。重复执行是安全的。
3. 重新部署，`/api/health` 的 `store` 应显示 `supabase`。

每个存储操作是一次函数调用（`POST /rest/v1/rpc/<函数名>`）。免费项目一周没有数据库活动会被暂停，在控制台点 **Resume project** 即可恢复；机器人每天有人聊天就不会暂停。

### Upstash Redis

在 **Storage** 页面添加 Upstash Redis，会自动注入 `KV_REST_API_URL` 和 `KV_REST_API_TOKEN`。免费版每月 50 万条命令，每条命令都计数，热闹的群容易用完。

### Upstash Vector（长期记忆，可选）

在 **Storage** 页面添加 Upstash Vector，参数如下：

| 设置项 | 取值 |
|---|---|
| 套餐 | Free |
| Index Type | DENSE |
| Dense Embedding Model | `TEXT_EMBEDDING_3_SMALL` |
| Similarity Function | COSINE |
| 连接项目时的 Custom Prefix | `UPSTASH_VECTOR_REST` |

前缀设为 `UPSTASH_VECTOR_REST` 后，注入的变量正好是代码读取的 `UPSTASH_VECTOR_REST_URL` 和 `UPSTASH_VECTOR_REST_TOKEN`。Upstash 目前只为新索引提供 `text-embedding-3-small` 这一个托管 embedding 模型（1536 维，正好是免费版上限，支持多语言）。

### Vercel Sandbox（沙盒工作区，可选）

部署在 Vercel 上时，SDK 自动使用项目的 OIDC token 认证，不需要任何配置。如果日志里出现 `Could not get credentials from OIDC context`，请在项目设置里确认 OIDC Federation 已开启。

沙盒和工作区盘默认在 `iad1`。想换区域，请在第一次使用前设置 `SANDBOX_REGION`，因为盘建好以后区域就不能再改。

## 自定义域名

**在中国大陆使用 QQ 机器人时，必须绑定自定义域名。** QQ 开放平台的服务器访问不了 `*.vercel.app`，表现为回调地址校验失败（"签名校验不通过"），而 Vercel 的日志里看不到任何请求。

1. 在 Vercel 项目的 **Settings → Domains** 添加你的域名，例如 `bot.example.com`。
2. 在域名的 DNS 里添加 Vercel 给出的 CNAME 记录。如果用 Cloudflare 托管 DNS，请把代理关掉（灰色云朵，DNS only），让 Vercel 自己签发证书。
3. 等证书签发完成后，把 QQ 的回调地址改成 `https://bot.example.com/api/webhook/qq`。

## 免费额度与资源消耗

各服务都有免费额度，以下数字以各服务官网为准：

| 服务 | 免费额度 | 超出后 |
|---|---|---|
| Supabase | API 请求不限次数，500 MB 数据库，每月 5 GB 出站流量；一周无活动会暂停 | 需升级套餐 |
| Upstash Redis（如果用它做存储） | 每月 50 万次命令，256 MB 数据 | 需升级套餐 |
| Upstash Vector | 每天 1 万次查询或写入，1 GB 数据 | 需升级套餐 |
| Vercel Sandbox（Hobby） | 每月 5 个 CPU 小时、420 GB·小时内存、5000 次创建；盘的存储总共 15 GB，不按月重置 | 创建暂停到下个周期，**不会扣费** |

每条消息的大致消耗：

| 消息类型 | Vercel 函数调用 | 存储操作 | 模型调用 |
|---|---|---|---|
| 群里没 @ 的消息，只写入 | 1 | 约 5 | 0 |
| 旁观唤起，模型不插话 | 1 | 约 20 | 1 |
| 私聊 / 被 @，一步回复 | 1 | 约 22 | 1 |
| 每多一步（查资料、跑代码） | — | 约 4 | 1 |

旁观唤起的数字由测试实测（`npm test` 里的 cost 用例），其余为估算。用 Supabase 时存储操作不限次数；用 Upstash 时每个操作算一条命令，按免费版每月 50 万条估算，大约每天能支撑 700 次唤起。

**流量**：每次运行开始时，会把这轮要用的事件和图片从存储读出来（同一个函数实例会缓存读过的事件）。图片多的聊天要留意 Supabase 每月 5 GB 的出站流量。

**模型费用**：每次唤起，模型看到的都是完整的事件流，最多到 `AGENT_CONTEXT_TOKENS` 的 80% 才压缩。事件流只追加，所以绝大部分输入都能命中提示词缓存（日志里 `[turn]` 行的 `cached=` 就是命中的 token 数），但旁观唤起越频繁，费用越高。

长期记忆每次 `remember` 或 `recall` 算一次 Vector 请求。沙盒只在调用工作区工具时才会创建，按实际使用的 CPU 时间计费。
