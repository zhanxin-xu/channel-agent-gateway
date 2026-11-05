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
| `get_llm_key_limit` | 查询模型 Key 和画图 Key 的额度和用量（OpenRouter 专用） | 配置了 `OPENAI_RESPONSES_API_KEY` 或 `IMAGE_API_KEY` |
| `generate_image` | 画图、按参考图改图 | 配置了 `IMAGE_API_KEY`，且沙盒可用 |
| `send_voice` | 用大肥鱼的声音发一条语音 | 配置了 `TTS_API_KEY` |
| `remember` / `recall` / `forget` | 长期记忆 | 配置了 Upstash Vector |
| `bash` / `read_file` / `write_file` / `send_file` / `save_attachment` | 沙盒工作区 | 部署在 Vercel 上，或本地有 `VERCEL_OIDC_TOKEN` |

`send_message`、`end_turn` 的行为见 [Agent 与对话](agent.md#说话与挂断)。

## 联网

`web_search` 和 `web_fetch` 调用 DeepSeek 的工具接口（`POST /v1/tools/search`、`POST /v1/tools/fetch`），和使用哪个模型无关。搜索支持 `site:`、`lang:`、`after:` 等语法；抓取以 Markdown 返回网页正文，超过 12k 字符会截断。DeepSeek 按每 1000 次成功请求 5 元计费。

## 余额与额度

- `get_search_balance`：调用 DeepSeek 的 `GET /user/balance`，区分赠送余额和充值余额，并估算还能搜索多少次。
- `get_llm_key_limit`：调用 `GET {OPENAI_RESPONSES_BASE_URL}/key`，返回限额、剩余额度、重置周期，以及今日、本周、本月和累计用量。这是 OpenRouter 特有的接口，换成其他服务商时这个工具会返回错误，可以在 `registry.ts` 里移除。
  - 两个 Key 分开列：`model_key` 是聊天模型的 Key，`image_key` 是画图（`generate_image`）的 Key，会再查一次 `GET {IMAGE_BASE_URL}/key`。两个配的是同一个 Key 时，`image_key` 会注明"和 model_key 是同一个"，避免重复计算。其中一个查询失败时，只在它那一项里写错误，另一项照常返回。
  - 用量分两笔：`usage` 是从 OpenRouter 余额里扣的钱，`byok_usage` 是走你自己服务商 Key（BYOK）的花费。预算或 Key 限额设成"包含 BYOK"时会把两笔加在一起，所以可能出现 `usage` 为 0、预算却已经花了一部分的情况，工具结果里的 `counts_byok` 字段会标出来。
  - "今天"按 UTC 计算，北京时间每天早上 8 点重置；每周从周一开始。

这两个工具返回的是账户信息，机器人进群后任何人都能问到。介意的话，在 `registry.ts` 里把它们移除。

## 长期记忆

实现见 [`src/tools/memory.ts`](../src/tools/memory.ts)，开通方法见[部署文档](deployment.md#upstash-vector长期记忆可选)。

- **所有聊天共用一个记忆库**。每条记忆是一句能独立看懂的话，比如"#3B6834 叫老王，是前端程序员"，由模型自己判断什么值得记。
- `remember` 写入一条记忆；`recall` 按语义相似度返回最接近的几条；`forget` 按 ID 删除。
- **记录来源**：每条记忆都附带来源聊天、私聊还是群聊、谁说的、什么时候记的。`recall` 的结果会标出是否来自当前聊天，系统提示词要求模型不要把私聊里记下的事在群里说出来。
- **不用自己接 embedding**：索引使用 Upstash 托管的 embedding 模型，服务直接发送原文（`/upsert-data`、`/query-data`）。
- `/reset` 只清空聊天历史，不会清空记忆。

## 画图

`generate_image` 调用 OpenRouter 的 Image API（`POST /images`），默认模型 `openai/gpt-image-2.6-sunburst`，配置见[配置参考](configuration.md#画图)。实现见 [`src/tools/image.ts`](../src/tools/image.ts)。

| 参数 | 说明 |
|---|---|
| `prompt` | 要画什么，或者要怎么改参考图 |
| `input_references` | 参考图，最多 16 张。填**工作区里的路径**（相对路径在 `/workspace` 下，比如 `inbox/632-photo.jpg`），工具读出文件转成 data URL 再发给接口；也可以直接填 https 链接 |
| `aspect_ratio` | `auto`、`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`21:9` |
| `background` | `auto`、`transparent`、`opaque` |
| `n` | 生成几张，1–10，默认 1 |

`quality`（默认 `low`）和 `resolution`（默认 `1K`）只能在环境变量里设，模型不能改。

- **结果**：存到 `/workspace/images/{时间}-{序号}.png`。超过 1920×1080（横竖都算）的会先缩小再保存。同时把一张 1024px 的预览给模型看，确认没问题后再用 `send_file` 发到聊天。
- **修别人发的照片**：先用 `save_attachment` 把原图存进 `/workspace/inbox/`，再把这个路径填进 `input_references`。
- **费用**：每次调用都按图收费，工具结果里会带上接口返回的 `cost`。和余额工具一样，群里任何人都能让机器人画图，介意的话不要配置 `IMAGE_API_KEY`。

## 语音

`send_voice` 把一段文字说出来或唱出来，当场作为一条语音消息发出去（和 `send_message` 一样算一次回复）。通过 OpenRouter 的语音接口（`POST /audio/speech`）调用，模型由 `TTS_MODEL` 决定（默认 Fish Audio Drama 3，也可以配成字节 Seed Audio 1.0），模型自己不能选，配置见[配置参考](configuration.md#语音)。实现见 [`src/tools/voice.ts`](../src/tools/voice.ts)。不依赖沙盒。

| 参数 | 说明 |
|---|---|
| `text` | 要说或唱的内容，最多 500 字，按所选模型的写法（Fish 可以夹带下面的语气指令） |
| `instructions` | 可选，整条语音的语气，例如 `像在讲睡前故事`；唱歌时是风格（`温柔的摇篮曲`）；音色选 `none` 时用来描述角色的声音。会接在 `TTS_INSTRUCTIONS` 后面一起发给接口（`none` 时不带 `TTS_INSTRUCTIONS`） |
| `mode` | `speak`（默认）或 `sing`：把 `text` 当歌词唱 |
| `voice` | `dafeiyu`（默认，克隆大肥鱼）、`dafeiyu_sing`（配置了唱歌参考音频才有）、`none`（不克隆，演别的角色） |
| `speed` | 可选，0.5–2，Fish 认，Seed 忽略（不会发给它） |
| `reply_to` | 回复哪条消息，同 `send_message` |

工具描述是按配置现拼的：只教当前配置的那个语音模型的写法（`text` 和 `instructions` 怎么写、唱歌怎么写），只列出可用的音色。效果不好时（群友说不像、像念的），描述让模型换音色或写法再试，而不是原样重发；好用的组合可以用 `remember` 记下来。工具结果会写明这次用了什么，例如 `voice message: sung, model=…, voice=dafeiyu, 9.4s`，日志里能看出用的哪个模型。

两个模型的区别（在 `TTS_MODEL` 里选）：

| 模型 | 特点 | 价格（实测） |
|---|---|---|
| `fish-audio/drama-3` | 音色还原最好，行内语气指令最丰富，认 `speed`。唱歌更像有起伏的朗诵 | 一句约 $0.0001 |
| `bytedance-seed/seed-audio-1-0` | 演绎更自由，适合唱歌和 Fish 演不出来的效果。只认 `instructions` 里的描述，`text` 不要夹方括号或标签。返回 24 kHz 双声道 PCM，网关混成单声道 | 约 $0.0013/秒，10 秒约 1.3 美分 |

- **唱歌**（`mode: "sing"`）：两个模型都没有专门的唱歌模式，工具按模型套上唱歌提示：Fish 在歌词前加 `[唱歌]`、末尾加 `♪`；两者都在 `instructions` 里加"按旋律唱、长音拖住、不要念白"，再加风格（不给就用默认的儿歌风）。效果是清唱，旋律由模型自己编，没有伴奏，适合唱几句。描述让模型只唱原创或对方写的词。

- **固定音色**：每次请求都带上仓库里的参考音频 [`assets/voice/dafeiyu.mp3`](../assets/voice/dafeiyu.mp3)（约 10 秒，32 kbps）和它的文字稿，通过接口的 `input_references` 克隆这个声音，所以每条语音都是同一个声音，不需要在 Fish 那边建音色。参考音频要尽量小：同一段声音用 170 KB 的原文件时每次约 $0.002，压到 43 KB 后和不带参考一样（约 $0.00006 一条短句）。
- **各渠道怎么发**：接口返回 PCM（采样率和声道数从响应头读取，Drama 3 是 44.1 kHz 单声道，Seed 是 24 kHz 双声道，多声道会先混成单声道）。QQ 在函数里用 [silk-wasm](https://github.com/idranme/silk-wasm) 编成 SILK，以 `file_type: 3` 上传，收到的是能直接点开播放的语音条；Telegram 收到一个 `voice.wav` 文件；HTTP 等同步渠道收到 `[语音] 文字`。
- **语气写法**（Drama 3 的语法，工具描述里也教了模型）：
  - `[方括号]` 写在要说的话前面，用大白话描述语气，中英文都行：`[得意地] 本鱼早就算到了！`、`[小声嘀咕] 才不是因为想你呢。`，一直生效到下一个指令。
  - `[方括号]` 写在发出声音或停顿的位置：`好吧 [叹气] 我输了。`、`[轻笑]`、`[短暂停顿]`。
  - 成对标签只改包住的几个字：`<whisper>`、`<emphasis>`、`<soft>`、`<fast>`、`<slow>`、`<stress>`、`<forceful>`。
  - 中途换语言：`<english>…</english>`、`<japanese>…</japanese>` 等（实验性）。
  - 多音字、人名注音：每个字一组 `<|phoneme_start|>chong2<|phoneme_end|>`，拼音后面带声调数字。
  - 方括号里的内容不会被念出来；每句最多三个左右，用多了反而不自然。详见 [Fish Audio 的 Drama 3 文档](https://docs.fish.audio/features/text-to-speech/drama-3)。
- **费用**：按输入文字的字节数计费，OpenRouter 上 Drama 3 是 $2 / 百万 UTF-8 字节，一条短语音不到 0.01 美分。群里任何人都能让机器人发语音，介意的话不要配置 `TTS_API_KEY`。

## 沙盒工作区

实现见 [`src/tools/sandbox/`](../src/tools/sandbox/)：`workspace.ts` 是工作区接口和生命周期（每次运行一个），`vercel.ts` 是 Vercel Sandbox 的实现，`tools.ts` 是五个工具。

| 工具 | 作用 |
|---|---|
| `bash` | 在工作目录 `/workspace` 执行命令，返回 stdout 和 stderr，过长时保留开头和结尾 |
| `write_file` | 写入文本文件，自动创建上级目录 |
| `read_file` | 读取文件；读到 png/jpg/gif/webp 时，会把图片直接给模型看 |
| `send_file` | 把工作区里的文件发到聊天，最大 5 MB，和 `send_message` 一样可以用 `reply_to`，计入那条消息的 5 次回复 |
| `save_attachment` | 把某条消息里别人发来的图片或文件的**原件**存进 `/workspace/inbox/`，文件名是 `{消息编号}-{原文件名}`。参数是消息编号（第N条的 N），可选 `index` 只存第几个附件，默认全部 |

- **用到才创建**：一轮回复里第一次调用工作区工具时才创建沙盒，这一轮的所有调用共用它，结束后立即停止。只聊天不用工具的轮次不会创建沙盒。
- **每个聊天一块盘**：每个群、每个私聊都有自己的一块 Vercel Drive（Hobby 默认 1 GiB），每次都挂到 `/workspace`，盘名由聊天 ID 哈希得到。同一个群的人共用一个工作目录。
- **什么会留下**：`/workspace` 里的文件会一直保留，`/tmp` 等其他位置每轮都会清空。沙盒设置为不做快照，只占用盘的存储。
- **依赖也装在盘上**：沙盒启动时设置了 `PYTHONUSERBASE`、`PIP_USER`、`NPM_CONFIG_PREFIX`，`pip install` 装到 `/workspace/.local`，`npm install -g` 装到 `/workspace/.npm-global`，可执行文件自动加入 `PATH`。每个聊天各自维护自己的依赖，装过一次下一轮就能直接用。
- **限时**：单条命令默认最多 60 秒，超时会被杀掉，已有输出保留。临近函数时限时，限时会自动缩短，剩余时间不够就直接报错，让模型先汇报现有结果。
- **并发**：同一块盘同一时间只能被一个沙盒读写。同一个聊天的两轮回复撞到一起时，后来的会重试几次，还不行就由模型告诉用户稍后再试。
- **读图片**：图片缩到最长边 1024px 存进数据库，作为一条用户消息附在工具结果后面交给模型（`detail: "auto"`），之后的请求也会重放。
- **收到的附件**：聊天里看到的图片只是 512px 的预览，原图和文件都要先用 `save_attachment` 存进工作区才能处理，比如修图后用 `send_file` 发回去。下载在沙盒里用 `curl` 直接写盘，不经过函数内存，所以不限大小；沙盒连不上平台的 CDN 时，改由函数下载后写进去。平台的附件链接会过期，目前只有 QQ 渠道会记录附件链接。

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
- `ctx` 里有当前聊天的信息（`ctx.chat`）和函数的截止时间（`ctx.deadline`）。耗时较长的工具请参考 `bash`，根据 `ctx.deadline` 给自己设上限。
- 往聊天里发东西用 `ctx.send(...)`：文字 `{ kind: "text", text }`、按 URL 发图片 `{ kind: "image", url, label }`、文件 `{ kind: "file", file }`。具体怎么发由渠道决定，发不了图片的渠道会退化成文字。发消息的工具要声明 `role: "talk"`，循环才知道它失败时不该挂断（见 [Agent 文档](agent.md#说话与挂断)）。
- 工具占用了要释放的资源（比如沙盒），用 `ctx.onRunEnd(fn)` 注册清理函数，运行结束时统一执行。
- 别忘了在 `scripts/selftest.ts` 里补一个测试。
