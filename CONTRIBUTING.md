# 贡献指南

感谢你愿意参与改进 channel-agent-gateway！

## 提 Issue

- **Bug**：说明你用的渠道、复现步骤、期望结果和实际结果。Vercel 日志里 `[webhook]`、`[handle]`、`[agent]` 开头的几行最有帮助，贴出来之前请去掉 Token、AppSecret 等敏感信息。
- **功能建议**：说明使用场景，以及现有功能为什么满足不了。
- **安全问题**：不要公开提 Issue，请按[安全策略](SECURITY.md)私下报告。

## 开发环境

需要 Node.js 24。

```bash
npm install
cp .env.example .env.local   # 只填你要调试的部分
npm run dev                  # 本地服务：http://localhost:3000/api/webhook/{qq,telegram,http}
```

不需要任何真实凭据也能跑测试：

```bash
npm test            # 离线端到端测试，所有外部接口都已经 mock
npm run typecheck
```

`npm test` 会替换掉全局的 `fetch`，模拟模型、QQ、Telegram、DeepSeek、Supabase、Upstash 等所有外部服务，然后走一遍真实的 Webhook 处理和 agent loop。沙盒相关的测试使用内存里的假工作区；要在真实的 Vercel Sandbox 上验证，见[工具文档](docs/tools.md#沙盒工作区)。

## 提交代码

1. Fork 仓库并新建分支。
2. 修改代码，**同时在 `scripts/selftest.ts` 里补上或更新测试**。
3. 确认 `npm run typecheck` 和 `npm test` 都通过。CI 会在每个 Pull Request 上自动运行这两项。
4. 改了行为或配置的话，同步更新 `docs/`、`README.md` 和 `.env.example`。
5. 提交 Pull Request，说明改了什么、为什么改。

## 代码约定

- **和周围的代码保持一致**：命名、注释密度、写法都参照同一文件里已有的代码。
- **外部接口直接用 `fetch`**：模型、QQ、Telegram、Supabase、Upstash 都是直接调用 HTTP 接口，不引入 SDK，方便透传参数，也让测试能统一 mock。Vercel Sandbox 是例外，它需要 SDK 处理认证。
- **配置只从环境变量读**：新增配置加在 `src/config.ts` 里，使用 getter 实时读取，并写进 `docs/configuration.md` 和 `.env.example`。
- **注释解释"为什么"**：平台限制、踩过的坑、看起来奇怪但必须这样写的地方，都值得写一句注释。
- **不要提交密钥**：`.env*` 已经在 `.gitignore` 里。仓库是公开的，提交前请检查一遍 diff。

## 常见改动

- **改人设**：编辑 `src/agent/system-prompt.ts`。
- **新增工具**：见[工具文档](docs/tools.md#新增工具)。
- **新增渠道**：见[渠道接入](docs/channels.md#新增渠道)。

## 许可证

提交的代码将以 [MIT 许可证](LICENSE) 发布。
