// What admins changed or sent, newest first.
import { api } from "./api.js";
import { fill, fmtTime, h } from "./dom.js";

const ACTIONS = {
  settings: "改了设置",
  "import-env": "导入环境变量",
  rekey: "重新加密密钥",
  schema: "执行 schema.sql",
  profile: "改了聊天设置",
  say: "代发消息",
  whisper: "悄悄话",
  reset: "重置上下文",
  unlock: "释放锁",
};

function detail(entry) {
  const d = entry.detail ?? {};
  if (Array.isArray(d.keys)) return d.keys.join("、");
  if (typeof d.text === "string") return d.text;
  if (d.profile) return JSON.stringify(d.profile);
  if (d.version) return `v${d.version}`;
  return "";
}

export async function renderLog(main) {
  const entries = await api.get("admin-log");
  fill(
    main,
    h("header", { class: "page-head" }, h("h1", null, "操作记录"), h("p", { class: "muted" }, "最近 100 条，保留 180 天。密钥只记名字。")),
    entries.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            null,
            h("thead", null, h("tr", null, h("th", null, "时间"), h("th", null, "操作"), h("th", null, "聊天"), h("th", null, "内容"))),
            h(
              "tbody",
              null,
              entries.map((e) =>
                h(
                  "tr",
                  null,
                  h("td", { class: "nowrap" }, fmtTime(e.time)),
                  h("td", { class: "nowrap" }, ACTIONS[e.action] ?? e.action),
                  h("td", null, e.chat ? h("a", { href: `#/chat/${encodeURIComponent(e.chat)}/history` }, e.chat) : ""),
                  h("td", { class: "wrap" }, detail(e)),
                ),
              ),
            ),
          ),
        )
      : h("p", { class: "muted" }, "还没有操作。"),
  );
}
