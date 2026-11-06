// Every setting, by group (#/config/<group>), with each group's checks.
import { api } from "./api.js";
import { action, copyable, fill, h, pill, toast } from "./dom.js";
import { groupActions, loadSettings, settingsForm } from "./form.js";

export async function renderConfig(main, [groupId], app) {
  const [index, status] = [await loadSettings(), app.status ?? (await app.refreshStatus())];
  const group = index.groups.find((g) => g.id === groupId) ?? index.groups[0];
  const channel = group.channel ? status.channels.find((c) => c.name === group.channel) : undefined;
  const slot = h("p", { class: "check-result" });
  const form = settingsForm(index, index.keysOf(group.id), {
    onSaved: async () => {
      await app.refreshStatus();
      app.go(`#/config/${group.id}`);
    },
    actions: (f) => groupActions(index, group, status, f, slot),
  });

  fill(
    main,
    h("header", { class: "page-head" }, h("h1", null, "配置"), h("p", { class: "muted" }, "保存后 30 秒内所有实例生效，不用重新部署。密钥只能替换，不能查看。")),
    h(
      "div",
      { class: "config" },
      h(
        "nav",
        { class: "subnav" },
        index.groups.map((g) => h("a", { href: `#/config/${g.id}`, class: g === group ? "on" : "" }, g.label)),
      ),
      h(
        "section",
        { class: "panel" },
        h("h2", null, group.label, " ", channel ? (channel.configured ? pill("ok", "已配置") : pill("mute", "未配置")) : null),
        h("p", { class: "muted" }, group.help),
        channel ? h("p", null, "回调地址：", copyable(channel.webhook)) : null,
        form.el,
        slot,
        group.id === "console" ? databaseCard(status, app) : null,
      ),
    ),
  );
}

function databaseCard(status, app) {
  const db = status.database;
  return h(
    "div",
    { class: "card" },
    h("h3", null, "数据库"),
    h(
      "p",
      null,
      db.backend === "supabase" ? `Supabase，表结构 v${db.schemaVersion ?? "无"}（代码需要 v${db.expected}）` : "内存（只适合本地开发）",
      " ",
      db.ready ? pill("ok", "已就绪") : pill("warn", "需要升级"),
    ),
    db.backend === "supabase" && db.connectionVar
      ? action("重新执行 schema.sql", async () => {
          await api.post("setup/database");
          toast("已执行");
          await app.refreshStatus();
          app.go("#/config/console");
        })
      : null,
  );
}
