const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (p, a, b) => clamp((p - a) / (b - a));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** 1 inside [a, b], ramping over `f` at both ends. */
const window_ = (p, a, b, f = 0.04) => Math.min(seg(p, a, a + f), 1 - seg(p, b - f, b));

/* ── split text: each character rises out of a clipped word ── */
for (const node of $$(".split")) {
  let i = 0;
  const walk = (n) => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 3) {
        const frag = document.createDocumentFragment();
        for (const word of c.textContent.split(/(\s+)/)) {
          if (!word) continue;
          if (/^\s+$/.test(word)) { frag.append(word); continue; }
          const w = document.createElement("span"); w.className = "w";
          for (const ch of word) { const s = document.createElement("span"); s.className = "ch"; s.textContent = ch; s.style.setProperty("--i", i++); w.append(s); }
          frag.append(w);
        }
        c.replaceWith(frag);
      } else if (c.nodeType === 1 && c.tagName !== "BR") walk(c);
    }
  };
  walk(node);
}

/* ── loader: a short count, then the curtain lifts and the hero text rises ── */
const loader = $("#loader");
if (reduced) { loader.remove(); document.documentElement.classList.add("ready"); }
else {
  const n = $("#loader-n"), t0 = performance.now(), dur = 700;
  const finish = () => { loader.classList.add("done"); document.documentElement.classList.add("ready"); setTimeout(() => loader.remove(), 1100); };
  const tick = (t) => {
    const p = easeOut(clamp((t - t0) / dur));
    n.textContent = String(Math.round(p * 100)).padStart(3, "0");
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(finish, dur + 60); // timer, not rAF: background tabs throttle rAF but must not keep the curtain down
}

/* ── smooth scroll ── */
let lenis = null;
if (window.Lenis && !reduced) {
  lenis = new Lenis({ lerp: 0.08, anchors: { offset: -40 } });
  const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
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
  else new IntersectionObserver((entries, obs) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    obs.disconnect();
    let i = 0;
    const step = () => { typed.textContent = text.slice(0, ++i); if (i < text.length) setTimeout(step, 70 + Math.random() * 90); };
    setTimeout(step, 500);
  }, { threshold: 0.6 }).observe(typed);
}

/* ══════════════════════════════════════════════════════════════
   The take. One sticky stage; everything below is a pure function
   of the scroll progress p ∈ [0, 1] through #take.
   ══════════════════════════════════════════════════════════════ */
const take = $("#take"), stage = $("#stage");
const hero = $("#hero"), orb = $("#orb"), bIn = $("#b-in"), log = $("#log"), logLines = $$("li", log);
const tools = $("#tools"), toolEls = $$(".tool", tools), outs = [$("#b-out-1"), $("#b-out-2"), $("#b-out-3")];
const caps = [0, 1, 2, 3].map((i) => $(`#cap-${i}`)), statement = $("#statement"), rail = $("#rail"), railDots = $$("span", rail);

const T = {               // timeline (fractions of the take)
  hero: [0, 0.1],         // hero copy fades, orb slides to centre
  inb: [0.07, 0.2],       // user message travels into the orb
  cap0: [0.08, 0.26],
  log: [0.24, 0.42],      // event lines appear one after another
  cap1: [0.26, 0.46],
  tools: [0.44, 0.62],    // tool chips orbit
  cap2: [0.46, 0.66],
  outs: [0.64, 0.84],     // replies fly out
  cap3: [0.66, 0.86],
  end: [0.86, 1],         // orb rises, statement appears
};

let mobile = false, R = 90, offIn = { x: 0, y: 0 }, offOuts = [], orbHero = { x: 0, y: 0 };

function measure() {
  mobile = innerWidth <= 760;
  R = Math.round(clamp(innerWidth * 0.11, 56, 96));
  document.documentElement.style.setProperty("--R", R + "px");
  // Rest positions are laid out by CSS; the travel offsets are measured with transforms cleared.
  for (const el of [orb, bIn, ...outs]) el.style.transform = "";
  const c = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const o = c(orb);
  offIn = { x: o.x - c(bIn).x, y: o.y - c(bIn).y };
  offOuts = outs.map((el) => ({ x: o.x - c(el).x, y: o.y - c(el).y }));
  orbHero = mobile ? { x: 0, y: innerHeight * 0.3 } : { x: Math.min(innerWidth * 0.24, 420), y: 0 };
}

function render(p) {
  // hero
  const h = seg(p, ...T.hero);
  hero.style.opacity = 1 - easeOut(h);
  hero.style.transform = `translateY(${mobile ? 0 : -50}%) translateY(${-40 * easeOut(h)}px)`;
  hero.style.pointerEvents = h < 0.5 ? "" : "none";

  // orb: from the hero position to the centre, then up and smaller for the statement
  const e = seg(p, ...T.end), ee = easeInOut(e);
  const ox = orbHero.x * (1 - easeInOut(h)), oy = orbHero.y * (1 - easeInOut(h));
  const pulse = 1 + 0.06 * Math.sin(seg(p, ...T.tools) * Math.PI * 4) * window_(p, ...T.tools, 0.05);
  orb.style.transform = `translate(${ox}px, ${oy - ee * innerHeight * (mobile ? 0.3 : 0.32)}px) scale(${(1 - 0.45 * ee) * pulse})`;

  // user message travels into the orb and is absorbed
  const i = seg(p, ...T.inb), ie = easeInOut(i);
  bIn.style.opacity = Math.min(seg(i, 0, 0.18), 1 - seg(i, 0.82, 1));
  bIn.style.transform = `${mobile ? "translateX(-50%) " : ""}translate(${offIn.x * ie}px, ${offIn.y * ie}px) scale(${1 - 0.6 * ie})`;

  // event log: one line per slice, then everything fades before the tools
  const l = seg(p, ...T.log), lv = 1 - seg(p, T.log[1] + 0.02, T.log[1] + 0.06);
  logLines.forEach((li, k) => {
    const a = easeOut(seg(l, k / logLines.length, (k + 1) / logLines.length));
    li.style.opacity = a * lv;
    li.style.transform = `translateY(${(1 - a) * 10}px)`;
  });
  log.style.opacity = lv;

  // tools orbit while the agent "thinks"
  const t = seg(p, ...T.tools), tv = window_(p, ...T.tools, 0.05);
  const rad = R + (mobile ? 54 : 72);
  toolEls.forEach((el, k) => {
    const a = (parseFloat(el.style.getPropertyValue("--a")) + t * 300) * Math.PI / 180;
    const s = easeOut(seg(t, k * 0.08, k * 0.08 + 0.22));
    el.style.opacity = s * tv;
    el.style.transform = `translate(calc(-50% + ${Math.cos(a) * rad}px), calc(-50% + ${Math.sin(a) * rad * (mobile ? 0.75 : 0.62)}px)) scale(${0.6 + 0.4 * s})`;
  });

  // replies fly out one after another, then clear for the statement
  const o = seg(p, ...T.outs), ov = 1 - seg(p, T.outs[1] + 0.02, T.outs[1] + 0.06);
  outs.forEach((el, k) => {
    const f = easeInOut(seg(o, k * 0.22, k * 0.22 + 0.34));
    el.style.opacity = Math.min(seg(f, 0, 0.3), 1) * ov;
    el.style.transform = `${mobile ? "translateX(-50%) " : ""}translate(${offOuts[k].x * (1 - f)}px, ${offOuts[k].y * (1 - f)}px) scale(${0.4 + 0.6 * f})`;
  });

  // captions
  [T.cap0, T.cap1, T.cap2, T.cap3].forEach(([a, b], k) => {
    const v = window_(p, a, b, 0.05);
    caps[k].style.opacity = v;
    caps[k].style.transform = `translateY(${(1 - v) * 14}px)`;
  });

  // statement
  statement.style.opacity = easeOut(seg(e, 0.3, 1));
  statement.style.transform = `translate(-50%, -50%) translateY(${(1 - easeOut(seg(e, 0.3, 1))) * 30}px)`;

  // rail
  rail.style.setProperty("--p", p);
  const idx = p < T.cap0[1] ? 0 : p < T.cap1[1] ? 1 : p < T.cap2[1] ? 2 : p < T.cap3[1] ? 3 : 4;
  railDots.forEach((d, k) => d.classList.toggle("on", k === idx));
}

let last = -1;
function update() {
  const top = take.getBoundingClientRect().top;
  const p = clamp(-top / (take.offsetHeight - stage.offsetHeight));
  if (p !== last) { last = p; render(p); }
}

if (!reduced) {
  measure(); update();
  addEventListener("resize", () => { measure(); last = -1; update(); });
  if (lenis) lenis.on("scroll", update); else addEventListener("scroll", update, { passive: true });
  // fonts and the logo can shift the measured rest positions
  addEventListener("load", () => { measure(); last = -1; update(); });
}
