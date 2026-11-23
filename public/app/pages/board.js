// Board page: what only the BLE board has. Warnings, mode, live state, exact times, counters, pairing.
// The Car and Settings tabs show the board with the TSL6 rows that it shares. The rest is here.
// boardBanner() draws the warnings. The Car tab shows them too, because one of them has a 10-minute limit.
import { h, L, toast, confirmBox, promptBox, clear, toggle, icon } from "../ui.js";
import { S, definePage, onBus, go, isH2 } from "../app.js";
import * as SC from "../../lib/scrl.js";
import { boardUpdate, checkRelease } from "../board-release.js";

const F = SC.FLAG;
const board = () => (isH2() && S.link.connected ? S.link.board : null);
const has = f => !!(board() && (board().flags & f));
const mmss = s => `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;

async function run(fn, okText) {
  try { await fn(); if (okText) toast(okText, "ok"); return true; }
  catch (e) { toast(L("The board did not take it: ", "模块未接受：") + e.message, "bad", 3500); return false; }
}

async function confirmImage() {
  const ok = await S.link.confirmImage().catch(() => false);
  toast(ok ? L("The new image is confirmed.", "新固件已确认。") : L("The board did not confirm the image.", "模块未确认固件。"), ok ? "ok" : "bad", 3000);
}
async function releaseLock() {
  if (!(await confirmBox({
    en: "Release the bus-off lock? The board goes back to Active and sends on Vehicle CAN again. The next bus-off locks it again. Check the wiring first.",
    zh: "解除总线关闭锁定吗？模块将恢复为主动模式并再次向车辆CAN发送。下次总线关闭会再次锁定。请先检查接线。",
  }, L("Bus-off lock", "总线关闭锁定"), L("Release", "解除"), { focusCancel: true }))) return;
  await run(() => S.link.writeSettings({ op_mode: 1 }), L("Released", "已解除"));
}

// The warnings that apply now: [key, tone, text, button label, action].
function warnings() {
  const B = board();
  if (!B || !B.status) return [];
  const st = B.status, list = [];
  if (has(F.IMAGE_PENDING)) {
    const left = mmss(S.link.pendingLeft());
    list.push(["pending", "bad", L(`A new firmware image runs and is not confirmed. The board stays in Listen-Only. It goes back to the old image in ${left}.`,
      `新固件正在运行但尚未确认。模块保持只听模式，${left}后将回退到旧固件。`), L("Confirm image", "确认固件"), confirmImage]);
  }
  if (has(F.BUS_OFF_LOCK)) {
    list.push(["lock", "bad", L(`The board had ${st.busOff} bus-off events and locked itself to Listen-Only. Check the wiring before you release the lock.`,
      `模块发生了${st.busOff}次总线关闭，已锁定为只听模式。解除前请检查接线。`), L("Release lock", "解除锁定"), releaseLock]);
  }
  if (has(F.WRONG_BUS)) list.push(["wrongbus", "bad", L("This bus carries 0x370, so it is not Vehicle CAN. The board does not send on it.", "此总线上有0x370，不是车辆CAN。模块不会在此发送。")]);
  if (B.info && SC.boardListenOnly(B.info)) {
    list.push(["listenonly", "", L("This is the listen-only build. It never sends, whatever the mode says. To send, flash the esp32-generic-twai build.",
      "这是只听版本固件，无论模式如何都不会发送。如需发送，请刷写 esp32-generic-twai 版本。")]);
  }
  if (!has(F.PINS_CHECKED)) {
    list.push(["pins", "", L(`This firmware build does not name the CAN pins, so it cannot go to Active.${st.rxPin >= 0 ? ` It listens on GPIO${st.rxPin} now.` : ""} Set the pin choice in the build after the continuity check.`,
      `此固件未指定CAN引脚，无法进入主动模式。${st.rxPin >= 0 ? `当前在GPIO${st.rxPin}上监听。` : ""}请在导通检查后于编译配置中设置引脚。`)]);
  }
  if (!has(F.CAN_RUNNING)) list.push(["canoff", "", L("The CAN controller is not running.", "CAN控制器未运行。")]);
  if (has(F.OTA_BLIND)) list.push(["blind", "", L("This bus shows no 0x318 frame. The board cannot see a Tesla software update, so it does not stop for one.", "此总线上没有0x318。模块无法检测特斯拉软件更新，因此不会为其暂停。")]);
  if (has(F.CAN_RUNNING) && st.rx.all === 0 && st.uptime > 10) list.push(["silent", "", L("The board gets no CAN frames. The car sleeps, or the wiring is wrong.", "模块未收到CAN数据。车辆休眠，或接线有误。")]);
  if (has(F.AUTOPARK)) list.push(["autopark", "", L("Autopark runs. The board does not send.", "自动泊车进行中，模块不发送。")]);
  if (has(F.TESLA_OTA)) list.push(["teslaota", "", L("A Tesla software update runs. The board does not send.", "特斯拉软件更新进行中，模块不发送。")]);
  if (st.opMode === 1 && !has(F.ACTIVE) && !list.some(a => ["pending", "lock", "pins", "listenonly"].includes(a[0]))) {
    list.push(["held", "", L("The mode setting is Active, but the board is in Listen-Only now.", "模式设为主动，但模块当前处于只听模式。")]);
  }
  return list;
}

// Draw the warnings into box. The rows are built again only when the set of warnings changes: this runs once per
// second, and a button that is replaced between touch-down and touch-up loses its tap.
export function boardBanner(box) {
  const list = warnings();
  const keys = list.map(a => a[0]).join(",");
  if (box.dataset.keys !== keys) {
    box.dataset.keys = keys;
    clear(box);
    if (list.length) {
      box.append(h("div", { class: "card caution" }, list.map(([key, tone, , label, fn]) =>
        h("div", { class: "notice " + tone, "data-warn": key }, icon(tone === "bad" ? "triangle-alert" : "info", 18), h("span", { class: "warn-text" }),
          label ? h("button", { class: "btn small" + (key === "pending" ? " primary" : ""), type: "button", "data-id": `warn-${key}`, onclick: fn }, label) : null))));
    }
  }
  const rows = box.querySelectorAll(".notice");
  list.forEach(([, , text], i) => { if (rows[i]) rows[i].querySelector(".warn-text").textContent = text; });
}

definePage("board", () => {
  const el = h("div", { class: "page cols", "data-page": "board" });
  const chev = () => h("span", { class: "chev" }, icon("chevron-right", 18));
  const grp = (...kids) => h("section", { class: "grp" }, kids);
  const refs = {};

  // Values in the text face with tabular figures. Mono only for hex IDs (Board ID is on the Device tab).
  // The block: its meaning as the value, its firmware name in mono under the label.
  const block = (key, en, zh) => {
    refs[key] = h("span", { class: "kv" }, "—");
    refs[key + "Code"] = h("div", { class: "li-sub mono-sub" }, "");
    return h("div", { class: "li", "data-row": key }, h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh))), refs[key + "Code"]), refs[key]);
  };
  const kv = (key, en, zh, mono = false) => {
    refs[key] = h("span", { class: "kv" + (mono ? " mono" : "") }, "—");
    return h("div", { class: "li", "data-row": key }, h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh)))), refs[key]);
  };
  // A row that opens a page has a chevron. A row that acts (behind a confirm or a prompt) has a trailing button.
  const ACT = { counters: ["Reset", "清零"], passkey: ["Change", "修改"], forget: ["Forget", "删除"], factory: ["Reset", "重置"] };
  const action = (id, ico, en, zh, sen, szh, fn, danger = false) =>
    h("button", { class: "li" + (danger ? " danger" : ""), type: "button", "data-id": `board-${id}`, onclick: fn },
      h("span", { class: "chip" + (danger ? " red" : "") }, icon(ico, 22)),
      h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh))), sen ? h("div", { class: "li-sub" }, L(sen, szh)) : null),
      ACT[id] ? h("span", { class: "btn small" + (danger ? " danger-text" : ""), "aria-hidden": "true" }, L(...ACT[id])) : chev());

  // "Update firmware", with the newer release in its subtitle when there is one.
  const fwAction = () => {
    const upd = boardUpdate();
    const row = action("fw", "hard-drive-download", "Update firmware", "更新固件",
      upd ? `Release ${upd.version} is out. Update the board over Bluetooth` : "Update the board over Bluetooth", upd ? `发布版 ${upd.version} 已推出，可通过蓝牙更新模块` : "通过蓝牙更新模块",
      () => go("boardfw", upd ? { release: true } : undefined));
    if (upd) row.querySelector(".li-sub").classList.add("fw-new");
    return row;
  };

  async function setOpMode(active) {
    if (active && !(await confirmBox({
      en: "Go to Active? The board will send frames on Vehicle CAN.",
      zh: "切换到主动模式吗？模块将向车辆CAN发送数据。",
    }, L("Mode", "模式"), L("Go to Active", "切换到主动"), { focusCancel: true }))) { draw(); return; }
    await run(() => S.link.writeSettings({ op_mode: active ? 1 : 0 }), L("Saved", "已保存"));
    draw();
  }

  // One exact time in ms. The Settings tab has menus. A value from here that no menu holds shows there as "Custom".
  async function editMs(key, en, zh) {
    const [lo, hi] = SC.limitsFor(board().info)[key];
    const now = board().settings[key];
    const text = await promptBox({ title: L(en, zh), label: L(`${lo} to ${hi} ms. Now: ${now} ms.`, `${lo} 至 ${hi} 毫秒。当前：${now} 毫秒。`), value: String(now), maxlength: 5 });
    if (text == null) return;
    const v = /^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN;
    if (!(v >= lo && v <= hi)) { toast(L(`Type a whole number from ${lo} to ${hi}.`, `请输入 ${lo} 至 ${hi} 的整数。`), "bad", 3000); return; }
    if (v === now) return;
    await run(() => S.link.writeSettings({ [key]: v }), L("Saved", "已保存"));
    draw();
  }

  async function changePasskey() {
    const ask = label => promptBox({ title: L("New passkey", "新配对码"), label, maxlength: 6, placeholder: "000000" });
    const a = await ask(L("Type the new 6-digit passkey. Write it on the label of the board first. The phones that are paired stay paired.",
      "请输入新的6位配对码。请先写在模块标签上。已配对的手机保持配对。"));
    if (a == null) return;
    if (!SC.isPasskey(a)) { toast(L("A passkey has 6 digits.", "配对码为6位数字。"), "bad", 3000); return; }
    const b = await ask(L("Type the new passkey again.", "请再次输入新配对码。"));
    if (b == null) return;
    if (a !== b) { toast(L("The two numbers differ. Nothing changed.", "两次输入不一致，未作修改。"), "bad", 3000); return; }
    await run(() => S.link.setPasskey(a), L("The board has the new passkey.", "模块已保存新配对码。"));
  }
  async function forgetBonds() {
    if (!(await confirmBox({
      en: "Delete all bonds on the board? This phone keeps its own key, so the next connection fails. Remove the board in the Bluetooth settings of each phone. Then pair again in the pairing window: 5 minutes after power-on, or 2 minutes after a press of the board button.",
      zh: "删除模块上的所有配对吗？本手机仍保留自己的密钥，下次连接会失败。请在每部手机的蓝牙设置中删除该模块，然后在配对窗口内重新配对：上电后5分钟内，或按下模块按钮后2分钟内。",
    }, L("Forget bonds", "删除配对"), L("Delete", "删除"), { focusCancel: true }))) return;
    await run(() => S.link.command(SC.CMD.FORGET_BONDS), L("The bonds are deleted.", "配对已删除。"));
  }
  async function factoryReset() {
    if (!(await confirmBox({
      en: "Factory reset? The board erases its settings, its counters and all bonds. Scroll Ack goes off and the board goes to Listen-Only. The passkey stays: the label on the board is still correct. Remove the board in the Bluetooth settings of each phone, then pair again.",
      zh: "恢复出厂设置吗？模块将清除设置、计数器和所有配对。免打扰关闭，模块进入只听模式。配对码保留，标签仍然有效。请在每部手机的蓝牙设置中删除该模块，然后重新配对。",
    }, L("Factory reset", "恢复出厂设置"), L("Reset", "恢复"), { focusCancel: true }))) return;
    await run(() => S.link.command(SC.CMD.FACTORY_RESET), L("The board erased its data and restarts.", "模块已清除数据并重启。"));
  }
  async function resetCounters() {
    if (await run(() => S.link.command(SC.CMD.RESET_COUNTERS), L("The counters are reset.", "计数器已清零。"))) setTimeout(() => S.link.readStatus(), 300);
  }

  function build() {
    clear(el);
    for (const k of Object.keys(refs)) delete refs[k];
    if (!board() || !board().status) {
      el.className = "page narrow";
      el.append(h("div", { class: "card" }, h("div", { class: "empty-state" },
        h("span", { class: "chip blue" }, icon("cpu", 24)),
        h("h2", null, L("No BLE board", "未连接BLE模块")),
        h("p", null, L("This page is for a board with the BLE firmware (NanoH2, T-2CAN, ATOM and the other hypery boards). Connect to one first.", "本页用于刷了BLE固件的模块（NanoH2、T-2CAN、ATOM 及其他 hypery 板）。请先连接。")))));
      return;
    }
    el.className = "page cols";
    refs.banner = h("div", { class: "span", "data-id": "board-banner" });
    el.append(refs.banner);

    refs.opSw = toggle({ checked: null, label: L("Active", "主动模式"), onchange: v => setOpMode(v) });
    refs.opSw.dataset.id = "board-op";
    refs.opSub = h("div", { class: "li-sub" });
    el.append(grp(h("div", { class: "sec-label" }, L("Mode", "模式")), h("div", { class: "card" },
      h("div", { class: "li first" }, h("span", { class: "chip" }, icon("send", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Send on Vehicle CAN", "向车辆CAN发送"))), refs.opSub), refs.opSw)),
    h("p", { class: "sec-foot" }, L("Listen-Only: the board never sends. Active: the board sends scroll ticks when AP assist is on.", "只听模式：模块从不发送。主动模式：AP辅助开启时模块发送滚轮操作。"))));

    el.append(grp(h("div", { class: "sec-label" }, L("Live state", "实时状态")), h("div", { class: "card" },
      kv("phase", "Phase", "阶段", false), block("block", "Block", "阻止原因"), kv("ap", "AP state", "AP状态", false), kv("hands", "Hands-on state", "手扶状态"),
      kv("sent", "Ticks sent", "已拨动次数"), kv("aborted", "Pairs aborted", "中止的组数"), kv("native", "Native frame age", "原车帧延迟"), kv("das", "DAS age", "DAS数据延迟"))));

    el.append(grp(h("div", { class: "sec-label" }, L("Exact times", "精确时间")), h("div", { class: "card" },
      [["delay_ms", "Prompt delay", "提示延时"], ["gap_ms", "Tick gap", "加减间隔"], ["interval_ms", "Timer interval", "定时间隔"]].map(([key, en, zh], i) => {
        refs[key] = h("span", { class: "val" }, "—");
        return h("button", { class: "li" + (i === 0 ? " first" : ""), type: "button", "data-id": `board-${key}`, onclick: () => editMs(key, en, zh) },
          h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh)))), h("div", { class: "li-trail" }, refs[key], chev()));
      })),
    h("p", { class: "sec-foot" }, L("The Settings tab has menus for these times. A value from here that no menu holds shows there as \"Custom value\".", "设置页有这些时间的菜单。此处设置的非菜单值在那里显示为「自定义值」。"))));

    el.append(grp(h("div", { class: "sec-label" }, L("Counters", "计数器")), h("div", { class: "card" },
      kv("rxAll", "Frames received", "收到的帧"), kv("rx3c2", "0x3C2 switch status", "0x3C2 按键状态"), kv("rx39b", "0x39B DAS status", "0x39B DAS状态"),
      kv("rx370", "0x370 EPAS (must stay 0)", "0x370 EPAS（应为0）"), kv("rx257", "0x257 speed", "0x257 车速"), kv("rx318", "0x318 car state", "0x318 车辆状态"),
      kv("rxDrop", "Frames dropped", "丢弃的帧"), kv("txOk", "Ticks on the bus", "已发出的操作"), kv("txFail", "Ticks failed", "失败的操作"),
      kv("txRef", "Sends refused", "被拒绝的发送"), kv("busOff", "Bus-off events", "总线关闭次数"), kv("rxPin", "CAN RX pin", "CAN接收引脚"),
      kv("uptime", "Uptime", "运行时间", false), kv("reset", "Reset reason", "复位原因", false), kv("power", "Power-on count", "上电次数"),
      action("counters", "rotate-ccw", "Reset counters", "计数器清零", null, null, resetCounters))));

    el.append(grp(h("div", { class: "sec-label" }, L("Pairing and firmware", "配对与固件")), h("div", { class: "card" },
      action("passkey", "key-round", "Change the passkey", "修改配对码", "The 6-digit number for a new pairing", "新配对时使用的6位数字", changePasskey),
      fwAction(),
      action("forget", "trash-2", "Forget bonds", "删除配对", "Removes every paired phone", "移除所有已配对手机", forgetBonds, true),
      action("factory", "eraser", "Factory reset", "恢复出厂设置", "Settings, counters and bonds. The passkey stays", "设置、计数器和配对。配对码保留", factoryReset, true))));
    draw();
  }

  // Values only. The page is not built again on each record.
  function draw() {
    const B = board();
    if (!B || !B.status || !refs.banner) return;
    const st = B.status, lv = B.live;
    boardBanner(refs.banner);
    refs.opSw.set(st.opMode === 1);
    // The listen-only build cannot send: Active is locked. A stored Active can still be turned off.
    const never = SC.boardListenOnly(B.info);
    refs.opSw.disabled = never && st.opMode !== 1;
    refs.opSub.textContent = never ? L("Listen-only build: never sends", "只听版本：从不发送")
      : st.opMode !== 1 ? L("Listen-Only", "只听模式")
      : has(F.ACTIVE) ? L("Active", "主动模式") : L("Set to Active, held in Listen-Only (see the warnings)", "已设为主动，但被保持在只听模式（见上方提示）");
    const phase = lv ? SC.PHASES[lv.phase] || `code ${lv.phase}` : st.phase;
    const block = lv ? SC.BLOCKS[lv.block] || `code ${lv.block}` : st.block;
    const ap = lv ? lv.apState : st.apState, hands = lv ? lv.handsOn : st.handsOn;
    const age = v => (v >= 65535 ? "65535+ ms" : `${v} ms`);
    const set = (k, v) => { if (refs[k]) refs[k].textContent = String(v); };
    set("phase", phase);
    // The meaning of the block is the value; its firmware name is the mono line under the label.
    if (refs.block) { refs.block.textContent = SC.BLOCK_TEXT[block] || "—"; refs.blockCode.textContent = String(block); }
    set("ap", has(F.HW4_SEEN) ? `${ap} (${SC.AP_STATES[ap] || "?"})` : L("no 0x39B frame yet", "尚无0x39B"));
    set("hands", hands === 3 ? L("3 (prompt on the screen)", "3（屏幕显示提示）") : hands);
    set("sent", lv ? lv.sent : st.sent);
    set("aborted", lv ? lv.pairsAborted : st.pairsAborted);
    set("native", age(lv ? lv.nativeAge : st.nativeAge));
    set("das", age(lv ? lv.dasAge : st.dasAge));
    for (const k of ["delay_ms", "gap_ms", "interval_ms"]) set(k, `${B.settings[k]} ms`);
    set("rxAll", st.rx.all); set("rx3c2", st.rx.x3c2); set("rx39b", st.rx.x39b); set("rx370", st.rx.x370); set("rx257", st.rx.x257);
    set("rx318", st.rx.x318); set("rxDrop", st.rx.dropped); set("txOk", st.tx.ok); set("txFail", st.tx.failed); set("txRef", st.tx.refused);
    set("busOff", st.busOff); set("rxPin", st.rxPin >= 0 ? `GPIO${st.rxPin}` : "—");
    set("uptime", SC.uptimeText(st.uptime)); set("reset", SC.resetReasonName(st.resetReason)); set("power", st.powerOn);
  }

  const offs = [];
  build();
  return {
    el, title: { en: "Board", zh: "模块" },
    refresh: build,
    enter() {
      offs.push(onBus("board", draw));
      offs.push(onBus("conn", build));
      offs.push(onBus("release", build));
      if (board()) { S.link.readStatus(); void checkRelease(); }
    },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
