const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── smooth scroll (Lenis; falls back to native when the file didn't load) ── */
if (window.Lenis && !reduced) {
  const lenis = new Lenis({ lerp: 0.085, anchors: { offset: -84 } });
  const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
}

/* ── nav: glass after scrolling, hide on scroll down ── */
const nav = $("#nav");
let lastY = 0;
addEventListener("scroll", () => {
  const y = scrollY;
  nav.classList.toggle("scrolled", y > 24);
  nav.classList.toggle("hidden", y > lastY && y > 320);
  lastY = y;
}, { passive: true });

/* ── reveal on enter ── */
const reveal = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); reveal.unobserve(e.target); }
}, { rootMargin: "0px 0px -10% 0px", threshold: 0.08 });
$$("[data-reveal], .lines").forEach((n) => reveal.observe(n));

/* ── count-up numbers ── */
const counters = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    counters.unobserve(e.target);
    const n = e.target, to = parseFloat(n.dataset.count), suffix = n.dataset.suffix ?? "", dec = (n.dataset.count.split(".")[1] ?? "").length;
    if (reduced) { n.textContent = to.toFixed(dec) + suffix; continue; }
    const t0 = performance.now(), dur = 1400;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur), k = 1 - Math.pow(1 - p, 4);
      n.textContent = (to * k).toFixed(dec) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}, { threshold: 0.5 });
$$("[data-count]").forEach((n) => counters.observe(n));

/* ── spotlight that follows the pointer over bento cards ── */
const bento = $("#bento");
bento?.addEventListener("pointermove", (ev) => {
  for (const card of bento.children) {
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${ev.clientX - r.left}px`);
    card.style.setProperty("--my", `${ev.clientY - r.top}px`);
  }
});

/* ── magnetic buttons ── */
if (!reduced && matchMedia("(hover: hover)").matches) {
  for (const b of $$(".magnetic")) {
    b.addEventListener("pointermove", (ev) => {
      const r = b.getBoundingClientRect();
      const x = (ev.clientX - r.left - r.width / 2) * 0.18, y = (ev.clientY - r.top - r.height / 2) * 0.3;
      b.style.transform = `translate(${x}px, ${y}px)`;
    });
    b.addEventListener("pointerleave", () => { b.style.transform = ""; });
  }
}

/* ── copy buttons ── */
for (const btn of $$(".copy")) {
  btn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(btn.dataset.copy); btn.textContent = "已复制"; setTimeout(() => (btn.textContent = "复制"), 1400); } catch {}
  });
}

/* ── typed command ── */
const typed = $("#typed");
if (typed) {
  const text = typed.dataset.text;
  if (reduced) typed.textContent = text;
  else new IntersectionObserver((entries, obs) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    obs.disconnect();
    let i = 0;
    const step = () => { typed.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(step, 70 + Math.random() * 90); };
    setTimeout(step, 500);
  }, { threshold: 0.6 }).observe(typed);
}

/* ── hero: a scripted group chat that plays on loop ── */
const chat = $("#chat-body"), trace = $("#trace-list");
const AV = { 老王: "王", 小张: "张" };
const SCENE = [
  { at: 0, msg: { who: "老王", html: '<span class="at">@大肥鱼</span> 今天美元对人民币多少' } },
  { at: 700, trace: ["唤起 · 抢到锁", ""] },
  { at: 1000, typing: true },
  { at: 1600, trace: ["web_search · 美元 人民币 汇率", "tool"] },
  { at: 2800, me: "7.12。这种东西自己不会搜吗", trace: ["send_message · 回复第40条", "say"] },
  { at: 3400, msg: { who: "小张", html: "顺便查下日元" } },
  { at: 3700, trace: ["新消息 #46 · 下一步可见", ""] },
  { at: 4000, typing: true },
  { at: 4700, trace: ["web_search · 日元 汇率", "tool"] },
  { at: 5700, me: "0.0466。一次问完行不行", trace: ["send_message · 回复第46条", "say"] },
  { at: 6300, sticker: true, trace: ["send_sticker · 摆烂", "say"] },
  { at: 7000, trace: ["end_turn", "end"] },
  { at: 10200, reset: true },
];

function addMsg({ who, html, me, sticker }) {
  const m = el("div", "msg" + (me ? " me" : ""));
  const av = el("div", "av", me ? '<img src="logo.png" alt="">' : AV[who]);
  const bd = el("div", "bd");
  bd.append(el("div", "name", me ? "大肥鱼" : who));
  bd.append(sticker ? el("div", "bub sticker", '<img src="logo.png" alt="表情包">') : el("div", "bub", html));
  m.append(av, bd);
  chat.append(m);
  while (chat.children.length > 6) chat.firstChild.remove();
  return m;
}
function setTyping(on) {
  const cur = $(".msg.typing-row", chat);
  if (!on) { cur?.remove(); return; }
  if (cur) return;
  const m = el("div", "msg me typing-row");
  m.append(el("div", "av", '<img src="logo.png" alt="">'), el("div", "bd", '<div class="name">大肥鱼</div><div class="bub typing"><i></i><i></i><i></i></div>'));
  chat.append(m);
}
function addTrace([text, cls]) {
  trace.append(el("li", cls, text));
  while (trace.children.length > 4) trace.firstChild.remove();
}

async function playScene() {
  let turn = 12;
  for (;;) {
    $("#trace-turn").textContent = `turn ${turn}`;
    let t = 0;
    for (const s of SCENE) {
      await sleep(s.at - t); t = s.at;
      if (s.reset) break;
      if (s.msg) addMsg(s.msg);
      if (s.typing) setTyping(true);
      if (s.me) { setTyping(false); addMsg({ me: true, html: s.me }); }
      if (s.sticker) addMsg({ me: true, sticker: true });
      if (s.trace) addTrace(s.trace);
    }
    chat.classList.add("out"); for (const li of trace.children) li.classList.add("out");
    await sleep(600);
    chat.classList.remove("out"); chat.innerHTML = ""; trace.innerHTML = "";
    turn++;
  }
}
if (chat) {
  if (reduced) { SCENE.filter((s) => s.msg || s.me || s.sticker).forEach((s) => s.msg ? addMsg(s.msg) : addMsg({ me: true, html: s.me, sticker: s.sticker })); SCENE.filter((s) => s.trace).slice(-4).forEach((s) => addTrace(s.trace)); }
  else playScene();
}

/* ── story: the terminal grows as each step scrolls into the middle of the viewport ── */
const LINES = [
  [["▶", "POST /api/webhook/qq", "sys", "<b>200</b> · 11 ms · 后台继续（waitUntil）"]],
  [["#40", "user/message", "user", "老王 @你：今天美元对人民币多少"], ["", "dedupe", "meta", "msg_8f21 第一次见到 · 已入库"]],
  [["lock", "acquired", "meta", "owner run-7f3a · ttl 60s · 续期 20s"], ["#41", "turn/start", "meta", "第 12 轮"]],
  [["#42", "developer/message", "sys", "第12轮开始。待处理：第40条（老王，@你）"], ["#43", "assistant/message", "", "思维链 ··· → web_search"], ["#44", "tool/call", "tool", 'web_search("美元 人民币 汇率")'], ["#45", "tool/result", "tool", "1 USD ≈ 7.12 CNY"], ["#46", "user/message", "user", "小张：顺便查下日元"], ["#47", "developer/message", "sys", "你处理期间又来了 第46条"]],
  [["#48", "assistant/message", "", "send_message ×2 · send_sticker · end_turn"], ["#49", "turn/end", "meta", "completed · <b>cached 97.8%</b>"], ["lock", "released", "meta", "没有待办，结束"]],
];
const termLines = $("#term-lines"), termProg = $("#term-prog b"), steps = $$(".step");
let shown = -1;
function renderStep(idx) {
  if (idx === shown) return;
  const want = LINES.slice(0, idx + 1).flat();
  const have = termLines.children.length;
  if (want.length < have) {
    const extra = [...termLines.children].slice(want.length);
    extra.forEach((li) => li.classList.add("out"));
    setTimeout(() => extra.forEach((li) => li.remove()), 300);
  } else {
    want.slice(have).forEach(([seq, type, cls, body], k) => {
      const li = el("li", "", `<span class="seq">${seq}</span><span class="type ${cls}">${type}</span><span class="body">${body}</span>`);
      li.style.setProperty("--k", k);
      termLines.append(li);
    });
  }
  termProg.style.setProperty("--p", (idx + 1) / LINES.length);
  steps.forEach((s, i) => s.classList.toggle("active", i === idx));
  shown = idx;
}
if (termLines) {
  termLines.append(el("li", "empty", "等待消息…"));
  const empty = termLines.firstChild;
  // The first line appears as soon as the terminal itself is in view, so it never sits empty.
  new IntersectionObserver((entries, obs) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    obs.disconnect();
    if (shown < 0) { empty.remove(); renderStep(0); }
  }, { threshold: 0.6 }).observe(termLines);
  const stepObs = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { if (empty.isConnected) empty.remove(); renderStep(+e.target.dataset.step); }
  }, { rootMargin: "-42% 0px -42% 0px", threshold: 0 });
  steps.forEach((s) => stepObs.observe(s));
}
