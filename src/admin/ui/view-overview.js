// The overview: spend against the provider's limits, today's usage across chats, recent problems.
import { api } from "./api.js";
import { every, fill, fmtAgo, fmtInt, fmtTokens, fmtUsd, h, meter, pill } from "./dom.js";

const REASONS = { error: "出错", unreachable: "平台连不上", "max-steps": "步数用完" };

/** One OpenRouter key: spend today against its daily (or overall) limit. */
function keyTile(title, report) {
  if (!report) return h("div", { class: "tile" }, h("span", { class: "k" }, title), h("span", { class: "v muted" }, "未配置"));
  if (report === "same") return null;
  if (report.error) return h("div", { class: "tile" }, h("span", { class: "k" }, title), pill("bad", "查询失败"), h("span", { class: "s" }, report.error));
  const today = (Number(report.usage?.today) || 0) + (Number(report.byok_usage?.today) || 0);
  const budget = report.effective_budget;
  const limit = budget?.limit ?? (typeof report.limit === "number" ? report.limit : null);
  const spent = budget?.spent ?? today;
  return h(
    "div",
    { class: "tile" },
    h("span", { class: "k" }, `${title} · 今日`),
    h("span", { class: "v" }, fmtUsd(today)),
    limit ? meter(spent / limit) : null,
    h("span", { class: "s" }, limit ? `限额 ${fmtUsd(limit)}${budget?.reset_interval ? `（${budget.reset_interval}）` : ""} · 已用 ${fmtUsd(spent)}` : "不限额"),
  );
}

function searchTile(search) {
  if (!search) return null;
  if (search.error) return h("div", { class: "tile" }, h("span", { class: "k" }, "DeepSeek 余额"), pill("bad", "查询失败"), h("span", { class: "s" }, search.error));
  const cny = search.balances?.find((b) => b.currency === "CNY") ?? search.balances?.[0];
  return h(
    "div",
    { class: "tile" },
    h("span", { class: "k" }, "DeepSeek 余额"),
    h("span", { class: "v" }, cny ? `${cny.currency === "CNY" ? "¥" : ""}${cny.total}` : "—"),
    h("span", { class: "s" }, cny?.approx_search_calls_left !== undefined ? `约 ${fmtInt(cny.approx_search_calls_left)} 次搜索` : ""),
  );
}

export async function renderOverview(main) {
  const body = h("div", { class: "stack" });
  fill(main, h("header", { class: "page-head" }, h("h1", null, "总览"), h("p", { class: "muted" }, "花费、额度和最近出的问题。每天北京时间 08:00 重置。")), body);

  const render = async () => {
    const o = await api.get("overview");
    const t = o.today.total;
    fill(
      body,
      h(
        "div",
        { class: "tiles" },
        keyTile("模型", o.keys.model),
        keyTile("画图", o.keys.image),
        searchTile(o.search),
        h(
          "div",
          { class: "tile" },
          h("span", { class: "k" }, "今日轮次"),
          h("span", { class: "v" }, fmtInt(t.turns)),
          h("span", { class: "s" }, `${o.today.chats} 个聊天 · 估算 ${fmtUsd(t.cost_usd)} · 输入 ${fmtTokens(t.input_tokens)}（缓存 ${fmtTokens(t.cached_tokens)}）`),
        ),
        h(
          "div",
          { class: "tile" },
          h("span", { class: "k" }, "今日工具"),
          h("span", { class: "v" }, `${fmtInt(t.images)} 图`),
          h("span", { class: "s" }, `语音 ${fmtInt(t.voices)} 条 · 搜索 ${fmtInt(t.searches)} 次`),
        ),
      ),
      h("div", { class: "row" }, o.channels.map((c) => pill(c.configured ? "ok" : "mute", `${c.name} ${c.configured ? "已接入" : "未配置"}`))),
      h("h2", null, "最近 24 小时的问题"),
      o.problems.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              null,
              h("thead", null, h("tr", null, h("th", null, "时间"), h("th", null, "聊天"), h("th", null, "情况"))),
              h(
                "tbody",
                null,
                o.problems.map((p) =>
                  h(
                    "tr",
                    null,
                    h("td", { class: "nowrap" }, fmtAgo(p.time)),
                    h("td", null, h("a", { href: `#/chat/${encodeURIComponent(p.chat)}/events` }, p.chat)),
                    h("td", null, pill(p.reason === "error" ? "bad" : "warn", REASONS[p.reason] ?? p.reason), ` 第 ${p.turn} 轮 `, h("span", { class: "muted" }, p.error ?? "")),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted" }, "没有。"),
    );
  };
  await render();
  return every(30_000, render);
}
