const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (p, a, b) => clamp((p - a) / (b - a));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** 1 inside [a, b], ramping over `f` at both ends. */
const window_ = (p, a, b, f = 0.04) => Math.min(seg(p, a, a + f), 1 - seg(p, b - f, b));

const show = (el, v) => {
  el.style.opacity = v;
};

/* ══════════════════════════════════════════════════════════════
   The take. One sticky stage; everything below is a pure function
   of the scroll progress p ∈ [0, 1] through #take.
   Demand-driven rAF interpolation: runs ONLY while scrolling in #take,
   stops completely when idle or past #take (0% idle CPU/GPU).
   ══════════════════════════════════════════════════════════════ */
const take = $("#take"), stage = $("#stage");
const hero = $("#hero"), orb = $("#orb"), bIn = $("#b-in"), log = $("#log"), logLines = $$("li", log);
const tools = $("#tools"), toolEls = $$(".tool", tools), outs = [$("#b-out-1"), $("#b-out-2"), $("#b-out-3")];
const caps = [0, 1, 2, 3].map((i) => $(`#cap-${i}`)), statement = $("#statement"), rail = $("#rail"), railDots = $$("span", rail);

const T = {               // timeline (fractions of the take)
  hero: [0, 0.13],        // hero copy fades, orb slides to centre
  inb: [0.09, 0.23],      // user message travels into the orb
  cap0: [0.10, 0.28],
  log: [0.25, 0.43],      // event lines appear one after another
  cap1: [0.27, 0.47],
  tools: [0.45, 0.63],    // tool chips orbit
  cap2: [0.47, 0.67],
  outs: [0.65, 0.85],     // replies fly out
  cap3: [0.67, 0.87],
  end: [0.87, 1],         // orb rises, statement appears
};

let mobile = false, R = 90, offIn = { x: 0, y: 0 }, offOuts = [], orbHero = { x: 0, y: 0 }, toolAngles = [];
let takeTop = 0, takeRange = 1;

function measure() {
  const vw = innerWidth, vh = innerHeight, sy = scrollY;
  mobile = vw <= 900;
  R = Math.round(clamp(vw * 0.11, 56, 96));
  const sr = stage.getBoundingClientRect();
  const tr = take.getBoundingClientRect();
  const o = { x: sr.left + sr.width * (mobile ? 0.5 : 0.62), y: sr.top + sr.height * (mobile ? 0.44 : 0.5) };
  const c = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const bi = c(bIn);
  offIn = { x: o.x - bi.x, y: o.y - bi.y };
  offOuts = outs.map((el) => { const r = c(el); return { x: o.x - r.x, y: o.y - r.y }; });
  orbHero = mobile ? { x: 0, y: sr.height * 0.3 } : { x: Math.min(vw * 0.16, 300), y: 0 };
  toolAngles = toolEls.map((el) => parseFloat(el.style.getPropertyValue("--a")) || 0);
  takeTop = tr.top + sy;
  takeRange = Math.max(1, tr.height - sr.height);
}

// Measure layout FIRST while the initial layout tree is clean (before .split mutates DOM) -> 0ms forced reflow
if (!reduced) measure();

/* ── split text: every <br>-separated line rises out of its own clip ── */
for (const node of $$(".split")) {
  const lines = [[]];
  for (const c of [...node.childNodes]) (c.nodeName === "BR" ? lines.push([]) : lines.at(-1).push(c));
  node.replaceChildren(...lines.map((nodes, i) => {
    const line = document.createElement("span"), ln = document.createElement("span");
    line.className = "line"; ln.className = "ln"; ln.style.setProperty("--i", i);
    ln.append(...nodes); line.append(ln); return line;
  }));
}

/* ── reveal on enter ── */
const reveal = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); reveal.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
$$("[data-reveal]").forEach((n) => reveal.observe(n));

/* ── count-up ── */
const counters = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    counters.unobserve(e.target);
    const n = e.target, to = parseFloat(n.dataset.count), suffix = n.dataset.suffix ?? "", dec = (n.dataset.count.split(".")[1] ?? "").length;
    if (reduced) { n.textContent = to.toFixed(dec) + suffix; continue; }
    const t0 = performance.now();
    const tick = (t) => { const k = easeOut(clamp((t - t0) / 1400)); n.textContent = (to * k).toFixed(dec) + suffix; if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
}, { threshold: 0.5 });
$$("[data-count]").forEach((n) => counters.observe(n));

/* ── copy + typed command ── */
for (const btn of $$(".copy")) btn.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(btn.dataset.copy); btn.textContent = "已复制"; setTimeout(() => (btn.textContent = "复制"), 1400); } catch {}
});
const typed = $("#typed");
if (typed) {
  const text = typed.dataset.text;
  if (reduced) typed.textContent = text;
  else {
    new IntersectionObserver((entries, obs) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      obs.disconnect();
      typed.textContent = "";
      let i = 0;
      const step = () => { typed.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(step, 70 + Math.random() * 90); };
      setTimeout(step, 250);
    }, { threshold: 0.6 }).observe(typed);
  }
}

function render(p) {
  // hero
  const h = seg(p, ...T.hero);
  show(hero, 1 - easeOut(h));
  hero.style.transform = `translateY(${mobile ? 0 : -50}%) translate3d(0, ${-40 * easeOut(h)}px, 0)`;
  hero.style.pointerEvents = h < 0.5 ? "" : "none";

  // orb: from the hero position to the centre, then up and smaller for the statement
  const e = seg(p, ...T.end), ee = easeInOut(e);
  const ox = orbHero.x * (1 - easeInOut(h)), oy = orbHero.y * (1 - easeInOut(h));
  const pulse = 1 + 0.06 * Math.sin(seg(p, ...T.tools) * Math.PI * 4) * window_(p, ...T.tools, 0.05);
  orb.style.transform = `translate3d(${ox}px, ${oy - ee * innerHeight * (mobile ? 0.3 : 0.32)}px, 0) scale(${(1 - 0.45 * ee) * pulse})`;

  // user message travels into the orb and is absorbed
  const i = seg(p, ...T.inb), ie = easeInOut(i);
  const inOp = Math.min(seg(i, 0, 0.18), 1 - seg(i, 0.82, 1));
  show(bIn, inOp);
  if (inOp > 0.002) {
    bIn.style.transform = `${mobile ? "translateX(-50%) " : ""}translate3d(${offIn.x * ie}px, ${offIn.y * ie}px, 0) scale(${1 - 0.6 * ie})`;
  }

  // event log: one line per slice, then everything fades before the tools
  const l = seg(p, ...T.log), lv = l > 0 ? 1 - seg(p, T.log[1] + 0.02, T.log[1] + 0.06) : 0;
  show(log, lv);
  if (lv > 0.002) {
    logLines.forEach((li, k) => {
      const a = easeOut(seg(l, k / logLines.length, (k + 1) / logLines.length));
      li.style.opacity = a * lv;
      li.style.transform = `translate3d(0, ${(1 - a) * 10}px, 0)`;
    });
  }

  // tools orbit while the agent "thinks"
  const t = seg(p, ...T.tools), tv = window_(p, ...T.tools, 0.05);
  const rad = R + (mobile ? 54 : 72);
  toolEls.forEach((el, k) => {
    const s = easeOut(seg(t, k * 0.08, k * 0.08 + 0.22));
    const op = s * tv;
    show(el, op);
    if (op > 0.002) {
      const a = (toolAngles[k] + t * 110) * Math.PI / 180;
      const tx = Math.cos(a) * rad;
      const ty = Math.sin(a) * rad * (mobile ? 0.75 : 0.62);
      el.style.transform = `translate(-50%, -50%) translate3d(${tx}px, ${ty}px, 0) scale(${0.6 + 0.4 * s})`;
    }
  });

  // replies fly out one after another, then clear for the statement
  const o = seg(p, ...T.outs), ov = o > 0 ? 1 - seg(p, T.outs[1] + 0.02, T.outs[1] + 0.06) : 0;
  outs.forEach((el, k) => {
    const f = easeInOut(seg(o, k * 0.22, k * 0.22 + 0.34));
    const op = Math.min(seg(f, 0, 0.3), 1) * ov;
    show(el, op);
    if (op > 0.002) {
      el.style.transform = `${mobile ? "translateX(-50%) " : ""}translate3d(${offOuts[k].x * (1 - f)}px, ${offOuts[k].y * (1 - f)}px, 0) scale(${0.4 + 0.6 * f})`;
    }
  });

  // captions
  [T.cap0, T.cap1, T.cap2, T.cap3].forEach(([a, b], k) => {
    const v = window_(p, a, b, 0.05);
    show(caps[k], v);
    if (v > 0.002) {
      caps[k].style.transform = `${mobile ? "" : "translateY(-50%) "}translate3d(0, ${(1 - v) * 16}px, 0)`;
    }
  });

  // statement
  const stOp = easeOut(seg(e, 0.3, 1));
  show(statement, stOp);
  if (stOp > 0.002) {
    statement.style.transform = `translate(-50%, -50%) translate3d(0, ${(1 - stOp) * 30}px, 0)`;
  }

  // rail
  rail.style.setProperty("--p", p);
  const idx = p < T.cap0[1] ? 0 : p < T.cap1[1] ? 1 : p < T.cap2[1] ? 2 : p < T.cap3[1] ? 3 : 4;
  railDots.forEach((d, k) => d.classList.toggle("on", k === idx));
}

if (!reduced) {
  let targetP = 0, curP = 0, rafId = 0, lastT = 0;

  const getTargetP = () => clamp((scrollY - takeTop) / takeRange);

  const tick = (now) => {
    const dt = lastT ? Math.min(32, now - lastT) : 16.67;
    lastT = now;
    const scale = dt / 16.67;
    const diff = targetP - curP;
    if (Math.abs(diff) > 0.00025) {
      // Time-normalized gentle damping + velocity cap so 120Hz screens or fast wheel flicks never whip too fast
      const step = clamp(diff * 0.075 * scale, -0.0075 * scale, 0.0075 * scale);
      curP += step;
      render(curP);
      rafId = requestAnimationFrame(tick);
    } else {
      curP = targetP;
      render(curP);
      rafId = 0;
      lastT = 0;
    }
  };

  const onScroll = () => {
    const next = getTargetP();
    if (next === targetP && rafId === 0) return;
    targetP = next;
    if (!rafId) {
      lastT = 0;
      rafId = requestAnimationFrame(tick);
    }
  };

  targetP = curP = getTargetP();
  render(curP);

  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", () => {
    for (const el of [bIn, ...outs]) el.style.transform = "";
    measure();
    targetP = curP = getTargetP();
    render(curP);
  });
}
