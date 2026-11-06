// Settings forms, built from the catalog the server sends (src/settings/catalog.ts):
// one input per setting, a pill saying where its value comes from, and a save that
// sends only what changed.
import { api, ApiError } from "./api.js";
import { action, copyable, fill, h, pill, toast } from "./dom.js";

const SOURCES = {
  db: ["info", "数据库"],
  env: ["warn", "环境变量"],
  default: ["mute", "默认值"],
};

/** GET settings, indexed by key. */
export async function loadSettings() {
  const data = await api.get("settings");
  return {
    groups: data.groups,
    defs: new Map(data.settings.map((d) => [d.key, d])),
    values: new Map(data.values.map((v) => [v.key, v])),
    keysOf: (group) => data.settings.filter((d) => d.group === group).map((d) => d.key),
  };
}

/** The editor for a secret: shows the masked value, "替换" opens an input. */
function secretEditor(def, view, id) {
  const input = h("input", { id, type: "password", autocomplete: "off", spellcheck: "false", placeholder: `新的 ${def.label}` });
  const box = h("div", { class: "secret" });
  let mode = view.value ? "keep" : "edit";
  const render = () => {
    if (mode === "edit") return fill(box, input);
    if (mode === "clear") return fill(box, h("span", { class: "muted" }, "保存后清除"), h("button", { type: "button", class: "btn btn-small", onClick: () => ((mode = "keep"), render()) }, "撤销"));
    return fill(
      box,
      h("code", { class: "secret-value" }, view.value),
      h("button", { type: "button", class: "btn btn-small", onClick: () => ((mode = "edit"), render(), input.focus()) }, "替换"),
      view.source === "db" ? h("button", { type: "button", class: "btn btn-small", onClick: () => ((mode = "clear"), render()) }, "清除") : null,
    );
  };
  render();
  return {
    el: box,
    value: () => (mode === "clear" ? null : mode === "edit" && input.value.trim() ? input.value.trim() : undefined),
  };
}

function plainEditor(def, view, id) {
  const initial = view.value ?? "";
  let el;
  if (def.kind === "enum") {
    el = h("select", { id }, def.options.map((o) => h("option", { value: o.value, selected: o.value === initial }, o.label)));
  } else if (def.kind === "json" || def.kind === "textarea") {
    el = h("textarea", { id, rows: def.kind === "json" ? 3 : 4, spellcheck: "false", class: def.kind === "json" ? "mono" : "" });
    el.value = initial;
  } else {
    const numeric = def.kind === "int" || def.kind === "number";
    el = h("input", { id, type: "text", value: initial, spellcheck: "false", inputmode: numeric ? "decimal" : null, class: def.kind === "url" ? "mono" : "" });
  }
  return {
    el,
    value() {
      const now = el.value.trim();
      if (now === initial.trim()) return undefined;
      return now === "" ? null : now;
    },
  };
}

/** One setting: label, where it comes from, the editor, help and an error slot. */
function settingField(def, view) {
  const id = `setting-${def.key}`;
  const editor = def.kind === "secret" ? secretEditor(def, view, id) : plainEditor(def, view, id);
  const [kind, text] = SOURCES[view.source];
  const error = h("p", { class: "field-error", hidden: true });
  const el = h(
    "div",
    { class: "field" },
    h("label", { for: id }, def.label, " ", pill(kind, text)),
    editor.el,
    def.help ? h("p", { class: "help" }, def.help) : null,
    h("p", { class: "help mono" }, def.key),
    error,
  );
  return {
    key: def.key,
    el,
    value: editor.value,
    showError(message) {
      error.hidden = !message;
      error.textContent = message ?? "";
    },
  };
}

/**
 * A form for some settings; "保存" sends only the changed ones. `actions(form)`
 * returns what goes beside the button (checks that save the form first);
 * `onSaved` runs after a save.
 */
export function settingsForm(index, keys, { onSaved, actions, saveLabel = "保存" } = {}) {
  const fields = keys.filter((k) => index.defs.has(k)).map((k) => settingField(index.defs.get(k), index.values.get(k)));
  const save = async () => {
    const changes = {};
    for (const f of fields) {
      f.showError(null);
      const value = f.value();
      if (value !== undefined) changes[f.key] = value;
    }
    if (!Object.keys(changes).length) return false;
    try {
      await api.put("settings", { changes });
    } catch (err) {
      if (err instanceof ApiError) for (const f of fields) if (err.fields[f.key]) f.showError(err.fields[f.key]);
      throw err;
    }
    toast("已保存");
    await onSaved?.();
    return true;
  };
  const el = h(
    "form",
    { class: "settings-form", onSubmit: (e) => e.preventDefault() },
    h("div", { class: "fields" }, fields.map((f) => f.el)),
    h("div", { class: "row" }, action(saveLabel, async () => (await save()) || toast("没有改动", "mute"), { primary: true })),
  );
  const form = { el, save };
  el.querySelector(".row").append(...[actions?.(form)].flat().filter(Boolean));
  return form;
}

/** A check's result line ({ok, message, ms}). */
export function checkResult(slot, result) {
  fill(slot, pill(result.ok ? "ok" : "bad", result.ok ? "通过" : "失败"), " ", result.message, result.ms ? h("span", { class: "muted" }, ` · ${(result.ms / 1000).toFixed(1)} 秒`) : null);
}

/** A button that runs a check (POST path) and shows its result next to it. */
function checkButton(label, path, before) {
  const slot = h("span", { class: "check-result" });
  const btn = action(label, async () => {
    fill(slot, h("span", { class: "muted" }, "检查中…"));
    if (before) await before();
    checkResult(slot, await api.post(path));
  });
  return h("span", { class: "check" }, btn, slot);
}

/** The check a settings group offers, by group id (src/settings/catalog.ts): [label, API path]. */
const GROUP_CHECKS = { llm: ["测试", "checks/model"], search: ["查余额", "checks/search"] };

/**
 * What goes beside a group's save button: its check, its channel's verify and
 * connect (which save the form first, so they use what was typed), and
 * "生成" for each secret the console can make up (shown once, in `slot`; none without one).
 */
export function groupActions(index, group, status, form, slot) {
  const items = [];
  const check = GROUP_CHECKS[group.id];
  if (check) items.push(checkButton(check[0], check[1], () => form.save()));
  const channel = group.channel ? status.channels.find((c) => c.name === group.channel) : undefined;
  if (channel?.canVerify) items.push(checkButton("检查", `channels/${channel.name}/verify`, () => form.save()));
  if (channel?.canConnect) items.push(checkButton("保存并设置 Webhook", `channels/${channel.name}/connect`, () => form.save()));
  if (!slot) return items;
  for (const key of index.keysOf(group.id).filter((k) => index.defs.get(k).generate)) {
    const { label } = index.defs.get(key);
    items.push(
      action(`生成 ${label}`, async () => {
        const { value } = await api.post("settings/generate", { key });
        fill(slot, `新的 ${label}（只显示这一次）：`, copyable(value));
      }),
    );
  }
  return items;
}
