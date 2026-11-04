const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/* ── 1. Choreographed Hero Stage (4 phases, pauses when off-screen) ── */
const stage = $("#stage");
const railSteps = $$(".rail-step");
if (stage && railSteps.length) {
  let phase = 0;
  let timer = null;
  let inView = true;
  let manual = false;

  const setPhase = (idx, isManual = false) => {
    phase = idx;
    stage.dataset.phase = String(idx);
    railSteps.forEach((btn, k) => {
      btn.classList.toggle("active", k === idx);
      btn.classList.toggle("manual", isManual && k === idx);
    });
  };

  const startLoop = () => {
    clearInterval(timer);
    if (reduced || !inView || manual) return;
    timer = setInterval(() => {
      setPhase((phase + 1) % railSteps.length, false);
    }, 3600);
  };

  railSteps.forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      manual = true;
      clearInterval(timer);
      setPhase(idx, true);
    });
    btn.addEventListener("mouseenter", () => {
      clearInterval(timer);
      setPhase(idx, true);
    });
    btn.addEventListener("mouseleave", () => {
      manual = false;
      setPhase(phase, false);
      startLoop();
    });
  });

  new IntersectionObserver((entries) => {
    inView = entries[0]?.isIntersecting ?? false;
    if (inView) startLoop();
    else clearInterval(timer);
  }, { threshold: 0.15 }).observe(stage);

  startLoop();
}

/* ── 2. Scroll reveal ── */
const reveal = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add("in");
      reveal.unobserve(e.target);
    }
  }
}, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
$$("[data-reveal]").forEach((n) => reveal.observe(n));

/* ── 3. Count-up figures ── */
const counters = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    counters.unobserve(e.target);
    const n = e.target;
    const to = parseFloat(n.dataset.count);
    const suffix = n.dataset.suffix ?? "";
    const dec = (n.dataset.count.split(".")[1] ?? "").length;
    if (reduced) {
      n.textContent = to.toFixed(dec) + suffix;
      continue;
    }
    const t0 = performance.now();
    const tick = (t) => {
      const k = easeOut(clamp((t - t0) / 1200));
      n.textContent = (to * k).toFixed(dec) + suffix;
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}, { threshold: 0.5 });
$$("[data-count]").forEach((n) => counters.observe(n));

/* ── 4. Copy + typed command ── */
for (const btn of $$(".copy")) {
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = "复制"), 1400);
    } catch {}
  });
}

const typed = $("#typed");
if (typed && !reduced) {
  const text = typed.dataset.text;
  typed.textContent = "";
  new IntersectionObserver((entries, obs) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    obs.disconnect();
    let i = 0;
    const step = () => {
      typed.textContent = text.slice(0, ++i);
      if (i < text.length) setTimeout(step, 70 + Math.random() * 80);
    };
    setTimeout(step, 400);
  }, { threshold: 0.6 }).observe(typed);
}
