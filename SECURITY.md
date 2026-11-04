# 安全策略

## 报告漏洞

如果你发现了安全问题，请**不要公开提 Issue**。通过 GitHub 的 [Private vulnerability reporting](https://github.com/zhanxin-xu/channel-agent-gateway/security/advisories/new) 私下提交，并说明：

- 问题类型和影响范围；
- 复现步骤或概念验证；
- 你认为可行的修复方式（可选）。

我们会尽快确认，修复后在发布说明中致谢（如果你愿意）。

## 支持的版本

只维护 `main` 分支的最新代码。

## 部署时需要注意的风险

这个项目会把一个能调用工具的 AI 放进公开的群聊里。部署前请了解下面这些风险：

- **凭据只放在环境变量里**。AppSecret、Bot Token、API Key 都不要写进代码或提交到仓库。泄露后请立即在对应平台重置。
- **沙盒可以执行任意命令**。启用沙盒工作区后，群里任何人都能让机器人在 Vercel Sandbox 里执行命令，沙盒默认可以访问外网。沙盒里不注入任何密钥，消耗受 Vercel 免费额度的硬上限保护，但它仍可能被滥用（比如用来访问第三方网站）。不需要时请设置 `SANDBOX_ENABLED=0`。
- **账户信息工具**。`get_search_balance` 和 `get_llm_key_limit` 会把余额、额度告诉任何提问的人，介意的话请在 `src/agent/tools.ts` 里移除。
- **记忆是共享的**。长期记忆在所有聊天之间共享。系统提示词要求模型不要在群里透露私聊里记下的内容，但这只是提示，不是访问控制。不要让机器人记住真正敏感的信息。
- **提示词注入**。网页、文件、聊天消息里都可能藏着想操纵模型的指令。工具结果会原样交给模型，请把机器人能执行的操作控制在你能接受的范围内。
- **Webhook 鉴权**。QQ 使用 Ed25519 签名，Telegram 使用 Secret Token 请求头，HTTP 渠道使用 Bearer Token。请为 `TELEGRAM_WEBHOOK_SECRET` 和 `HTTP_CHANNEL_TOKEN` 使用足够长的随机字符串。
