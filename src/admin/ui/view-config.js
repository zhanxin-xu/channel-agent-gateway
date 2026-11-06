// Every setting, by group (#/config/<group>), with each group's checks.
import { api } from "./api.js";
import { action, copyable, fill, h, pill, toast } from "./dom.js";
import { checkButton, loadSettings, settingsForm } from "./form.js";

/** Checks and actions shown beside a group's save button. `form` saves first where a check should use what was typed. */
function groupActions(group, form, status, slot) {
  const channel = status.channels.find((c) => c.name === group);
  if (group === "llm") return checkButton("测试", "checks/model", () => form.save());
  if (group === "search") return checkButton("查余额", "checks/search", () => form.save());
  if (channel) {
    return [
      channel.canVerify ? checkButton("检查", `channels/${group}/verify`, () => form.save()) : null,
      channel.canConnect ? checkButton("设置 Webhook", `channels/${group}/connect`, () => form.save()) : null,
      group === "http"
        ? action("生成新 Token", async () => {
            const { value } = await api.post("settings/generate", { key: "HTTP_CHANNEL_TOKEN" });
            fill(slot, "新的 Token（只显示这一次）：", copyable(value));
          })
        : null,
    ];
  }
  return null;
}

export async function renderConfig(main, [groupId], app) {
  const [index, status] = [await loadSettings(), app.status ?? (await app.refreshStatus())];
  const group = index.groups.find((g) => g.id === groupId) ?? index.groups[0];
  const channel = status.channels.find((c) => c.name === group.id);
  const slot = h("p", { class: "check-result" });
  const form = settingsForm(index, index.keysOf(group.id), {
    onSaved: async () => {
      await app.refreshStatus();
      app.go(`#/config/${group.id}`);
    },
  });
  form.el.querySelector(".row")?.append(...[groupActions(group.id, form, status, slot)].flat().filter(Boolean));

  const envCount = index.keysOf(group.id).filter((k) => index.values.get(k).source === "env").length;
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
        envCount
          ? h("div", { class: "banner banner-info" }, h("span", null, `这一组有 ${envCount} 项来自环境变量。`), action("把环境变量导入数据库", async () => {
              const { saved } = await api.post("settings/import-env");
              toast(`导入了 ${saved.length} 个设置`);
              app.go(`#/config/${group.id}`);
            }))
          : null,
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
