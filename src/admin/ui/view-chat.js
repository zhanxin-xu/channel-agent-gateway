// One chat (#/chat/<chat>/<tab>): its history with the composer, its event log, and its settings.
import { api, ApiError } from "./api.js";
import { action, confirmAction, every, fill, fmtClock, fmtTime, fmtTokens, fmtUsd, h, pill, toast } from "./dom.js";
import { chatKind, chatName, modePill, speakersText } from "./labels.js";

const BOT = "大肥鱼";
const TABS = [
  ["history", "聊天记录"],
  ["events", "事件"],
  ["settings", "设置与额度"],
];

export async function renderChat(main, [chat, tabId], app) {
  const info = await api.get("chat", { chat });
  const tab = TABS.some(([id]) => id === tabId) ? tabId : "history";
  const body = h("div", { class: "tab-body" });
  fill(
    main,
    h(
      "header",
      { class: "page-head" },
      h("p", null, h("a", { href: "#/chats" }, "← 聊天")),
      h("h1", null, chatName(info), " ", modePill(info), info.locked ? [" ", pill("info", "运行中")] : null),
      info.chatType === "group" && speakersText(info) ? h("p", null, `最近说话的人：${speakersText(info)}`) : null,
      h("p", { class: "muted mono small" }, `${chatKind(info)} · ${chat}${info.turn ? ` · 第 ${info.turn} 轮` : ""}`),
    ),
    h("nav", { class: "tabs" }, TABS.map(([id, label]) => h("a", { href: `#/chat/${encodeURIComponent(chat)}/${id}`, class: id === tab ? "on" : "" }, label))),
    body,
  );
  if (tab === "events") return renderEvents(body, chat, info);
  if (tab === "settings") return renderSettings(body, chat, info, app);
  return renderHistory(body, chat, info);
}

// ── History and the composer ──

function bubble(e) {
  if (e.role === "hint") {
    return h("div", { class: "msg hint" }, h("span", { class: "who" }, `管理员悄悄话 · ${fmtTime(e.time)}`), h("div", { class: "b" }, e.text));
  }
  const mine = e.role === "bot" || e.role === "admin";
  const who = e.role === "admin" ? `${BOT}（管理员代发）` : mine ? BOT : (e.sender ?? "?");
  return h("div", { class: `msg${mine ? " bot" : ""}${e.role === "admin" ? " admin" : ""}` }, h("span", { class: "who" }, `${who} · ${fmtTime(e.time)}`), h("div", { class: "b" }, e.text));
}

function renderHistory(body, chat, info) {
  const entries = new Map();
  const list = h("div", { class: "chat-log", "aria-live": "polite" });
  const more = h("button", { type: "button", class: "btn btn-small" }, "加载更早的");
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;

  const draw = (stick) => {
    const sorted = [...entries.values()].sort((a, b) => a.seq - b.seq);
    fill(list, sorted.length ? sorted.map(bubble) : h("p", { class: "muted" }, "还没有消息。"));
    if (stick) list.scrollTop = list.scrollHeight;
  };
  // The newest event read so far: polling asks only for what's after it.
  let through = -1;
  const add = (page) => {
    for (const e of page.lines) entries.set(e.id, e);
    through = Math.max(through, page.through);
    return page;
  };
  more.addEventListener("click", async () => {
    const oldest = Math.min(...[...entries.values()].map((e) => e.seq));
    const height = list.scrollHeight;
    more.hidden = !add(await api.get("chat/history", { chat, before: oldest, limit: 100 })).more;
    draw(false);
    list.scrollTop = list.scrollHeight - height;
  });

  const composer = renderComposer(chat, info, () => refresh(true));
  fill(body, h("div", { class: "row" }, more), list, composer.el);
  const refresh = async (stick) => {
    const before = entries.size;
    const wasNear = nearBottom();
    add(await api.get("chat/history", { chat, after: through }));
    if (entries.size !== before || stick) draw(stick || wasNear);
  };
  api.get("chat/history", { chat, limit: 100 }).then((page) => {
    more.hidden = !add(page).more;
    draw(true);
  });
  const stops = [every(4000, () => refresh(false)), composer.stop];
  return () => stops.forEach((s) => s());
}

function renderComposer(chat, info, onSent) {
  let mode = "say";
  // A record-only or blocked chat never answers, so there's no one to whisper to.
  const canWhisper = info.mode === "normal" || info.mode === "mention";
  const text = h("textarea", { id: "compose", rows: 3, placeholder: `以${BOT}的身份说点什么…  @#XXXXXX 可以 @ 群友` });
  const windowLine = h("span", { class: "window" });
  let state = info.replyWindow;

  const hint = () =>
    mode === "say"
      ? "原样发出去，记进她的上下文，她会以为是自己说的。"
      : `写给她的指示（群里看不到），比如“提醒大家今晚 8 点开会”，她会用自己的口气说。`;
  const help = h("p", { class: "help" }, hint());
  const seg = h(
    "span",
    { class: "seg", role: "group" },
    [["say", "直接发出"], ["whisper", "让她自己说"]].map(([value, label]) =>
      h("button", {
        type: "button",
        class: value === mode ? "on" : "",
        disabled: value === "whisper" && !canWhisper,
        title: value === "whisper" && !canWhisper ? `这个聊天是“${info.modeLabel}”，她不会回复` : null,
        onClick(e) {
          mode = value;
          for (const b of seg.children) b.classList.toggle("on", b === e.currentTarget);
          text.placeholder = mode === "say" ? `以${BOT}的身份说点什么…  @#XXXXXX 可以 @ 群友` : "告诉她要说什么、怎么说…";
          help.textContent = hint();
        },
      }, label),
    ),
  );
  const send = action("发送", async () => {
    if (!text.value.trim()) return;
    try {
      if (mode === "say") await api.post("chat/say", { chat, text: text.value });
      else await api.post("chat/whisper", { chat, text: text.value });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await pollWindow();
      throw err;
    }
    text.value = "";
    toast(mode === "say" ? "已发送" : "已告诉她，等她回复");
    await pollWindow();
    onSent();
  }, { primary: true });

  const drawWindow = () => {
    if (!info.canSend) {
      fill(windowLine, pill("mute", "这个渠道不能主动发消息"));
      send.disabled = true;
      return;
    }
    if (!state?.open) {
      fill(windowLine, pill("warn", "现在发不出去"), " ", h("span", { class: "muted" }, state?.reason ?? ""));
      send.disabled = true;
      return;
    }
    send.disabled = false;
    const left = state.closesAt ? Math.max(0, Math.floor((state.closesAt - Date.now()) / 1000)) : null;
    fill(
      windowLine,
      pill("info", `挂在第 ${state.seq} 条（${state.sender}）上`),
      " ",
      h("span", { class: "muted" }, `${left !== null ? `窗口剩 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} · ` : ""}还能发 ${state.max - state.replies} 条`),
    );
  };
  const pollWindow = async () => {
    state = await api.get("chat/reply-window", { chat });
    drawWindow();
  };
  drawWindow();
  const stops = [every(1000, drawWindow), every(10_000, pollWindow)];
  const el = h(
    "div",
    { class: "composer" },
    h("div", { class: "row between" }, seg, windowLine),
    text,
    h("div", { class: "row between" }, help, send),
  );
  return { el, stop: () => stops.forEach((s) => s()) };
}

// ── Events ──

const REASONS = {
  completed: ["ok", "完成"],
  "max-steps": ["warn", "步数用完"],
  "out-of-time": ["warn", "时间用完"],
  error: ["bad", "出错"],
  paused: ["info", "交给下一个函数"],
  interrupted: ["warn", "被打断"],
  unreachable: ["bad", "平台连不上"],
};

const FILTERS = {
  all: ["全部", () => true],
  messages: ["消息", (e) => e.type.startsWith("user/") || e.type === "bot/sent" || e.type === "admin/message" || e.type === "session/reset"],
  model: ["模型", (e) => e.type.startsWith("assistant/") || e.type === "developer/message" || e.type === "compaction/summary"],
  tools: ["工具", (e) => e.type.startsWith("tool/")],
  errors: ["出错", (e) => (e.type === "turn/end" && e.data.reason !== "completed") || e.type === "assistant/attempt" || (e.type === "tool/result" && e.data.output.startsWith("Error:"))],
};

const cut = (text, n = 240) => (text.length > n ? `${text.slice(0, n)}…` : text);
const usageCost = (u) => (typeof u?.cost === "number" ? u.cost : undefined);

function outputSummary(output) {
  const parts = [];
  const reasoning = output.filter((i) => i.type === "reasoning").length;
  if (reasoning) parts.push(pill("mute", `思考 ${reasoning} 段`));
  for (const item of output) {
    if (item.type === "message") parts.push(`“${cut((item.content ?? []).map((c) => c.text ?? "").join(""))}”`);
    if (item.type === "function_call") parts.push(h("code", null, `${item.name}(${cut(item.arguments ?? "", 120)})`));
  }
  return parts.flatMap((p, i) => (i ? [" ", p] : [p]));
}

function summarize(e) {
  const d = e.data;
  switch (e.type) {
    case "user/message":
      return [
        h("b", null, d.sender),
        "：",
        cut(d.text),
        d.images?.length ? ` [图片×${d.images.length}]` : "",
        d.mentioned ? [" ", pill("info", "@")] : null,
        d.quiet ? [" ", pill("mute", "只记录")] : null,
        d.replyVia ? [" ", pill("info", "悄悄话")] : null,
      ];
    case "user/mentioned":
      return "这条消息又以 @ 推送了一次";
    case "session/reset":
      return "上下文清空";
    case "turn/start":
      return d.trigger === "direct" ? "开始（被 @ 或私聊）" : "开始（旁观）";
    case "turn/end":
      return [pill(...(REASONS[d.reason] ?? ["mute", d.reason])), d.error ? ` ${cut(d.error)}` : ""];
    case "step/start":
      return `第 ${d.step} 步`;
    case "step/end":
      return `第 ${d.step} 步结束`;
    case "developer/message":
      return h("span", { class: "muted" }, cut(d.text));
    case "assistant/message": {
      const u = d.usage;
      return [
        outputSummary(d.output ?? []),
        u ? h("span", { class: "muted" }, ` · 输入 ${fmtTokens(u.input_tokens)}（缓存 ${fmtTokens(u.input_tokens_details?.cached_tokens)}）输出 ${fmtTokens(u.output_tokens)}${usageCost(u) !== undefined ? ` · ${fmtUsd(usageCost(u))}` : ""}`) : null,
      ];
    }
    case "assistant/attempt":
      return [pill("bad", "调用失败"), ` ${cut(d.error)}`];
    case "tool/call":
      return h("code", null, d.name);
    case "tool/result":
      return d.output.startsWith("Error:") ? [pill("bad", "失败"), ` ${cut(d.output)}`] : cut(d.output);
    case "tool/images":
      return `打开了 ${d.images.length} 张图片`;
    case "compaction/summary":
      return `压缩了第 ${d.fromSeq} 条之前的内容：${cut(d.summary)}`;
    case "admin/message":
      return [pill("info", "管理员代发"), ` ${d.text}`];
    case "bot/sent":
      return [pill("ok", "已发出"), ` ${cut(d.text)}`];
    default:
      return "";
  }
}

/** Events of one turn (or loose messages between turns), newest group first. */
function groupByTurn(events) {
  const groups = [];
  for (const e of events) {
    const turn = typeof e.data?.turn === "number" ? e.data.turn : null;
    const last = groups.at(-1);
    if (last && last.turn === turn) last.events.push(e);
    else groups.push({ turn, events: [e] });
  }
  return groups.reverse();
}

function turnHeader(group) {
  const start = group.events.find((e) => e.type === "turn/start");
  const end = group.events.find((e) => e.type === "turn/end");
  const steps = group.events.filter((e) => e.type === "step/start").length;
  let input = 0, cached = 0, output = 0, cost = 0, priced = false;
  for (const e of group.events) {
    const u = e.type === "assistant/message" ? e.data.usage : undefined;
    if (!u) continue;
    input += u.input_tokens ?? 0;
    cached += u.input_tokens_details?.cached_tokens ?? 0;
    output += u.output_tokens ?? 0;
    if (usageCost(u) !== undefined) (cost += usageCost(u)), (priced = true);
  }
  return h(
    "div",
    { class: "turn-head" },
    h("b", null, `第 ${group.turn} 轮`),
    start ? ` · ${start.data.trigger === "direct" ? "被叫" : "旁观"}` : "",
    ` · ${steps} 步 · 输入 ${fmtTokens(input)}（缓存 ${fmtTokens(cached)}）输出 ${fmtTokens(output)}`,
    priced ? ` · ${fmtUsd(cost)}` : "",
    " ",
    end ? pill(...(REASONS[end.data.reason] ?? ["mute", end.data.reason])) : pill("info", "进行中"),
  );
}

function eventRow(e) {
  const json = h("pre", { class: "json", hidden: true }, JSON.stringify(e, null, 2));
  const row = h(
    "div",
    { class: "ev", tabindex: "0", role: "button", "aria-expanded": "false" },
    h("span", { class: "seq" }, e.seq),
    h("span", { class: "time" }, fmtClock(e.time)),
    h("span", { class: "type" }, e.type),
    h("span", { class: "what" }, summarize(e)),
  );
  const toggle = () => {
    json.hidden = !json.hidden;
    row.setAttribute("aria-expanded", String(!json.hidden));
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), toggle()));
  return h("div", null, row, json);
}

function renderEvents(body, chat, info) {
  const events = new Map();
  let filter = "all";
  let session = null;
  const list = h("div", { class: "events" });
  const meta = h("span", { class: "muted" });
  const more = h("button", { type: "button", class: "btn btn-small" }, "加载更早的");

  const draw = () => {
    const sorted = [...events.values()].sort((a, b) => a.seq - b.seq);
    const test = FILTERS[filter][1];
    const groups = groupByTurn(sorted);
    meta.textContent = !session ? "" : session.minSeq > 0 ? `共 ${session.nextSeq} 条事件，第 ${session.minSeq} 条之前的已压缩成摘要` : `共 ${session.nextSeq} 条事件`;
    more.hidden = !events.size || Math.min(...events.keys()) <= (session?.minSeq ?? 0);
    fill(
      list,
      groups.length
        ? groups.map((g) => {
            const shown = g.events.filter(test);
            if (!shown.length) return null;
            return h("section", { class: "turn" }, g.turn !== null ? turnHeader(g) : null, [...shown].reverse().map(eventRow));
          })
        : h("p", { class: "muted" }, "没有事件。"),
    );
  };
  const load = async (params) => {
    const page = await api.get("chat/events", { chat, limit: 150, ...params });
    session = page.session ?? session;
    for (const e of page.events) events.set(e.seq, e);
    return page.events.length;
  };
  const newest = () => (events.size ? Math.max(...events.keys()) : -1);
  more.addEventListener("click", async () => {
    const oldest = Math.min(...events.keys());
    if (!(await load({ before: oldest }))) more.hidden = true;
    draw();
  });

  const seg = h(
    "span",
    { class: "seg", role: "group" },
    Object.entries(FILTERS).map(([id, [label]]) =>
      h("button", {
        type: "button",
        class: id === filter ? "on" : "",
        onClick(e) {
          filter = id;
          for (const b of seg.children) b.classList.toggle("on", b === e.currentTarget);
          draw();
        },
      }, label),
    ),
  );

  fill(
    body,
    h(
      "div",
      { class: "row between" },
      seg,
      h(
        "span",
        { class: "row" },
        info.locked ? confirmAction("释放锁", "正在跑的一轮会在下一步停下，确定？", async () => {
          const { released } = await api.post("chat/unlock", { chat });
          toast(released ? "已释放" : "没有锁");
        }) : null,
        confirmAction("重置上下文", "她会忘掉之前的对话，事件和聊天记录都会清空，确定？", async () => {
          await api.post("chat/reset", { chat });
          toast("已重置");
          events.clear();
          await load();
          draw();
        }),
      ),
    ),
    h("p", null, meta, h("span", { class: "muted" }, " · 点一行看原始 JSON · 每 3 秒刷新")),
    list,
    h("div", { class: "row" }, more),
  );
  load().then(draw);
  return every(3000, async () => {
    if ((await load({ after: newest() })) > 0) draw();
  });
}

// ── Settings and quotas ──

/** How today's count of a quota reads: dollars for cost, a number for the rest. */
const showCount = (key, n) => (key === "cost_usd" ? fmtUsd(n) : String(n));

function renderSettings(body, chat, info, app) {
  const p = info.profile ?? {};
  const { modes, features, quotas: quotaChoices } = info.choices;
  const labelOf = (value) => modes.find((o) => o.value === value)?.label ?? value;
  const today = info.usageByDay.at(-1)?.day === new Date().toISOString().slice(0, 10) ? info.usageByDay.at(-1).counts : {};
  const errors = {};
  const errorSlot = (key) => (errors[key] = h("p", { class: "field-error", hidden: true }));
  const field = (id, label, input, help, key = id) =>
    h("div", { class: "field" }, h("label", { for: `profile-${id}` }, label), input, help ? h("p", { class: "help" }, help) : null, errorSlot(key));

  const title = h("input", { id: "profile-title", type: "text", value: p.title ?? "", maxlength: 60, placeholder: "比如：鲸鱼研究所" });
  const mode = h(
    "select",
    { id: "profile-mode" },
    h("option", { value: "", selected: !p.mode }, `跟随默认（${labelOf(info.defaults.mode)}）`),
    modes.map((o) => h("option", { value: o.value, selected: p.mode === o.value }, o.label)),
  );
  const interval = h("input", { id: "profile-interval", type: "text", inputmode: "numeric", value: p.ambientIntervalSeconds ?? "", placeholder: `默认 ${info.defaults.ambientIntervalSeconds}` });
  const disabled = new Set(p.disabledTools ?? []);
  const tools = features.map(({ value: id, label }) => {
    const box = h("input", { id: `profile-tool-${id}`, type: "checkbox", checked: !disabled.has(id) });
    return { id, box, el: h("label", { class: "check", for: `profile-tool-${id}` }, box, label) };
  });
  const prompt = h("textarea", { id: "profile-prompt", rows: 4, maxlength: 2000, placeholder: "比如：这是一个研究海洋生物的群，说话可以更学术一点。" });
  prompt.value = p.prompt ?? "";
  const quotas = quotaChoices.map(({ value: key, label }) => {
    const input = h("input", { id: `profile-quota-${key}`, type: "text", inputmode: "decimal", value: p.quota?.[key] ?? "", placeholder: "不限" });
    return { key, input, row: h("tr", null, h("td", null, h("label", { for: `profile-quota-${key}` }, label)), h("td", { class: "num" }, showCount(key, today[key] ?? 0)), h("td", null, input), h("td", null, errorSlot(`quota.${key}`))) };
  });

  const save = action("保存", async () => {
    for (const slot of Object.values(errors)) slot.hidden = true;
    const profile = {
      title: title.value,
      mode: mode.value || null,
      ambientIntervalSeconds: interval.value.trim() || null,
      disabledTools: tools.filter((t) => !t.box.checked).map((t) => t.id),
      prompt: prompt.value,
      quota: Object.fromEntries(quotas.map((q) => [q.key, q.input.value.trim() || null])),
    };
    try {
      await api.put("chat/profile", { chat, profile });
    } catch (err) {
      if (err instanceof ApiError) {
        for (const [key, message] of Object.entries(err.fields)) {
          const slot = errors[key];
          if (slot) (slot.hidden = false), (slot.textContent = message);
        }
      }
      throw err;
    }
    toast("已保存，30 秒内生效");
    app.go(`#/chat/${encodeURIComponent(chat)}/settings`);
  }, { primary: true });

  const maxCost = Math.max(0.0001, ...info.usageByDay.map((d) => d.counts.cost_usd ?? 0));
  fill(
    body,
    h(
      "div",
      { class: "two-col" },
      h(
        "div",
        { class: "stack" },
        field("title", "备注名", title, "QQ 不给群名，起个好认的名字。"),
        field("mode", "回复方式", mode, "正常：被 @ 必回，平时偶尔插话。只回 @：不插话。只记录：一律不回，消息留作上下文。屏蔽：连记录都不存。"),
        field("interval", "插话频率（秒）", interval, "群里没 @ 的消息，每这么多秒最多给她看一次。0 = 不插话。"),
        h("div", { class: "field" }, h("span", { class: "label" }, "能用的工具"), h("div", { class: "row" }, tools.map((t) => t.el)), errorSlot("disabledTools")),
        field("prompt", "这个聊天的额外设定", prompt, "加在系统提示后面，只对这个聊天生效。"),
      ),
      h(
        "div",
        { class: "stack" },
        h("h3", null, "每日额度", h("span", { class: "muted small" }, " 北京时间 08:00 重置")),
        h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, h("th", null, "项目"), h("th", { class: "num" }, "今日"), h("th", null, "上限"), h("th", null, ""))), h("tbody", null, quotas.map((q) => q.row)))),
        h("p", { class: "help" }, "模型花费用完后：被 @ 时回一句“今天的额度用完了”，平时不插话。画图、语音、搜索用完时只是那个工具不能用，她会自己说明。"),
        h("h3", null, "近 7 天模型花费"),
        h(
          "div",
          { class: "bars" },
          info.usageByDay.map((d) =>
            h("div", { class: "bar-col", title: `${d.day}：${fmtUsd(d.counts.cost_usd ?? 0)}，${d.counts.turns ?? 0} 轮` }, h("i", { style: `height:${Math.max(2, ((d.counts.cost_usd ?? 0) / maxCost) * 100)}%` }), h("span", null, d.day.slice(5))),
          ),
        ),
      ),
    ),
    h("div", { class: "row" }, save),
  );
}
