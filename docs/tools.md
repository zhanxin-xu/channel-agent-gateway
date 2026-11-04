# 工具

工具在 [`src/tools/`](../src/tools/) 里，每个模块一类工具，在 [`registry.ts`](../src/tools/registry.ts) 注册。依赖外部服务的工具只在对应的服务配置好后才启用，`/api/health` 的 `tools` 字段会列出当前启用的工具。

| 工具 | 作用 | 启用条件 |
|---|---|---|
| `send_message` | 发一条消息 | 始终启用 |
| `send_sticker` | 发一张表情包 | 始终启用 |
| `end_turn` | 挂断，结束这一轮 | 始终启用 |
| `get_current_time` | 查询当前时间（可指定时区） | 始终启用 |
| `calculate` | 四则运算、取模、乘方 | 始终启用 |
| `web_search` / `web_fetch` | 联网搜索、抓取网页正文 | 配置了 `DEEPSEEK_API_KEY` |
| `get_search_balance` | 查询 DeepSeek 余额 | 配置了 `DEEPSEEK_API_KEY` |
| `get_llm_key_limit` | 查询模型 Key 的额度和用量 | 配置了 `OPENROUTER_API_KEY` |
| `remember` / `recall` / `forget` | 长期记忆 | 配置了 Upstash Vector |
| `bash` / `read_file` / `write_file` / `send_file` | 沙盒工作区 | 部署在 Vercel 上，或本地有 `VERCEL_OIDC_TOKEN` |

`send_message`、`end_turn` 的行为见 [Agent 与对话](agent.md#说话与挂断)。

## 联网

`web_search` 和 `web_fetch` 调用 DeepSeek 的工具接口（`POST /v1/tools/search`、`POST /v1/tools/fetch`），和使用哪个模型无关。搜索支持 `site:`、`lang:`、`after:` 等语法；抓取以 Markdown 返回网页正文，超过 12k 字符会截断。DeepSeek 按每 1000 次成功请求 5 元计费。

## 余额与额度

- `get_search_balance`：调用 DeepSeek 的 `GET /user/balance`，区分赠送余额和充值余额，并估算还能搜索多少次。
- `get_llm_key_limit`：调用 `GET {OPENROUTER_BASE_URL}/key`，返回限额、剩余额度、重置周期，以及今日、本周、本月和累计用量。

这两个工具返回的是账户信息，机器人进群后任何人都能问到。介意的话，在 `registry.ts` 里把它们移除。

## 长期记忆

实现见 [`src/tools/memory.ts`](../src/tools/memory.ts)，开通方法见[部署文档](deployment.md#upstash-vector长期记忆可选)。

- **所有聊天共用一个记忆库**。每条记忆是一句能独立看懂的话，比如"#3B6834 叫老王，是前端程序员"，由模型自己判断什么值得记。
- `remember` 写入一条记忆；`recall` 按语义相似度返回最接近的几条；`forget` 按 ID 删除。
- **记录来源**：每条记忆都附带来源聊天、私聊还是群聊、谁说的、什么时候记的。`recall` 的结果会标出是否来自当前聊天，系统提示词要求模型不要把私聊里记下的事在群里说出来。
- **不用自己接 embedding**：索引使用 Upstash 托管的 embedding 模型，服务直接发送原文（`/upsert-data`、`/query-data`）。
- `/reset` 只清空聊天历史，不会清空记忆。

## 沙盒工作区

实现见 [`src/tools/sandbox/`](../src/tools/sandbox/)：`workspace.ts` 是工作区接口和生命周期（每次运行一个），`vercel.ts` 是 Vercel Sandbox 的实现，`tools.ts` 是四个工具。

| 工具 | 作用 |
|---|---|
| `bash` | 在工作目录 `/workspace` 执行命令，返回 stdout 和 stderr，过长时保留开头和结尾 |
| `write_file` | 写入文本文件，自动创建上级目录 |
| `read_file` | 读取文件；读到 png/jpg/gif/webp 时，会把图片直接给模型看 |
| `send_file` | 把工作区里的文件发到聊天，最大 5 MB，和 `send_message` 一样可以用 `reply_to`，计入那条消息的 5 次回复 |

- **用到才创建**：一轮回复里第一次调用工作区工具时才创建沙盒，这一轮的所有调用共用它，结束后立即停止。只聊天不用工具的轮次不会创建沙盒。
- **每个聊天一块盘**：每个群、每个私聊都有自己的一块 Vercel Drive（Hobby 默认 1 GiB），每次都挂到 `/workspace`，盘名由聊天 ID 哈希得到。同一个群的人共用一个工作目录。
- **什么会留下**：`/workspace` 里的文件会一直保留，`/tmp` 等其他位置每轮都会清空。沙盒设置为不做快照，只占用盘的存储。
- **依赖也装在盘上**：沙盒启动时设置了 `PYTHONUSERBASE`、`PIP_USER`、`NPM_CONFIG_PREFIX`，`pip install` 装到 `/workspace/.local`，`npm install -g` 装到 `/workspace/.npm-global`，可执行文件自动加入 `PATH`。每个聊天各自维护自己的依赖，装过一次下一轮就能直接用。
- **限时**：单条命令默认最多 60 秒，超时会被杀掉，已有输出保留。临近函数时限时，限时会自动缩短，剩余时间不够就直接报错，让模型先汇报现有结果。
- **并发**：同一块盘同一时间只能被一个沙盒读写。同一个聊天的两轮回复撞到一起时，后来的会重试几次，还不行就由模型告诉用户稍后再试。
- **读图片**：图片缩到最长边 1024px 存进数据库，作为一条用户消息附在工具结果后面交给模型（`detail: "auto"`），之后的请求也会重放。

> **注意**：群里任何人都能让机器人执行命令，沙盒默认可以访问外网。沙盒里不放任何密钥，系统提示词也要求拒绝攻击、挖矿之类的请求。如果需要更严格的控制，可以只对指定用户开放这组工具。

本地调试可以用 `scripts/sandbox-smoke.ts` 在真实的 Vercel Sandbox 上跑一遍：

```bash
npx vercel env pull              # 把 VERCEL_OIDC_TOKEN 写进 .env.local（会覆盖原文件）
npx tsx scripts/sandbox-smoke.ts
```

它会创建一块临时盘、跑几条命令、读写文件，最后把盘删掉。

## 表情包

`send_sticker` 的 `name` 是一个枚举，可选的表情和各自的使用场景定义在 [`src/tools/stickers.ts`](../src/tools/stickers.ts)：

- **情绪类**：28 张 Q 版动态 GIF，比如笑死、红温了、已老实、你礼貌吗、退退退、吃瓜、贴贴、晚安。
- **梗图类**：10 张经典梗图，比如得加钱、摆烂、蹭饭、用户别走、无可奉告。

图片统一使用最长边 512px 的版本，两类表情包在聊天里显示的大小一致。想自托管，把图片按相同路径（`meme/NNN.gif`、`0_preview/meme/NNN.webp`）放到你自己的地址下，再设置 `STICKER_BASE_URL`。新增表情包：在 `stickers.ts` 里加一条记录（名字、站点编号、使用场景）。

各渠道的发送方式见[渠道接入](channels.md)。

### 表情包出处与版权

> 本项目使用的「蓝色大肥鱼 / DeepSeek 娘」表情包来自社区整理的
> **[梗鲸 GengJing · 蓝色大肥鱼表情包档案馆](https://aigengtu.com)**
> （GitHub：[the-beating-light-of-the-nail/deepseek-chan-meme-pack](https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack)）。
>
> - 角色形象与原始画作的版权归原作者及社区创作者所有。本仓库**不包含任何图片文件**，只按原站公开的直链规则引用，原站 README 明确欢迎开发者这样热链。
> - 原站说明：非营利的粉丝向玩梗可以随意使用，**商用请先联系原作者**。
> - 如果你是某张图片的权利人，请通过[原仓库的侵权举报入口](https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack/issues/new?template=takedown-report.yml)联系，或在本仓库提 Issue，我们会移除对应条目。
> - 本仓库的 MIT 许可证只适用于代码，不适用于这些表情包。

## 新增工具

在 `src/tools/` 下新建一个模块，导出一个 `Tool`，再加进 [`registry.ts`](../src/tools/registry.ts) 的 `tools` 数组：

```ts
import type { Tool } from "./types.js";

export const myTool: Tool = {
  name: "my_tool",
  description: "告诉模型这个工具做什么、什么时候用",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  enabled: () => Boolean(config.someService.apiKey), // 可选：依赖的服务没配置时隐藏
  async run(args, ctx) {
    return "工具结果（字符串）";
  },
};
```

- `run` 抛出的错误会以 `Error: …` 的形式交给模型，不会中断这一轮。
- `ctx` 里有当前聊天的信息（`ctx.chat`）、函数的截止时间（`ctx.deadline`），以及发消息、发表情包、发文件的方法。耗时较长的工具请参考 `bash`，根据 `ctx.deadline` 给自己设上限。
- 别忘了在 `scripts/selftest.ts` 里补一个测试。
