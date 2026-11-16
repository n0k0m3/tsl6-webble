// Board firmware page: update of the H2 board over Bluetooth (the "scrl-ble-board" firmware, an ESP-IDF image).
// The TSL6 Firmware page is a different flasher for a different chip. It keeps its own page and links (#firmware).
//
// The page checks the file before it sends a byte: ESP image magic, chip ID, project name, size, and the SHA-256 at
// the end of the image. After a good update the board restarts into the new image. The image stays in Listen-Only
// until the phone confirms it. With no confirm in 10 minutes the board goes back to the old image.
import { h, L, toast, confirmBox, clear, icon } from "../ui.js";
import { S, definePage, onBus, isH2, switchTab } from "../app.js";
import * as SC from "../../lib/scrl.js";
import { boardBanner } from "./board.js";

// The session lives at module scope: a language change mounts a new page, and an update must go on.
const U = { image: null, fileName: "", errors: [], running: false, canAbort: false, abortAsked: false, sent: 0, size: 0, text: "", tone: "" };
const board = () => (isH2() && S.link.connected ? S.link.board : null);
let redraw = () => {};

async function loadFile(file) {
  U.image = null; U.errors = []; U.fileName = file.name; U.text = ""; U.tone = "";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { errors, info } = SC.checkImage(bytes);
  if (!errors.length && !(await SC.appendedHashOk(bytes))) errors.push("The SHA-256 at the end of the image is wrong. The file is damaged.");
  if (errors.length) U.errors = errors;
  else U.image = { bytes, sha: await SC.sha256(bytes), info };
  redraw();
}

async function start() {
  const link = S.link, img = U.image;
  if (!img || U.running || !board()) return;
  if (!(await confirmBox({
    en: `Send ${img.info.project} ${img.info.version} to the board? The car must be parked. The board is in Listen-Only during the update and until you confirm the new image.`,
    zh: `将 ${img.info.project} ${img.info.version} 发送到模块吗？车辆必须已停好。更新期间以及确认新固件之前，模块处于只听模式。`,
  }, L("Board firmware", "模块固件"), L("Send", "发送"), { focusCancel: true }))) return;
  U.running = true; U.canAbort = false; U.abortAsked = false; U.sent = 0; U.size = img.bytes.length; U.tone = "";
  redraw();
  try {
    const r = await link.update(img, {
      onText: t => { U.text = t; redraw(); },
      onBegun: () => { U.canAbort = true; redraw(); },
      onProgress: (sent, size) => { U.sent = sent; U.size = size; U.text = L(`Sent ${sent} of ${size} bytes (${Math.floor(sent * 100 / size)} %).`, `已发送 ${sent} / ${size} 字节（${Math.floor(sent * 100 / size)} %）。`); redraw(); },
      onSent: () => { U.canAbort = false; redraw(); },
      aborted: () => U.abortAsked,
    });
    U.text = r.pending ? L("The new image runs. Check the Car tab, then confirm the image.", "新固件已运行。请查看车辆页，然后确认固件。")
      : L("The board is back, but it does not run a new image. It went back to the old one.", "模块已恢复，但未运行新固件，已回退到旧固件。");
    U.tone = r.pending ? "ok" : "bad";
  } catch (e) {
    const more = e.smaller ? L(` Start again: the app now writes ${e.nextChunk} bytes at a time.`, ` 请重新开始：现在每次写入 ${e.nextChunk} 字节。`) : "";
    U.text = L(`The update stopped: ${e.message.replace(/\.$/, "")}. The board keeps its old image.`, `更新已停止：${e.message.replace(/\.$/, "")}。模块保留旧固件。`) + more;
    U.tone = "bad";
    toast(L("The update stopped. See the Board firmware page.", "更新已停止，请查看模块固件页。"), "bad", 3500);
  }
  U.running = false; U.canAbort = false;
  redraw();
}

definePage("boardfw", () => {
  if (!document.querySelector('link[data-page-css="firmware"]')) {
    document.head.append(h("link", { rel: "stylesheet", href: new URL("./firmware.css", import.meta.url).href, "data-page-css": "firmware" }));
  }
  // data-page="firmware": this page uses the styles of the TSL6 Firmware page (form, buttons, output, progress).
  const el = h("div", { class: "page narrow", "data-page": "firmware", "data-board-fw": "1" });
  const banner = h("div", { "data-id": "board-banner" });
  const fileIn = h("input", { type: "file", accept: ".bin,application/octet-stream", "data-id": "bfw-file",
    onchange: e => { const f = e.target.files[0]; if (f) loadFile(f).catch(err => { U.errors = [err.message]; redraw(); }); } });
  const imgOut = h("div", { class: "out", "data-id": "bfw-image" });
  const prog = h("progress", { max: 1, value: 0 });
  const msgOut = h("div", { class: "out", "data-id": "bfw-msg" });
  const startBtn = h("button", { class: "btn danger-fill", type: "button", "data-id": "bfw-start", onclick: start }, L("Start update", "开始更新"));
  const abortBtn = h("button", { class: "btn", type: "button", "data-id": "bfw-abort", onclick: () => { U.abortAsked = true; } }, L("Abort", "中止"));
  const nowOut = h("p", { class: "row-note fw-note" });
  const chunkOut = h("p", { class: "row-note fw-note" });

  function draw() {
    const B = board();
    boardBanner(banner);
    const pending = !!(B && (B.flags & SC.FLAG.IMAGE_PENDING));
    nowOut.textContent = !B ? L("Connect to an H2 board first (Car tab).", "请先连接H2模块（车辆页）。")
      : L(`The board runs ${B.info && B.info.fw ? B.info.fw : "?"} (build ${B.info && B.info.build ? B.info.build : "?"}).`, `模块运行 ${B.info && B.info.fw ? B.info.fw : "?"}（构建 ${B.info && B.info.build ? B.info.build : "?"}）。`);
    chunkOut.textContent = S.link && isH2() ? L(`Bytes per write: ${S.link.chunk}. The page cannot read the link limit. After a cut write it uses the next smaller size. You can set it in Device > Bytes per BLE write.`,
      `每次写入：${S.link.chunk} 字节。页面无法读取链路上限。写入被截断后会改用更小的值。可在「设备 > 每次写入字节数」中设置。`) : "";
    imgOut.className = "out" + (U.errors.length ? " bad" : "");
    imgOut.textContent = U.errors.length ? U.errors.join("\n")
      : U.image ? `${U.image.info.project} ${U.image.info.version}, ${L("built", "构建于")} ${U.image.info.built}, ESP-IDF ${U.image.info.idf}\n${U.image.bytes.length} ${L("bytes", "字节")}, SHA-256 ${SC.hex(U.image.sha).slice(0, 16)}...`
        : "";
    prog.hidden = !U.running;
    prog.max = U.size || 1; prog.value = U.sent;
    msgOut.className = "out " + U.tone;
    msgOut.textContent = pending && !U.running && !U.text ? L("Confirm the running image first (see the warning above).", "请先确认正在运行的固件（见上方提示）。") : U.text;
    startBtn.disabled = !B || !U.image || U.running || pending;
    abortBtn.hidden = !(U.running && U.canAbort);
    fileIn.disabled = U.running;
  }

  clear(el).append(
    banner,
    h("div", { class: "sec-label" }, L("Board firmware", "模块固件")),
    h("div", { class: "card" },
      h("div", { class: "form" }, nowOut,
        h("p", { class: "row-note fw-note" }, L("Park the car and keep it awake. After the update the board restarts. The app connects again by itself. Then confirm the new image within 10 minutes, or the board goes back to the old image.",
          "请停好车并保持唤醒。更新后模块会重启，应用会自动重新连接。请在10分钟内确认新固件，否则模块会回退到旧固件。")))),
    h("div", { class: "sec-label" }, L("1. Image file", "1. 固件文件")),
    h("div", { class: "card" }, h("div", { class: "form" }, fileIn, imgOut,
      h("p", { class: "row-note fw-note" }, L("The file is scrl-ble-board.bin from the firmware build. The app checks it before it sends a byte.", "文件为固件编译生成的 scrl-ble-board.bin。发送前应用会先检查文件。")))),
    h("div", { class: "sec-label" }, L("2. Update", "2. 更新")),
    h("div", { class: "card" }, h("div", { class: "form" }, h("div", { class: "btns" }, startBtn, abortBtn), prog, msgOut, chunkOut)),
    h("p", { class: "sec-foot" }, h("button", { class: "linkish", type: "button", onclick: () => switchTab("status") }, icon("chevron-left", 16), L("Car tab", "车辆页"))));

  const offs = [];
  redraw = draw;
  draw();
  return {
    el, title: { en: "Board firmware", zh: "模块固件" },
    refresh: draw,
    enter() { redraw = draw; offs.push(onBus("board", draw)); offs.push(onBus("conn", draw)); },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
