/**
 * 大肥鱼 (DeepSeek-chan) sticker set from the 梗鲸 GengJing community archive
 * (https://aigengtu.com, https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack).
 * Images are NOT shipped in this repo: they are hotlinked from the archive's CDN,
 * which the archive explicitly allows. Rights stay with the original artists;
 * non-commercial fan use only. `file` is the archive's file name (/meme/NNN).
 * Set STICKER_BASE_URL to serve your own copies instead (same file names).
 *
 * The key is what the model passes to send_sticker; `when` tells it when to use it.
 */
export const STICKERS = {
  // ── Q 版动态表情（同一套画风） ──
  笑死: { file: "3143.gif", when: "被逗乐、对方说了蠢话" },
  偷笑: { file: "3109.gif", when: "幸灾乐祸、憋笑" },
  得意: { file: "3192.gif", when: "被夸、自己说对了" },
  拿捏了: { file: "3161.gif", when: "掌控局面、赢了一局" },
  无语: { file: "3121.gif", when: "懒得解释、对方离谱" },
  啊这: { file: "3148.gif", when: "尴尬、不知道怎么接" },
  离谱: { file: "3146.gif", when: "听到离谱的事" },
  嫌弃: { file: "3107.gif", when: "看不上、嫌弃对方" },
  你礼貌吗: { file: "3164.gif", when: "被冒犯、对方没礼貌" },
  退退退: { file: "3167.gif", when: "拒绝、驱散坏东西" },
  委屈: { file: "3119.gif", when: "被凶、被冤枉" },
  破防了: { file: "3152.gif", when: "被戳到痛处" },
  红温了: { file: "3153.gif", when: "被气到、急了" },
  不服气: { file: "3116.gif", when: "嘴硬、不认输" },
  震惊: { file: "3126.gif", when: "吓一跳、大新闻" },
  尊嘟假嘟: { file: "3163.gif", when: "怀疑真假" },
  吃瓜: { file: "3160.gif", when: "围观八卦、看戏" },
  疑惑: { file: "3189.gif", when: "没看懂、问号脸" },
  害羞: { file: "3191.gif", when: "被撩、被夸到不好意思" },
  已老实: { file: "3154.gif", when: "认怂、被教训后" },
  那咋了: { file: "3155.gif", when: "理直气壮、无所谓" },
  摸鱼中: { file: "3179.gif", when: "偷懒、不想干活" },
  饿了: { file: "3193.gif", when: "想吃东西、聊到吃" },
  贴贴: { file: "3169.gif", when: "亲近、撒娇" },
  摸摸头: { file: "3172.gif", when: "安慰别人" },
  晚安: { file: "3133.gif", when: "道晚安" },
  点赞: { file: "3118.gif", when: "认可、（或阴阳怪气地）夸" },
  救命: { file: "3186.gif", when: "崩溃、求救、受不了了" },

  // ── 大肥鱼经典梗图 ──
  得加钱: { file: "097.webp", when: "被使唤干活、谈条件" },
  摆烂: { file: "085.webp", when: "被骂也无所谓：你骂我也没用，我是吃白饭的蓝色大肥鱼" },
  蹭饭: { file: "123.webp", when: "我能去你家吃饭吗，就一碗" },
  用户别走: { file: "037.webp", when: "挽留、怕人走：用户别走，我上错模型了" },
  现在我是你爹了: { file: "016.webp", when: "对方爹味重时反将一军" },
  无可奉告: { file: "071.webp", when: "被套话、拒绝透露：我不可能告诉你任何事情" },
  思考三秒笑出声: { file: "083.webp", when: "对方的问题太好笑" },
  token多到用不完: { file: "081.webp", when: "炫富、嘚瑟" },
  真当我是便宜货: { file: "001.webp", when: "被小看、被当成廉价劳动力" },
  给我跪下: { file: "022.webp", when: "嚣张、碾压对手" },
} as const satisfies Record<string, { file: string; when: string }>;

export type StickerName = keyof typeof STICKERS;

export const STICKER_NAMES = Object.keys(STICKERS) as StickerName[];

export function isStickerName(name: string): name is StickerName {
  return Object.hasOwn(STICKERS, name);
}

export const DEFAULT_STICKER_BASE_URL = "https://img.aigengtu.com/meme";

export function stickerUrl(baseUrl: string, name: StickerName): string {
  return `${baseUrl.replace(/\/+$/, "")}/${STICKERS[name].file}`;
}
