// DOM helpers: every element is built with h(), and text always goes in as text,
// never as HTML: chat messages and settings come from people outside.

/** h("div", {class: "x", onClick: fn}, child, "text", [more]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    // Through the CSSOM: the page's CSP doesn't allow style attributes.
    else if (key === "style") el.style.cssText = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value" || key === "checked" || key === "disabled" || key === "selected") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

/** Replace an element's children. */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const pill = (kind, text) => h("span", { class: `pill pill-${kind}` }, text);

const pad = (n) => String(n).padStart(2, "0");

/** "11/06 15:03" in the viewer's time zone. */
export function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "刚刚", "3 分钟前", "2 天前". */
export function fmtAgo(ms) {
  if (!ms) return "—";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const num = (n) => Number(n) || 0;
export const fmtUsd = (n) => `$${num(n).toFixed(num(n) < 1 ? 3 : 2)}`;
export const fmtInt = (n) => num(n).toLocaleString("zh-CN");
export const fmtTokens = (n) => (num(n) >= 1000 ? `${(num(n) / 1000).toFixed(1)}k` : String(num(n)));

/** A small transient message at the bottom of the screen. */
export function toast(message, kind = "ok") {
  const el = h("div", { class: `toast toast-${kind}`, role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.classList.add("toast-out"), 2600);
  setTimeout(() => el.replaceWith(), 3000);
}

/** Copy text, falling back to selecting it. */
export async function copy(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    if (el) getSelection()?.selectAllChildren(el);
  }
}

/** A value with a copy button. */
export const copyable = (text) => {
  const value = h("code", { class: "copy-value" }, text);
  return h("span", { class: "copyable" }, value, h("button", { type: "button", class: "btn btn-small", onClick: () => copy(text, value) }, "复制"));
};

/** A button that runs `fn`, disabled while it does, and reports failures. */
export function action(label, fn, opts = {}) {
  const btn = h("button", { type: "button", class: `btn${opts.primary ? " btn-primary" : ""}${opts.danger ? " btn-danger" : ""}` }, label);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await fn(btn);
    } catch (err) {
      toast(err.message ?? String(err), "bad");
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * A button that asks again in place before something hard to undo:
 * the first click shows the question, "确定" runs `fn`.
 */
export function confirmAction(label, question, fn) {
  const wrap = h("span", { class: "confirm" });
  const reset = () => fill(wrap, h("button", { type: "button", class: "btn", onClick: ask }, label));
  function ask() {
    fill(
      wrap,
      h("span", { class: "muted" }, question),
      action("确定", async () => {
        await fn();
        reset();
      }, { danger: true }),
      h("button", { type: "button", class: "btn", onClick: reset }, "取消"),
    );
  }
  reset();
  return wrap;
}

/** Run `fn` every `ms` while the page is visible; returns a stop function. */
export function every(ms, fn) {
  const id = setInterval(() => {
    if (document.visibilityState === "visible") Promise.resolve(fn()).catch(() => {});
  }, ms);
  return () => clearInterval(id);
}
