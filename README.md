# channel-agent-gateway

[![CI](https://github.com/zhanxin-xu/channel-agent-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/zhanxin-xu/channel-agent-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 24](https://img.shields.io/badge/node-24.x-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)

一个部署在 Vercel Functions 上的多渠道 AI 机器人网关。QQ、Telegram 或任意 HTTP 客户端通过 Webhook 把消息推进来，网关跑一个带工具调用的 agent loop，再从原渠道把回复发回去。

仓库自带一个示例人设「大肥鱼」：一个嘴毒、爱抬杠的群友。改一个文件就能换成你自己的机器人。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fzhanxin-xu%2Fchannel-agent-gateway&env=OPENROUTER_API_KEY&envDescription=OpenRouter%20API%20key%20for%20the%20model)

## 特性

- **多渠道接入**：QQ（单聊、群聊、频道，Ed25519 验签）、Telegram、通用 HTTP。所有渠道实现同一个适配器接口，新增渠道只需要写一个对象。
- **为 Serverless 设计**：先回执、后处理（`waitUntil`），平台重推用 Redis 去重；临近函数 300 秒时限时会自动收尾，不会悄无声息地超时。
- **任意 Responses API 模型**：直接调用 `POST /responses`，默认走 OpenRouter。请求体可以透传任意参数，比如锁定供应商、设置推理强度。
- **像真人一样聊天**：用 `send_message` 分几条连发，用 `end_turn` 主动挂断，会发表情包；在群里能旁观没 @ 它的消息，自己判断要不要插话。
- **看图、听语音**：图片直接交给模型看，QQ 语音使用平台自带的转写文字。
- **长期记忆**：基于 Upstash Vector 的语义检索，所有聊天共用一个记忆库，并记录每条记忆的来源。
- **沙盒工作区**：在 Vercel Sandbox 里跑 bash、Python、Node，每个聊天有一块自己的持久盘，能读图、能把文件发回聊天。
- **联网**：DeepSeek 搜索和网页抓取，另有余额和额度查询工具。
- **免费额度就能跑**：Vercel Hobby 加 Upstash 免费版即可运行，资源消耗见[部署文档](docs/deployment.md#免费额度与资源消耗)。

## 工作原理

```
 QQ / Telegram / HTTP
         │ Webhook
         ▼
 /api/webhook/:channel ── 验签 → 立即回执
         │ waitUntil
         ▼
 去重 → 记入历史 → 群聊采样 → agent loop ⇄ 工具 → 回复 → 记入历史
                                   │
      OpenRouter Responses API · Upstash Redis / Vector · Vercel Sandbox
```

## 快速开始

1. **部署**：点击上方的 Deploy 按钮，或者克隆仓库后运行 `npx vercel`。
2. **配置环境变量**：最少需要下面这些，完整列表见[配置参考](docs/configuration.md)。

   | 变量 | 说明 |
   |---|---|
   | `OPENROUTER_API_KEY` | 模型的 API Key |
   | `QQ_APP_ID` / `QQ_APP_SECRET` | QQ 机器人凭据（或者配置 Telegram、HTTP 渠道的凭据） |
   | `KV_REST_API_URL` / `KV_REST_API_TOKEN` | 推荐：在 Vercel Marketplace 添加 Upstash Redis 后自动注入。不配置时退化为内存存储，多实例之间不共享历史 |

3. **检查**：访问 `https://<你的域名>/api/health`，确认模型、渠道和工具都已就绪。
4. **接入渠道**：按[渠道接入](docs/channels.md)配置回调地址。在中国大陆使用 QQ 机器人时，必须绑定自定义域名，原因见[部署文档](docs/deployment.md#自定义域名)。

## 文档

| 文档 | 内容 |
|---|---|
| [部署](docs/deployment.md) | Vercel 部署、存储、自定义域名、免费额度与资源消耗 |
| [渠道接入](docs/channels.md) | QQ、Telegram、HTTP 的配置方法，QQ 被动回复规则，如何新增渠道 |
| [Agent 与对话](docs/agent.md) | 消息处理流程、agent loop、挂断机制、步数与时间限制、历史与缓存 |
| [工具](docs/tools.md) | 内置工具、长期记忆、沙盒工作区、表情包，如何新增工具 |
| [配置参考](docs/configuration.md) | 全部环境变量及默认值 |

## 自定义

| 想改什么 | 改哪里 |
|---|---|
| 人设和说话风格 | [`src/agent/system-prompt.ts`](src/agent/system-prompt.ts) |
| 工具 | [`src/agent/tools.ts`](src/agent/tools.ts)，见[新增工具](docs/tools.md#新增工具) |
| 渠道 | [`src/channels/`](src/channels/)，见[新增渠道](docs/channels.md#新增渠道) |
| 表情包 | [`src/agent/stickers.ts`](src/agent/stickers.ts) |

## 本地开发

需要 Node.js 24。

```bash
npm install
cp .env.example .env.local   # 填写需要的变量
npm run dev                  # http://localhost:3000/api/webhook/{qq,telegram,http}
npm test                     # 离线端到端测试，不调用任何真实接口
npm run typecheck
```

想在本地接收真实的 QQ 或 Telegram 回调，可以用 `cloudflared tunnel` 或 `ngrok` 把 3000 端口暴露出去。

## 项目结构

```
api/
  webhook/[channel].ts   Vercel Function 入口：POST /api/webhook/{qq|telegram|http}
  health.ts              GET /api/health：配置自检
src/
  webhook.ts             路由：选择适配器 → 验签解析 → 回执 → 后台处理
  channels/              渠道适配器（qq / telegram / http）
  agent/
    handle.ts            去重、消息头、群聊采样、历史读写
    loop.ts              agent loop（Responses API）
    system-prompt.ts     人设
    tools.ts             工具注册
    memory.ts            长期记忆（Upstash Vector）
    sandbox.ts           沙盒工作区（Vercel Sandbox + Drive）
    web-tools.ts         联网搜索与抓取
    account-tools.ts     余额与额度查询
    stickers.ts          表情包清单
    images.ts            图片下载
  store/                 Upstash Redis（REST），未配置时退化为内存
  config.ts              环境变量
scripts/
  selftest.ts            离线端到端测试
  sandbox-smoke.ts       用真实 Vercel Sandbox 跑一遍工作区工具
  dev-server.ts          本地开发服务器
docs/                    详细文档
```

## 参与贡献

欢迎提交 Issue 和 Pull Request，开始之前请先阅读[贡献指南](CONTRIBUTING.md)。发现安全问题时，请按[安全策略](SECURITY.md)私下报告，不要公开提 Issue。

## 致谢

示例人设使用的「蓝色大肥鱼 / DeepSeek 娘」表情包来自社区整理的 [梗鲸 GengJing · 蓝色大肥鱼表情包档案馆](https://aigengtu.com)（[GitHub](https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack)）。本仓库不包含任何图片文件，只按原站公开的直链规则引用，版权说明见[工具文档](docs/tools.md#表情包出处与版权)。

## 许可证

代码采用 [MIT](LICENSE) 许可证。MIT 只适用于代码，不适用于引用的表情包。
