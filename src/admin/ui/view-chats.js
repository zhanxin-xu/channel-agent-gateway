// Every chat the bot has seen, most recently active first.
import { api } from "./api.js";
import { every, fill, fmtAgo, fmtInt, fmtUsd, h, meter, pill } from "./dom.js";
import { chatKind, chatName, modePill, speakersText } from "./labels.js";

function quotaCell(c) {
  const limit = c.profile?.quota?.cost_usd;
  const spent = c.usage?.cost_usd ?? 0;
  if (limit === undefined) return h("span", { class: "muted" }, spent ? fmtUsd(spent) : "不限");
  return h("div", { class: "quota-cell" }, meter(limit ? spent / limit : 1), h("span", { class: "muted" }, spent >= limit ? "用完了" : `${fmtUsd(spent)} / ${fmtUsd(limit)}`));
}

export async function renderChats(main) {
  let chats = [];
  let kind = "all";
  let search = "";
  const tbody = h("tbody");
  const count = h("span", { class: "muted" });

  const draw = () => {
    const shown = chats.filter(
      (c) => (kind === "all" || c.chatType === kind) && (!search || `${c.profile?.title ?? ""} ${c.chat} ${(c.speakers ?? []).join(" ")}`.toLowerCase().includes(search)),
    );
    count.textContent = `${shown.length} 个`;
    fill(
      tbody,
      shown.length
        ? shown.map((c) =>
            h(
              "tr",
              { class: "clickable", onClick: () => (location.hash = `#/chat/${encodeURIComponent(c.chat)}/history`) },
              h(
                "td",
                null,
                h("a", { href: `#/chat/${encodeURIComponent(c.chat)}/history` }, h("b", null, chatName(c))),
                c.chatType === "group" && speakersText(c) ? h("div", { class: "small" }, `最近：${speakersText(c)}`) : null,
                h("div", { class: "muted mono small" }, c.chat),
              ),
              h("td", { class: "nowrap" }, chatKind(c)),
              h("td", null, modePill(c), c.locked ? [" ", pill("info", "运行中")] : null),
              h("td", { class: "num" }, fmtInt(c.usage?.turns)),
              h("td", null, quotaCell(c)),
              h("td", { class: "nowrap" }, fmtAgo(c.lastActiveAt)),
            ),
          )
        : h("tr", null, h("td", { colspan: 6, class: "muted" }, chats.length ? "没有符合条件的聊天" : "还没有聊天。给机器人发条消息试试。")),
    );
  };

  const seg = h(
    "span",
    { class: "seg", role: "group" },
    [["all", "全部"], ["group", "群聊"], ["private", "私聊"]].map(([value, label]) =>
      h("button", {
        type: "button",
        class: value === kind ? "on" : "",
        onClick(e) {
          kind = value;
          for (const b of seg.children) b.classList.toggle("on", b === e.currentTarget);
          draw();
        },
      }, label),
    ),
  );
  const filter = h("input", { id: "chat-search", type: "search", placeholder: "搜索备注名、群友或 ID", onInput: (e) => ((search = e.target.value.trim().toLowerCase()), draw()) });

  fill(
    main,
    h("header", { class: "page-head" }, h("h1", null, "聊天"), h("p", { class: "muted" }, "QQ 不提供群名和私聊昵称：群下面列出最近说话的人，也可以在聊天的“设置与额度”里填备注名。")),
    h("div", { class: "row between" }, h("div", { class: "row" }, seg, filter), count),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        null,
        h("thead", null, h("tr", null, h("th", null, "聊天"), h("th", null, "渠道"), h("th", null, "回复方式"), h("th", { class: "num" }, "今日轮次"), h("th", null, "今日花费"), h("th", null, "最后活跃"))),
        tbody,
      ),
    ),
  );
  const load = async () => {
    chats = await api.get("chats");
    draw();
  };
  await load();
  return every(15_000, load);
}
