// The console's shell: sign-in, navigation, and a hash router that mounts one view at a time.
//   #/setup  #/overview  #/chats  #/chat/<chat>/<tab>  #/config/<group>  #/log
import { api } from "./api.js";
import { action, fill, h, toast } from "./dom.js";
import { renderChat } from "./view-chat.js";
import { renderChats } from "./view-chats.js";
import { renderConfig } from "./view-config.js";
import { renderLog } from "./view-log.js";
import { renderOverview } from "./view-overview.js";
import { renderSetup, setupProgress } from "./view-setup.js";

const root = document.getElementById("app");

/** Shared by the views: the setup status, refreshed after changes. */
const app = {
  status: null,
  async refreshStatus() {
    app.status = await api.get("status");
    if (app.status.autoImported?.length) {
      toast(`已把 ${app.status.autoImported.length} 个环境变量导入数据库，以后在这里改配置`);
    }
    renderNav();
    return app.status;
  },
  go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  },
};

const VIEWS = {
  setup: renderSetup,
  overview: renderOverview,
  chats: renderChats,
  chat: renderChat,
  config: renderConfig,
  log: renderLog,
};

let nav;
let main;
let stopView;

function navLink(hash, label, badge) {
  const active = location.hash.startsWith(hash) || (hash === "#/chats" && location.hash.startsWith("#/chat/"));
  return h("a", { href: hash, class: active ? "on" : "" }, h("span", null, label), badge ? h("span", { class: "badge" }, badge) : null);
}

function renderNav() {
  if (!nav || !app.status) return;
  const progress = setupProgress(app.status);
  fill(
    nav,
    h("div", { class: "brand" }, h("img", { src: "/admin/icon.svg", alt: "" }), "大肥鱼管理端"),
    progress.done < progress.total ? navLink("#/setup", "新手引导", `${progress.done}/${progress.total}`) : null,
    navLink("#/overview", "总览"),
    navLink("#/chats", "聊天"),
    navLink("#/config", "配置"),
    navLink("#/log", "操作记录"),
    progress.done >= progress.total ? navLink("#/setup", "引导与检查") : null,
    h("div", { class: "nav-foot" }, action("退出登录", async () => {
      await api.del("session");
      start();
    })),
  );
}

async function route() {
  if (!main) return;
  stopView?.();
  stopView = undefined;
  const [name = "", ...args] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const view = VIEWS[name];
  if (!view) {
    const progress = setupProgress(app.status);
    location.replace(progress.required ? "#/setup" : "#/overview");
    return;
  }
  renderNav();
  fill(main, h("p", { class: "muted" }, "加载中…"));
  try {
    const stop = await view(main, args, app);
    stopView = typeof stop === "function" ? stop : undefined;
  } catch (err) {
    fill(main, h("div", { class: "banner banner-bad" }, `加载失败：${err.message}`));
  }
  main.focus({ preventScroll: true });
}

function renderShell() {
  nav = h("nav", { class: "nav" });
  main = h("main", { class: "main", tabindex: "-1" });
  fill(root, h("div", { class: "shell" }, nav, main));
  renderNav();
  route();
}

function renderNoPassword() {
  fill(
    root,
    h(
      "div",
      { class: "gate" },
      h("h1", null, "先设一个管理密码"),
      h("p", null, "管理端用环境变量 ADMIN_PASSWORD 保护，它也用来加密存进数据库的各种 key。这是唯一需要在 Vercel 里手动设置的变量："),
      h(
        "ol",
        null,
        h("li", null, "打开 Vercel 项目的 Settings → Environment Variables。"),
        h("li", null, "添加 ADMIN_PASSWORD，值是一个足够长的密码。"),
        h("li", null, "在 Deployments 页面对最新部署点 Redeploy，然后刷新这个页面。"),
      ),
      h("p", { class: "muted" }, "其余配置都能在这个页面里填，改了不用重新部署。"),
    ),
  );
}

function renderLogin() {
  const input = h("input", { id: "password", type: "password", autocomplete: "current-password", required: true });
  const error = h("p", { class: "field-error", hidden: true });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "登录");
  const form = h(
    "form",
    {
      class: "gate",
      async onSubmit(e) {
        e.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        try {
          await api.post("session", { password: input.value });
          await start();
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h("h1", null, "大肥鱼管理端"),
    h("div", { class: "field" }, h("label", { for: "password" }, "管理密码"), input, error),
    submit,
  );
  fill(root, form);
  input.focus();
}

async function start() {
  nav = main = undefined;
  stopView?.();
  const session = await api.get("session");
  if (!session.passwordSet) return renderNoPassword();
  if (!session.loggedIn) return renderLogin();
  await app.refreshStatus();
  renderShell();
}

window.addEventListener("hashchange", route);
window.addEventListener("admin:signed-out", () => {
  toast("登录已过期，请重新登录", "warn");
  start();
});
start().catch((err) => fill(root, h("div", { class: "gate" }, h("h1", null, "打不开管理端"), h("p", null, err.message))));
