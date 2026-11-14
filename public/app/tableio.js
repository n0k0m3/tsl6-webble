// Shared helpers for the table pages (shortcuts, BLE buttons, backup):
// link checks, table read and write with the echo check, BLE button names in local storage, page CSS.
import { h, L, toast } from "./ui.js";
import { S, gate, ask, log } from "./app.js";
import { READ_TABLE, TABLE_LEN, CMD, WriteCheck, tableWriteBlocker } from "../lib/tsl6-tables.js";

const tname = t => t.toString(16).toUpperCase();

// "noconn" | "nopass" | "ok"
export function linkState() {
  if (!S.link || !S.link.connected) return "noconn";
  if (!S.link.authed && (!S.status || S.blank)) return "nopass";
  return "ok";
}
export function linkStateText(st) {
  return st === "noconn"
    ? L("Connect to the module first.", "请先连接蓝牙")
    : L("Enter the BLE password first.", "请先输入蓝牙密码");
}

// A reply to a table write or read: the 256-byte table, or BD (operation failed).
export const isTableReply = f => f.cmd === CMD.FAIL || f.payload.length === TABLE_LEN;

// Read a table (AB 02 or BA 02). Returns the 256-byte table or null.
export async function readTable(type, { quiet = true } = {}) {
  const r = await ask(type, READ_TABLE, {
    read: true, reply: [type], accept: f => f.payload.length === TABLE_LEN, timeout: 3000, quiet,
  });
  return r ? Uint8Array.from(r.payload) : null;
}

// Write a 256-byte table (AB or BA) and check the echo. At most 2 sends (one resend on a wrong echo).
// BD and no reply are not resent. Returns { ok, table, reason }:
//   table = the last 256-byte table that the module sent (render from it), or null.
//   reason = null | "blocked" | "cancel" | "noreply" | "bd" | "mismatch".
export async function writeTable(type, payload) {
  const why = tableWriteBlocker(payload);
  if (why) { toast(why, "bad", 4000); return { ok: false, table: null, reason: "blocked" }; }
  if (!(await gate(type))) return { ok: false, table: null, reason: "cancel" };
  const check = new WriteCheck(type, payload, 2);
  let last = null;
  for (let n = 1; n <= 2; n++) {
    const r = await ask(type, payload, { reply: [type, CMD.FAIL], accept: isTableReply, timeout: 3000, quiet: true });
    if (!r) {
      log(`${tname(type)} write: no reply`, "warn");
      toast(L("No reply from the module. The app reads the table again.", "模块无应答，正在重新读取"), "warn", 2500);
      return { ok: false, table: last, reason: "noreply" };
    }
    if (r.cmd === CMD.FAIL) {
      log(`${tname(type)} write: module replied BD ${r.payload[0]}`, "bad");
      toast(L("Operation failed (the module rejected the table).", "操作失败"), "bad", 2500);
      return { ok: false, table: last, reason: "bd" };
    }
    last = Uint8Array.from(r.payload);
    const res = check.onReply(r.cmd, r.payload);
    if (res.action === "resend") { log(`${tname(type)} write: echo differs, sending again (2/2)`, "warn"); continue; }
    if (res.action === "done") {
      if (!res.ok) {
        log(`${tname(type)} write: echo differs after 2 sends`, "bad");
        toast(L("The module did not confirm the change. The list shows what the module sent.", "模块未确认此修改，列表显示模块返回的数据"), "bad", 3500);
      }
      return { ok: res.ok, table: last, reason: res.ok ? null : "mismatch" };
    }
  }
  return { ok: false, table: last, reason: "mismatch" };
}

// ---------------------------------------------------------------- BLE button names and battery
// Same shape as the vendor wx storage: { "id<n>": value }, n = signed 32-bit id (vendorBleId).
const NAME_KEY = "tsl6.blename", BAT_KEY = "tsl6.blebat";
function loadObj(k) { try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === "object" ? v : {}; } catch { return {}; } }
function saveObj(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); } catch { /* storage blocked */ } }
export const bleKey = id => "id" + id;
export const bleNames = () => loadObj(NAME_KEY);
export const bleBats = () => loadObj(BAT_KEY);
export function setBleName(id, name) { const o = bleNames(); o[bleKey(id)] = name; saveObj(NAME_KEY, o); }
// Store a battery value only if there is none or it changed by 3 % or more (vendor rule). Returns true if stored.
export function setBleBat(id, pct) {
  const o = bleBats(), k = bleKey(id);
  if (o[k] != null && Math.abs(o[k] - pct) < 3) return false;
  o[k] = pct; saveObj(BAT_KEY, o); return true;
}
// Keep only the ids in the table (vendor clean-up after each table read).
export function pruneBleStore(ids) {
  const keep = new Set(ids.map(bleKey));
  for (const k of [NAME_KEY, BAT_KEY]) {
    const o = loadObj(k);
    for (const key of Object.keys(o)) if (!keep.has(key)) delete o[key];
    saveObj(k, o);
  }
}

// ---------------------------------------------------------------- page CSS (pages/tables.css), loaded once
let cssDone = false;
export function loadTablesCss() {
  if (cssDone) return;
  cssDone = true;
  document.head.append(h("link", { rel: "stylesheet", href: new URL("./pages/tables.css", import.meta.url).href }));
}
