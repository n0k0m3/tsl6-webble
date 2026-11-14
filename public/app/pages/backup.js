// Backup and restore (vendor pages/backup, 备份恢复). The vendor keeps 3 blocks on its server.
// This page keeps them in a local JSON file instead (codec makeBackup / readBackup / restorePlan):
//   1. settings page data (A0 status, restored with A3)  2. shortcut data (AB)  3. BLE button data (BA)
// Back up reads the blocks and downloads the file. Restore reads a file, shows what it writes,
// asks, then writes each block and checks the echo (at most one resend).
import { h, L, clear, btn, toast, dialog, alertBox, download, pickFile } from "../ui.js";
import { S, definePage, onBus, gate, ask, rereadSoon, log } from "../app.js";
import { makeBackup, readBackup, restorePlan, decodeShortcuts, decodeBleButtons, vendorBleId, parseHex, CMD } from "../../lib/tsl6-tables.js";
import { writeBlocker } from "../../lib/tsl6-settings.js";
import { linkState, linkStateText, readTable, isTableReply, loadTablesCss, bleNames, bleKey, setBleName } from "../tableio.js";

const BLOCKS = [
  { key: "settings", en: "Settings page data", zh: "设置页面数据" },
  { key: "shortcuts", en: "Shortcut data", zh: "快捷指令数据" },
  { key: "bleButtons", en: "BLE button data", zh: "蓝牙按钮数据" },
];
const blockName = k => L(BLOCKS.find(b => b.key === k));

const SEL_KEY = "tsl6.backup.sel", TIME_KEY = "tsl6.backup.time";
function loadJson(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } }
function saveJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } }

const blankStatus = p => { for (let i = 18; i < 40; i++) if (p[i] !== 0) return false; return true; };
const stamp = d => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

definePage("backup", () => {
  loadTablesCss();
  const el = h("div", { class: "page tbl-page" });
  const sel = new Set(loadJson(SEL_KEY, BLOCKS.map(b => b.key)).filter(k => BLOCKS.some(b => b.key === k)));
  let busy = false, entered = false;
  const offs = [];

  function ready() {
    const st = linkState();
    if (st !== "ok") { toast(linkStateText(st), "warn"); return false; }
    return true;
  }

  // ---------------------------------------------------------------- back up
  async function readBlock(key) {
    if (key === "settings") {
      const p = await S.link.readStatus().catch(() => null);
      if (!p) return { error: L("no reply", "无应答") };
      if (blankStatus(p)) return { error: L("the status is blank (password missing)", "状态为空（未输入密码）") };
      return { data: Uint8Array.from(p) };
    }
    const t = await readTable(key === "shortcuts" ? CMD.SHORTCUTS : CMD.BLE_BUTTONS);
    return t ? { data: t } : { error: L("no reply", "无应答") };
  }

  async function backup(keys) {
    if (busy || !keys.length || !ready()) return;
    busy = true; render();
    try {
      const got = {}, errs = [];
      for (const k of keys) {
        const r = await readBlock(k);
        if (r.data) got[k] = r.data; else errs.push(`${blockName(k)}: ${r.error}`);
      }
      if (!Object.keys(got).length) { await alertBox(L("Nothing was read. No file was saved.\n", "未读取到数据，未保存文件。\n") + errs.join("\n")); return; }
      if (errs.length && !(await ask2(L("Some blocks were not read:\n", "部分数据未读取：\n") + errs.join("\n") + L("\n\nSave a file with the other blocks?", "\n\n是否只保存已读取的数据？")))) return;
      // Button names, by idHex (the file format), from this browser's storage (keys "id<n>").
      const names = {};
      if (got.bleButtons) {
        const store = bleNames();
        for (const b of decodeBleButtons(got.bleButtons)) if (store[bleKey(b.id)]) names[b.idHex] = store[bleKey(b.id)];
      }
      let obj;
      try { obj = makeBackup({ settings: got.settings || null, shortcuts: got.shortcuts || null, bleButtons: got.bleButtons || null, bleNames: names }); }
      catch (e) { await alertBox(L("The backup was not made: ", "备份失败：") + e.message); return; }
      const now = new Date();
      download(`tsl6-backup-${stamp(now)}.json`, JSON.stringify(obj, null, 2));
      const times = loadJson(TIME_KEY, {});
      for (const k of Object.keys(got)) times[k] = now.toISOString();
      saveJson(TIME_KEY, times);
      toast(L("Backup file saved", "备份文件已保存"), "ok");
    } finally { busy = false; render(); }
  }
  const ask2 = text => dialog({ title: L("Notice", "提示"), body: text,
    buttons: [{ label: L("Cancel", "取消"), value: false }, { label: L("Save", "保存"), value: true, kind: "primary" }] }).then(v => v === true);

  // ---------------------------------------------------------------- restore
  function summary(key, data) {
    if (key === "settings") return L(`${data.length} bytes (A3 write)`, `${data.length} 字节 (A3 写入)`);
    if (key === "shortcuts") return L(`${decodeShortcuts(data).length} shortcut commands (AB write)`, `${decodeShortcuts(data).length} 条快捷指令 (AB 写入)`);
    return L(`${decodeBleButtons(data).length} BLE buttons (BA write)`, `${decodeBleButtons(data).length} 个蓝牙按钮 (BA 写入)`);
  }

  async function restore(keys) {
    if (busy || !keys.length || !ready()) return;
    const text = await pickFile();
    if (text == null || !entered) return;
    let data, created = "";
    try { const obj = JSON.parse(text); data = readBackup(obj); created = obj.created || ""; }
    catch (e) { await alertBox(L("This file is not a TSL6 backup: ", "此文件不是 TSL6 备份：") + e.message); return; }
    const blocks = keys.filter(k => data[k]);
    const missing = keys.filter(k => !data[k]);
    if (!blocks.length) { await alertBox(L("The file has no data for the selected blocks.", "文件中没有所选项的数据。")); return; }

    busy = true; render();
    try {
      let status = null;
      if (blocks.includes("settings")) {
        status = await S.link.readStatus().catch(() => null);
        if (!status || blankStatus(status)) { await alertBox(L("Read the module status with the BLE password first.", "请先输入蓝牙密码并读取状态。")); return; }
      }
      let plan;
      try { plan = restorePlan(data, status, { blocks }); }
      catch (e) { await alertBox(L("The restore cannot start: ", "无法恢复：") + e.message); return; }
      for (const st of plan) if (st.block === "settings") {
        const why = writeBlocker(st.payload);
        if (why) { await alertBox(L("The restore cannot start: ", "无法恢复：") + why); return; }
      }

      // Show what the restore writes, then ask.
      const body = h("div", { class: "bk-plan" },
        created ? h("p", { class: "dlg-text" }, L("File made: ", "文件时间：") + new Date(created).toLocaleString()) : null,
        h("p", { class: "dlg-text" }, L("This writes to the module:", "将写入模块：")),
        h("ul", null, plan.map(st => h("li", null, h("b", null, blockName(st.block)), " — ", summary(st.block, st.payload)))),
        missing.length ? h("p", { class: "bk-warn" }, L("Not in the file (not changed): ", "文件中没有（不修改）：") + missing.map(blockName).join(", ")) : null,
        h("p", { class: "bk-note" }, blocks.includes("settings")
          ? L("The current BLE password, module ID and VIN stay as they are.", "保留当前的蓝牙密码、模块ID和VIN。")
          : L("The BLE password is not changed.", "蓝牙密码不变。")),
        h("p", { class: "bk-warn" }, L(
          "A restore changes how the car reacts to its controls. Check each page after the restore.",
          "恢复会改变车辆对按键的反应。恢复后请逐页检查。")));
      const go = await dialog({ title: L("Restore from file", "从文件恢复"), body, wide: true,
        buttons: [{ label: L("Cancel", "取消"), value: false }, { label: L("Restore", "恢复"), value: true, kind: "primary" }] });
      if (go !== true || !entered) return;

      const results = [];
      for (const st of plan) {
        if (linkState() !== "ok") { results.push([st.block, "skip", L("not connected", "未连接")]); continue; }
        if (!(await gate(st.type))) { results.push([st.block, "skip", L("cancelled", "已取消")]); continue; }
        const isSet = st.block === "settings";
        let ok = false, why = L("no reply", "无应答");
        for (let n = 1; n <= 2 && !ok; n++) {
          const r = await ask(st.type, st.payload, {
            reply: isSet ? [CMD.STATUS, CMD.SETTINGS] : [st.type, CMD.FAIL],
            accept: isSet ? f => f.payload.length === st.payload.length : isTableReply,
            timeout: 3000, quiet: true,
          });
          if (!r) { log(`restore ${st.block}: no reply (${n}/2)`, "warn"); continue; }
          if (r.cmd === CMD.FAIL) { why = L("the module rejected it (BD)", "模块拒绝 (BD)"); break; }
          ok = st.accept(r.cmd, r.payload);
          if (!ok) { why = L("the echo differs", "回读不一致"); log(`restore ${st.block}: echo differs (${n}/2)`, "warn"); }
        }
        results.push([st.block, ok ? "ok" : "bad", ok ? L("restored, the module confirmed", "恢复成功，模块已确认") : why]);
        if (ok && st.block === "bleButtons") {
          // Names from the file go back into this browser's storage (keys "id<n>").
          for (const [idHex, name] of Object.entries(data.bleNames || {})) {
            try { const b = parseHex(idHex); if (b.length === 4 && name) setBleName(vendorBleId(b, 0), String(name)); } catch { /* bad key */ }
          }
        }
      }
      if (blocks.includes("settings")) rereadSoon(300);
      const allOk = results.every(r => r[1] === "ok");
      await dialog({ title: allOk ? L("Restored", "恢复成功") : L("Restore result", "恢复结果"), wide: true,
        body: h("ul", { class: "bk-res" }, results.map(([k, s, t]) => h("li", { class: s }, h("b", null, blockName(k)), ": ", t))) });
    } finally { busy = false; render(); }
  }

  // ---------------------------------------------------------------- render
  function render() {
    clear(el);
    const times = loadJson(TIME_KEY, {});
    const st = linkState();
    const dis = busy || st !== "ok";
    el.append(h("section", { class: "card bk-intro" },
      h("p", null, L("Backups are local JSON files. The settings block leaves out the module ID, the BLE password and the VIN.",
        "备份保存为本地 JSON 文件。设置数据不含模块ID、蓝牙密码和VIN。")),
      h("p", { class: "bk-small" }, L("The vendor cloud backup, sharing and the query by device ID are left out (no vendor server).",
        "已去掉原厂云端备份、分享和按设备ID查询（不使用原厂服务器）。"))));
    if (st !== "ok") el.append(h("section", { class: "card" }, h("p", { class: "empty" }, linkStateText(st))));

    BLOCKS.forEach((b, i) => {
      const t = times[b.key];
      const box = h("input", { type: "checkbox", checked: sel.has(b.key), disabled: busy, id: `bk-sel-${b.key}` });
      box.addEventListener("change", () => { if (box.checked) sel.add(b.key); else sel.delete(b.key); saveJson(SEL_KEY, [...sel]); render(); });
      el.append(h("section", { class: "card bk-card" },
        h("div", { class: "bk-head" }, h("span", { class: "bk-title" }, `${i + 1}. ${L(b)}`),
          h("span", { class: "bk-time" }, t ? L("Saved ", "已备份 ") + new Date(t).toLocaleString() : L("No backup yet", "暂无备份"))),
        h("div", { class: "bk-row" },
          btn({ en: "Back up", zh: "备份" }, () => backup([b.key]), { kind: "green", disabled: dis }),
          h("label", { class: "bk-check", for: `bk-sel-${b.key}` }, L("Select", "选中"), box),
          btn({ en: "Restore", zh: "恢复" }, () => restore([b.key]), { kind: "blue", disabled: dis }))));
    });

    const keys = BLOCKS.map(b => b.key).filter(k => sel.has(k));
    el.append(h("section", { class: "card bk-foot" },
      btn({ en: `Back up selected (${keys.length})`, zh: `备份所选 (${keys.length})` }, () => backup(keys), { kind: "primary", disabled: dis || !keys.length }),
      btn({ en: `Restore selected (${keys.length})`, zh: `恢复所选 (${keys.length})` }, () => restore(keys), { disabled: dis || !keys.length })));
    if (busy) el.append(h("p", { class: "foot tbl-busy" }, L("Working… Keep the page open.", "正在处理…请勿离开此页面。")));
  }

  render();
  return {
    el,
    title: { en: "Backup and restore", zh: "备份恢复" },
    enter() {
      if (entered) return;
      entered = true;
      offs.push(onBus("conn", () => render()));
      offs.push(onBus("status", () => { if (!busy) render(); }));
    },
    leave() { entered = false; offs.splice(0).forEach(f => f()); },
  };
});
