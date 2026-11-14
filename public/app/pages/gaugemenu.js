// Gauge settings (vendor pages/gaugeMenu, title 手机仪表设置). Phone-side only: nothing goes to the module.
// The settings live in localStorage["tsl6.gauge"] as {id: value}. normalizeGaugePrefs() cleans them.
import { h, L, clear, row, section, picker, btn, toast, confirmBox } from "../ui.js";
import { definePage } from "../app.js";
import { GAUGE_MENU, normalizeGaugePrefs } from "../../lib/tsl6-gauge.js";

export const GAUGE_KEY = "tsl6.gauge";

export function loadGaugePrefs() {
  try { return normalizeGaugePrefs(JSON.parse(localStorage.getItem(GAUGE_KEY) || "null")); }
  catch { return normalizeGaugePrefs(null); }
}
// Write the whole object at once, as the vendor does. Returns false if the storage is blocked.
export function saveGaugePrefs(p) {
  try { localStorage.setItem(GAUGE_KEY, JSON.stringify(normalizeGaugePrefs(p))); return true; } catch { return false; }
}
function resetGaugePrefs() {
  try { localStorage.removeItem(GAUGE_KEY); return true; } catch { return false; }
}

definePage("gaugemenu", () => {
  const el = h("div", { class: "page" });

  function render() {
    clear(el);
    const p = loadGaugePrefs();
    const rows = GAUGE_MENU.map(m => {
      const label = { en: m.label, zh: m.zh };
      return row(label, { help: "help_" + m.id, helpTitle: label },
        picker({
          value: p[m.id], label: L(label),
          options: m.options.map(([v, en, zh]) => [v, L(en, zh)]),
          onchange: v => {
            const q = loadGaugePrefs();
            q[m.id] = v;
            if (!saveGaugePrefs(q)) toast(L("Could not save: the browser blocks storage.", "无法保存：浏览器禁止存储"), "bad", 3000);
          },
        }));
    });
    const reset = h("div", { class: "row", style: { justifyContent: "center" } },
      btn({ en: "Restore defaults", zh: "恢复默认" }, onReset, { kind: "small", color: "#F6931F" }));
    el.append(section(null, rows, reset));
    el.append(h("p", { class: "foot" }, L(
      "These settings stay on this phone. Nothing goes to the module.",
      "以上设置仅保存在本机，不会发送到模块。")));
  }

  async function onReset() {
    if (!(await confirmBox(L("Reset the gauge settings to the defaults?", "确定要将\"仪表设置\"恢复默认吗？")))) return;
    resetGaugePrefs();
    toast(L("Done", "操作成功"), "ok");
    render();
  }

  render();
  return { el, title: { en: "Gauge settings", zh: "手机仪表设置" }, refresh: render };
});
