// The setup guide: from nothing configured to the first message, one step at a time.
// Steps are derived from GET status, so the guide also works as a checklist later.
import { api } from "./api.js";
import { action, copy, copyable, every, fill, h, pill, toast } from "./dom.js";
import { checkButton, checkResult, loadSettings, settingsForm } from "./form.js";

const SKIP_KEY = "admin.setup.skipFeatures";
const skippedFeatures = () => {
  try {
    return localStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
};

function steps(s) {
  return [
    { id: "password", title: "管理密码", done: true },
    { id: "database", title: "数据库", done: s.database.backend === "supabase" && s.database.ready },
    { id: "model", title: "模型", done: s.model },
    { id: "channels", title: "接入渠道", done: s.channels.some((c) => c.configured) },
    { id: "features", title: "画图、语音、搜索、记忆", optional: true, done: Object.values(s.features).some(Boolean) || skippedFeatures() },
    { id: "first", title: "发条消息试试", done: s.firstMessage },
  ];
}

/** How far setup is: steps done, and whether a required one is missing. */
export function setupProgress(status) {
  if (!status) return { done: 0, total: 6, required: true };
  const all = steps(status);
  return { done: all.filter((s) => s.done).length, total: all.length, required: all.some((s) => !s.done && !s.optional) };
}

const FEATURE_CARDS = [
  { group: "image", keys: ["IMAGE_API_KEY"], status: "image", note: "画图还需要沙盒开着。" },
  { group: "tts", keys: ["TTS_API_KEY"], status: "tts" },
  { group: "search", keys: ["DEEPSEEK_API_KEY"], status: "search", check: "checks/search" },
  { group: "memory", keys: ["UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN"], status: "memory" },
  { group: "sandbox", keys: ["SANDBOX_ENABLED"], status: "sandbox" },
];

export async function renderSetup(main, [stepId], app) {
  const status = await app.refreshStatus();
  const all = steps(status);
  const current = all.find((s) => s.id === stepId) ?? all.find((s) => !s.done) ?? all.at(-1);
  const panel = h("section", { class: "panel" });
  const next = () => {
    const after = all[all.indexOf(current) + 1];
    app.go(after ? `#/setup/${after.id}` : "#/overview");
  };

  fill(
    main,
    h("header", { class: "page-head" }, h("h1", null, "新手引导"), h("p", { class: "muted" }, "从零配置到收到第一条消息。每一步都可以回来改，配置页里有全部选项。")),
    await banners(status, app),
    h(
      "div",
      { class: "setup" },
      h(
        "ol",
        { class: "steps" },
        all.map((s, i) =>
          h(
            "li",
            null,
            h(
              "a",
              { href: `#/setup/${s.id}`, class: `step${s.done ? " done" : ""}${s === current ? " now" : ""}` },
              h("span", { class: "dot" }, s.done ? "✓" : String(i + 1)),
              h("span", null, s.title),
              s.optional ? h("span", { class: "opt" }, "可跳过") : null,
            ),
          ),
        ),
      ),
      panel,
    ),
  );
  return STEP_VIEWS[current.id](panel, status, app, next);
}

async function banners(status, app) {
  const items = [];
  if (status.envOnly.length) {
    items.push(
      h(
        "div",
        { class: "banner banner-info" },
        h("span", null, `有 ${status.envOnly.length} 个设置还在用环境变量（${status.envOnly.slice(0, 4).join("、")}${status.envOnly.length > 4 ? "…" : ""}）。导入数据库后就能在这里改，Vercel 里的可以删掉。`),
        action("导入到数据库", async () => {
          const { saved } = await api.post("settings/import-env");
          toast(`导入了 ${saved.length} 个设置`);
          app.go(location.hash);
        }, { primary: true }),
      ),
    );
  }
  if (status.undecryptable.length) {
    const input = h("input", { id: "old-password", type: "password", autocomplete: "off", placeholder: "旧的 ADMIN_PASSWORD" });
    items.push(
      h(
        "div",
        { class: "banner banner-warn" },
        h("span", null, `${status.undecryptable.length} 个密钥是用旧的管理密码加密的，现在读不出来，暂时用的是环境变量里的值。输入旧密码重新加密：`),
        h("span", { class: "row" }, input, action("重新加密", async () => {
          const { reencrypted } = await api.post("settings/rekey", { oldPassword: input.value });
          toast(`重新加密了 ${reencrypted} 个密钥`);
          app.go(location.hash);
        }, { primary: true })),
      ),
    );
  }
  return items;
}

const STEP_VIEWS = {
  password(panel, _status, _app, next) {
    fill(
      panel,
      h("h2", null, "管理密码"),
      h("p", null, pill("ok", "已设置"), " 你已经用它登录了。"),
      h("p", { class: "muted" }, "要换密码：在 Vercel 改 ADMIN_PASSWORD 并重新部署，再回到这里用旧密码把已存的密钥重新加密（页面顶部会提示）。"),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-primary", onClick: next }, "下一步")),
    );
  },

  async database(panel, status, app, next) {
    const db = status.database;
    if (db.backend !== "supabase") {
      return fill(
        panel,
        h("h2", null, "连接数据库"),
        h("p", null, "聊天记录、设置和密钥都存在 Supabase（免费版就够）。现在还没连上，数据只在这个实例的内存里，重启就没了，只适合本地开发。"),
        h(
          "ol",
          null,
          h("li", null, "打开 Vercel 项目的 Storage 页面，添加 Supabase：套餐选 Free，区域选 Singapore。"),
          h("li", null, "把它连接到这个项目，Vercel 会自动注入 SUPABASE_URL、SUPABASE_SECRET_KEY 和数据库直连地址。"),
          h("li", null, "在 Deployments 页面 Redeploy，然后回到这一步。"),
        ),
      );
    }
    if (db.ready) {
      return fill(
        panel,
        h("h2", null, "数据库"),
        h("p", null, pill("ok", "已就绪"), ` Supabase，表结构 v${db.schemaVersion}。`),
        h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-primary", onClick: next }, "下一步")),
      );
    }
    const upgrade = db.schemaVersion !== null;
    const result = h("p", { class: "check-result" });
    const runIt = action(upgrade ? `升级到 v${db.expected}` : "建表", async () => {
      fill(result, h("span", { class: "muted" }, "执行中…"));
      try {
        await api.post("setup/database");
      } catch (err) {
        checkResult(result, { ok: false, message: err.message });
        return;
      }
      toast("数据库已就绪");
      await app.refreshStatus();
      app.go("#/setup/database");
    }, { primary: true });
    const manual = h("details", { class: "manual" });
    manual.addEventListener("toggle", async () => {
      if (!manual.open || manual.dataset.loaded) return;
      manual.dataset.loaded = "1";
      const { sql } = await api.get("setup/schema");
      const pre = h("pre", { class: "sql" }, sql);
      manual.append(
        h("p", null, "打开 Supabase 控制台的 SQL Editor，粘贴下面的 SQL 执行，再回来点“检测”。"),
        h("div", { class: "row" }, h("button", { type: "button", class: "btn", onClick: () => copy(sql, pre) }, "复制 SQL"), action("检测", async () => {
          await app.refreshStatus();
          app.go("#/setup/database");
        })),
        pre,
      );
    });
    manual.append(h("summary", null, "手动执行 SQL"));
    return fill(
      panel,
      h("h2", null, upgrade ? "升级数据库" : "创建数据表"),
      h("p", null, upgrade ? `数据库的表结构是 v${db.schemaVersion}，这个版本的代码需要 v${db.expected}。升级不会删数据，机器人在升级前后都能照常工作。` : "Supabase 已经连上，还需要建表。"),
      db.connectionVar
        ? h("div", null, h("p", { class: "muted" }, `会用 ${db.connectionVar} 直接执行 supabase/schema.sql，可以重复执行。`), h("div", { class: "row" }, runIt), result)
        : h("p", { class: "muted" }, "没有找到数据库直连地址（POSTGRES_URL_NON_POOLING），只能手动执行。"),
      manual,
    );
  },

  async model(panel, status, app, next) {
    if (!requireDb(panel, status)) return;
    const index = await loadSettings();
    const form = settingsForm(index, ["OPENAI_RESPONSES_BASE_URL", "OPENAI_RESPONSES_API_KEY", "OPENAI_RESPONSES_MODEL"], {
      onSaved: () => app.refreshStatus(),
      extra: checkButton("测试", "checks/model", () => form.save()),
    });
    fill(
      panel,
      h("h2", null, "模型"),
      h("p", { class: "muted" }, "任何兼容 OpenAI Responses API 的服务都行，默认 OpenRouter。“测试”会先保存，再真的发一次请求。"),
      form.el,
      h("div", { class: "row" }, h("button", { type: "button", class: "btn", onClick: next, disabled: !status.model }, "下一步")),
    );
  },

  async channels(panel, status, app, next) {
    if (!requireDb(panel, status)) return;
    const index = await loadSettings();
    const refresh = async () => {
      await app.refreshStatus();
      app.go("#/setup/channels");
    };
    const card = (channel) => {
      const group = index.groups.find((g) => g.id === channel.name);
      const tokenSlot = h("p", { class: "check-result" });
      const extra = [
        channel.canVerify ? checkButton("检查", `channels/${channel.name}/verify`) : null,
        channel.canConnect
          ? checkButton("保存并设置 Webhook", `channels/${channel.name}/connect`, () => form.save())
          : null,
        channel.name === "http"
          ? action("生成 Token", async () => {
              const { value } = await api.post("settings/generate", { key: "HTTP_CHANNEL_TOKEN" });
              fill(tokenSlot, "新的 Token（只显示这一次）：", copyable(value));
              await app.refreshStatus();
            })
          : null,
      ];
      const keys = index.keysOf(channel.name).filter((k) => !(channel.canConnect && k !== "TELEGRAM_BOT_TOKEN"));
      const form = settingsForm(index, keys, { onSaved: refresh, extra });
      return h(
        "div",
        { class: "card" },
        h("h3", null, group?.label ?? channel.name, " ", channel.configured ? pill("ok", "已配置") : pill("mute", "未配置")),
        group ? h("p", { class: "muted" }, group.help) : null,
        h("p", null, "回调地址：", copyable(channel.webhook)),
        channel.name === "qq" ? h("p", { class: "help" }, "在 QQ 开放平台把这个地址填进回调配置。大陆的 QQ 服务器访问不了 *.vercel.app，必须先绑定自定义域名。") : null,
        form.el,
        tokenSlot,
      );
    };
    fill(
      panel,
      h("h2", null, "接入渠道"),
      h("p", { class: "muted" }, "至少接一个。改完立即生效，不用重新部署。"),
      status.channels.map(card),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn", onClick: next, disabled: !status.channels.some((c) => c.configured) }, "下一步")),
    );
  },

  async features(panel, status, app, next) {
    if (!requireDb(panel, status)) return;
    const index = await loadSettings();
    fill(
      panel,
      h("h2", null, "可选能力"),
      h("p", { class: "muted" }, "都可以跳过，以后在配置页再开。这里只填最少的，其余参数在配置页。"),
      FEATURE_CARDS.map((f) => {
        const group = index.groups.find((g) => g.id === f.group);
        const form = settingsForm(index, f.keys, { onSaved: () => app.refreshStatus(), extra: f.check ? checkButton("检查", f.check) : null });
        return h(
          "div",
          { class: "card" },
          h("h3", null, group.label, " ", status.features[f.status] ? pill("ok", "已开启") : pill("mute", "未开启")),
          h("p", { class: "muted" }, group.help, f.note ? ` ${f.note}` : ""),
          form.el,
        );
      }),
      h(
        "div",
        { class: "row" },
        h("button", {
          type: "button",
          class: "btn btn-primary",
          onClick() {
            try {
              localStorage.setItem(SKIP_KEY, "1");
            } catch {}
            app.refreshStatus().then(next);
          },
        }, "好了，下一步"),
      ),
    );
  },

  first(panel, status, app) {
    const render = (s) =>
      fill(
        panel,
        h("h2", null, "发条消息试试"),
        s.firstMessage
          ? [
              h("p", null, pill("ok", "收到了"), " 机器人已经收到消息。可以在聊天页看记录和事件，或者去总览看看。"),
              h("div", { class: "row" }, h("a", { class: "btn btn-primary", href: "#/chats" }, "去看聊天"), h("a", { class: "btn", href: "#/overview" }, "总览")),
            ]
          : [
              h("p", null, "在接好的渠道里给机器人发条消息：私聊它，或者在群里 @ 它。收到以后这里会自动打勾。"),
              h("p", { class: "muted" }, "等待第一条消息…"),
            ],
      );
    render(status);
    if (status.firstMessage) return;
    return every(5000, async () => {
      const s = await app.refreshStatus();
      render(s);
    });
  },
};

/** Settings need the database; the in-memory store (local development) works too, for this instance. */
function requireDb(panel, status) {
  if (status.database.ready) return true;
  fill(panel, h("p", null, "先完成上一步“数据库”：设置要存进数据库。"), h("a", { class: "btn btn-primary", href: "#/setup/database" }, "去连接数据库"));
  return false;
}
