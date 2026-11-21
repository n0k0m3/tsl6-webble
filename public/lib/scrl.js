// Protocol codec of the BLE board (firmware "scrl-ble-board"): the M5Stack NanoH2 + Unit Mini CAN, and every
// hypery ESP32 board since firmware 0.2.0. The app calls the device type "H2" inside; the user sees the board name.
// Pure functions: no BLE, no DOM. Works in the browser and in Node.
// The firmware defines the protocol: ble-board/main/scrl_ble.h (service, commands), scrl_status.h (Status, Live),
// scrl_settings.h, scrl_ota.h. test/scrl.mjs checks this file against test/fixtures/scrl-protocol.json, which
// tools/scrl-fixture.mjs writes from the firmware sources and the firmware packers.

const uuid = n => `e591${n.toString(16).padStart(4, "0")}-51ba-4d0b-8422-5cb9dc778552`;
const UUIDS = { service: uuid(1), info: uuid(2), status: uuid(3), live: uuid(4), settings: uuid(5),
  command: uuid(6), log: uuid(7), otaCtrl: uuid(8), otaData: uuid(9), capture: uuid(10) };
// Characteristics that older firmware does not have. The link connects without them.
const OPTIONAL = ["capture"];

// SCRL_FLAG_* in scrl_status.h. The Live record carries only the low byte.
const FLAG = { TX_ALLOWED: 1 << 0, TIMER_ARMED: 1 << 1, ACTIVE: 1 << 2, WRONG_BUS: 1 << 3, OTA_BLIND: 1 << 4,
  ENABLED: 1 << 5, BUS_OFF_LOCK: 1 << 6, BLE_OTA: 1 << 7, AUTOPARK: 1 << 8, TESLA_OTA: 1 << 9, HW4_SEEN: 1 << 10,
  IMAGE_PENDING: 1 << 11, PINS_CHECKED: 1 << 12, PAIRING_OPEN: 1 << 13, CAN_RUNNING: 1 << 14, CAPTURE: 1 << 15 };
// SCRL_CMD_* in scrl_ble.h.
const CMD = { RESET_COUNTERS: 1, REBOOT: 2, FORGET_BONDS: 3, FACTORY_RESET: 4, CONFIRM_IMAGE: 5, SET_PASSKEY: 6,
  CAPTURE_START: 7, CAPTURE_STOP: 8, CAPTURE_MARK: 9 };
// Command write for a new passkey: SET_PASSKEY, then 6 ASCII digits. Text keeps the leading zeros.
const isPasskey = text => /^[0-9]{6}$/.test(text);
function passkeyCommand(text) {
  if (!isPasskey(text)) throw new Error("a passkey has 6 digits");
  return Uint8Array.from([CMD.SET_PASSKEY, ...Array.from(text, c => c.charCodeAt(0))]);
}
// scrl_ota.h. SLOT_SIZE is the size of one app slot in partitions.csv.
const OTA = { OP_BEGIN: 1, OP_END: 2, OP_ABORT: 3, EVT_BEGIN: 1, EVT_CREDIT: 2, EVT_END: 3, EVT_STOPPED: 4,
  WINDOW: 4096, CREDIT_STEP: 2048, EVENT_LEN: 6, IDLE_MS: 30000, CONFIRM_MS: 600000, SLOT_SIZE: 0x1E0000 };
const OTA_ERR = { OK: 0, REQUEST: 1, STATE: 2, NOT_PARKED: 3, SIZE: 4, FLASH: 5, SHA: 6, IMAGE: 7, TIMEOUT: 8,
  LINK: 9, ABORTED: 10, PENDING: 11 };
const OTA_ERR_TEXT = ["OK", "the board did not understand the request", "wrong moment: an update runs, or none runs",
  "the car moves or AP is engaged", "the image does not fit, or the byte count is wrong", "a flash write failed",
  "the SHA-256 does not match", "this is not a valid app image for this chip and board", "the board got no data for 30 s",
  "the phone disconnected", "the update was aborted", "the running image is not confirmed yet"];
const otaErrText = n => OTA_ERR_TEXT[n] || `status ${n}`;

const LIVE_LEN = 19;
const STATUS_MAX = 512;
const PHASES = ["Armed", "Delay", "SecondPending", "EpisodeDone"];
const BLOCKS = ["none", "disabled", "tx_denied", "wrong_bus", "stale_native", "not_hw4", "stale_das", "das_ap_state",
  "das_hands_on", "native_idle", "episode_done", "pair_aborted", "timer", "delay", "gap"];
const BLOCK_TEXT = {
  none: "No block at the last 0x3C2 frame.",
  disabled: "Scroll Ack is off.",
  tx_denied: "A TX gate is closed: Listen-Only, Autopark or a Tesla update.",
  wrong_bus: "This bus is not Vehicle CAN.",
  stale_native: "The 0x3C2 frame was older than 25 ms.",
  not_hw4: "No valid 0x39B frame yet.",
  stale_das: "The last 0x39B frame is older than 1 s.",
  das_ap_state: "AP state is not 6.",
  das_hands_on: "No hands-on prompt.",
  native_idle: "A steering wheel control is in use.",
  episode_done: "The ticks for this prompt are sent.",
  pair_aborted: "The second tick of a pair was not sent.",
  timer: "Timer mode: the interval runs.",
  delay: "Prompt mode: the delay runs.",
  gap: "The gap between the two ticks runs.",
};
const AP_STATES = { 0: "disabled", 1: "unavailable", 2: "available", 3: "active", 4: "active, restricted",
  5: "active, navigate", 6: "active, FSD", 8: "aborting", 9: "aborted", 14: "fault", 15: "no data" };
const RESET_REASONS = ["unknown", "power-on", "external pin", "restart by software", "crash", "interrupt watchdog",
  "task watchdog", "watchdog", "deep sleep", "brownout", "SDIO", "USB", "JTAG", "eFuse error", "power glitch", "CPU lock-up"];
const resetReasonName = n => RESET_REASONS[n] || `code ${n}`;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Live record, 19 bytes, little-endian. Layout in scrl_status.h.
function parseLive(b) {
  if (!b || b.length < LIVE_LEN) throw new Error(`Live record has ${b ? b.length : 0} bytes, need ${LIVE_LEN}`);
  return { phase: b[0], block: b[1], apState: b[2], handsOn: b[3], flagsLow: b[4], sent: u32(b, 5),
    pairsAborted: u16(b, 9), nativeAge: u16(b, 11), dasAge: u16(b, 13), feedMv: u16(b, 15), boardMa: u16(b, 17) };
}

const isCount = v => Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF;
// Status JSON. Layout in scrl_status.h. Throws when a field is missing or has the wrong type.
function parseStatus(text) {
  const j = JSON.parse(text);
  const d = j && j.scroll_ack_diag;
  const need = (ok, what) => { if (!ok) throw new Error(`Status JSON: bad ${what}`); };
  need(d && typeof d === "object", "scroll_ack_diag");
  need(isCount(j.scroll_ack_sent_count), "scroll_ack_sent_count");
  need(typeof d.phase === "string" && typeof d.block === "string", "phase or block");
  for (const k of ["native_age_ms", "das_age_ms", "das_ap_state", "das_hands_on", "pairs_aborted"]) need(isCount(d[k]), k);
  need(Array.isArray(j.rx) && j.rx.length === 8 && j.rx.every(isCount), "rx");
  need(Array.isArray(j.tx) && j.tx.length === 3 && j.tx.every(isCount), "tx");
  for (const k of ["op", "flags", "boff", "rst", "pwr", "up"]) need(isCount(j[k]), k);
  need(Number.isInteger(j.rxpin), "rxpin");
  return {
    sent: j.scroll_ack_sent_count, phase: d.phase, block: d.block, nativeAge: d.native_age_ms, dasAge: d.das_age_ms,
    apState: d.das_ap_state, handsOn: d.das_hands_on, vehicleBus: d.vehicle_bus, lastTxAllowed: !!d.tx_allowed,
    pairsAborted: d.pairs_aborted, timerArmed: !!d.timer_armed, opMode: j.op, flags: j.flags,
    rx: { all: j.rx[0], x3c2: j.rx[1], x39b: j.rx[2], x370: j.rx[3], x257: j.rx[4], x318: j.rx[5], x129: j.rx[6], dropped: j.rx[7] },
    tx: { ok: j.tx[0], failed: j.tx[1], refused: j.tx[2] },
    busOff: j.boff, resetReason: j.rst, powerOn: j.pwr, uptime: j.up, rxPin: j.rxpin,
  };
}

// Status carries all 16 flag bits. Live carries the low byte only: it must not clear bits 8 to 14.
const mergeFlags = (full, liveLow) => ((full & 0xFF00) | (liveLow & 0xFF)) >>> 0;

const SETTING_KEYS = ["enabled", "mode", "pattern", "delay_ms", "gap_ms", "interval_ms", "op_mode"];
// Limits of firmware 0.3.1 and older. limitsFor(info) gives the limits of one board.
const LIMITS = { delay_ms: [0, 5000], gap_ms: [0, 2000], interval_ms: [1000, 10000], mode: [0, 1], pattern: [0, 5], op_mode: [0, 1] };
// Longest Timer interval in ms. Firmware 0.3.2 reports it in Info ("imax"). Older firmware takes 10000 ms.
const intervalMax = info => (info && Number.isInteger(info.imax) && info.imax >= LIMITS.interval_ms[1] ? info.imax : LIMITS.interval_ms[1]);
const limitsFor = info => ({ ...LIMITS, interval_ms: [LIMITS.interval_ms[0], intervalMax(info)] });
function parseSettings(text) {
  const j = JSON.parse(text);
  if (!j || typeof j !== "object") throw new Error("Settings JSON: not an object");
  if (typeof j.enabled !== "boolean") throw new Error("Settings JSON: bad enabled");
  const out = { enabled: j.enabled };
  for (const k of SETTING_KEYS.slice(1)) {
    if (!Number.isInteger(j[k]) || j[k] < 0) throw new Error(`Settings JSON: bad ${k}`);
    out[k] = j[k];
  }
  // Settings of the TSL6 car features engine (firmware 0.5.0 and later): 28 bytes as 56 hex digits.
  if ("tsl6" in j) {
    if (typeof j.tsl6 !== "string" || !/^[0-9a-f]{56}$/i.test(j.tsl6)) throw new Error("Settings JSON: bad tsl6");
    out.tsl6 = j.tsl6.toLowerCase();
  }
  // Ported TSL6 features (firmware 0.3.0 and later): more keys, each a small integer.
  for (const [k, v] of Object.entries(j)) {
    if (k in out) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k) || !Number.isInteger(v) || v < 0 || v > 255) throw new Error(`Settings JSON: bad ${k}`);
    out[k] = v;
  }
  return out;
}
// Only the keys that differ. A write that names op_mode 1 releases a bus-off lock on the board,
// so a save must not name op_mode when the user did not change it.
// A key that the board does not report (a feature of newer firmware) is never written.
function settingsDiff(board, form) {
  const out = {};
  for (const k of Object.keys(board)) if (k in form && board[k] !== form[k]) out[k] = form[k];
  return out;
}

// OTA control BEGIN: 01, size u32 LE, SHA-256 (32 bytes).
function otaBegin(size, sha) {
  if (!(sha instanceof Uint8Array) || sha.length !== 32) throw new Error("the SHA-256 must have 32 bytes");
  const b = new Uint8Array(37);
  b[0] = OTA.OP_BEGIN;
  b[1] = size & 0xFF; b[2] = (size >>> 8) & 0xFF; b[3] = (size >>> 16) & 0xFF; b[4] = (size >>> 24) & 0xFF;
  b.set(sha, 5);
  return b;
}
function parseOtaEvent(b) {
  if (!b || b.length < OTA.EVENT_LEN) throw new Error("OTA event is too short");
  return { event: b[0], status: b[1], offset: u32(b, 2) };
}
// The phone may send up to WINDOW bytes past the last CREDIT offset.
const mayWrite = (sent, n, credit) => sent + n <= credit + OTA.WINDOW;
// The board counts whole writes. A CREDIT offset that is not a whole number of chunks means a write was cut.
const creditIsWhole = (offset, chunk, size) => offset === size || offset % chunk === 0;
const CHUNK_STEPS = [500, 240, 180, 100, 20];
const nextChunk = c => CHUNK_STEPS.find(x => x < c) || 0;
// Info "otaw":1 (firmware 0.4.2): OTA data also takes a write with response. Bluefy on iOS delivered none of the
// writes without response there, and the link then blocked. So an iPhone or iPad must send with response.
const otaWriteWithResponse = info => !!(info && info.otaw === 1);
const isAppleMobile = (ua, touchPoints = 0) => /iPhone|iPad|iPod/.test(ua || "") || (/Macintosh/.test(ua || "") && touchPoints > 1);
// How to send OTA data: "command" (write without response, fast), "response" (each write waits for the board),
// or "" (this browser cannot update this firmware: flash a newer one over USB once).
const OTA_IOS_TEXT = "this board firmware cannot take an update from an iPhone or iPad. Flash firmware 0.4.2 or newer over USB once, or send this update from a computer";
function otaWriteMode(info, ua, touchPoints = 0) {
  if (!isAppleMobile(ua, touchPoints)) return "command";
  return otaWriteWithResponse(info) ? "response" : "";
}
// The page cannot read the MTU. iOS and macOS use 185 (182 per write). Others reach 247 or more.
const platformChunk = ua => (/iPhone|iPad|iPod|Macintosh|Mac OS X/.test(ua || "") ? 180 : 240);

// The boards of the firmware: Kconfig SCRL_BOARD_ID and the IDF target of each (test/scrl.mjs checks this table
// against the fixture). A T-2CAN build for can0 or can1 has the same board ID: the hardware is the same.
// All boards are one device type in the app (H2_TYPE): same firmware, same rows. listenOnly: a build that never
// transmits (Kconfig SCRL_NEVER_TX), so the op mode cannot be Active.
const BOARDS = {
  "nanoh2-minican": { chip: "esp32h2", name: "M5Stack NanoH2", zh: "M5Stack NanoH2" },
  "m5stack-atom": { chip: "esp32", name: "M5Stack ATOM Lite", zh: "M5Stack ATOM Lite" },
  "m5stack-atom-matrix": { chip: "esp32", name: "M5Stack ATOM Matrix", zh: "M5Stack ATOM Matrix" },
  "m5stack-atom-swap-pins": { chip: "esp32", name: "M5Stack ATOM Lite (TX/RX swapped)", zh: "M5Stack ATOM Lite（TX/RX 互换）" },
  "esp32-generic-twai": { chip: "esp32", name: "ESP32 DevKit", zh: "ESP32 开发板" },
  "esp32-generic-twai-sniffer": { chip: "esp32", name: "ESP32 DevKit (listen only)", zh: "ESP32 开发板（只听）", listenOnly: true },
  "esp32-mcp2515": { chip: "esp32", name: "ESP32 + MCP2515", zh: "ESP32 + MCP2515" },
  "esp32-lilygo": { chip: "esp32", name: "LilyGO T-CAN485", zh: "LilyGO T-CAN485" },
  "ttgo-tdisplay": { chip: "esp32", name: "TTGO T-Display", zh: "TTGO T-Display" },
  "lilygo-t2can": { chip: "esp32s3", name: "LilyGO T-2CAN", zh: "LilyGO T-2CAN" },
  "lilygo-t2can-fd": { chip: "esp32s3", name: "LilyGO T-2CAN FD", zh: "LilyGO T-2CAN FD" },
  "waveshare-s3-can": { chip: "esp32s3", name: "Waveshare S3-CAN", zh: "Waveshare S3-CAN" },
};
// esp_chip_id_t in ESP-IDF esp_app_format.h.
const CHIP_IDS = { esp32: 0x0000, esp32s3: 0x0009, esp32h2: 0x0010 };
const CAN_NAMES = { twai: "TWAI", mcp2515: "MCP2515", mcp2518fd: "MCP2518FD" };
// The board of an Info JSON. Firmware 0.1.0 had no "can" field and ran only on the NanoH2 with TWAI.
function boardOf(info) {
  if (!info) return null;
  return { id: info.board || "nanoh2-minican", chip: info.chip || "esp32h2", can: info.can || "twai" };
}
// True for a build that never transmits.
const boardListenOnly = info => !!(info && (BOARDS[boardOf(info).id] || {}).listenOnly);
// Name for the user. Without Info yet: "BLE board".
function boardName(info, zh = false) {
  const b = info && BOARDS[boardOf(info).id];
  return b ? (zh ? b.zh : b.name) : info && info.board ? info.board : zh ? "BLE模块" : "BLE board";
}

// MAGIC/DESC_*: ESP-IDF image and esp_app_desc_t. BOARD_*: the board descriptor of the firmware
// (ble-board/main/scrl_board_desc.h), right after esp_app_desc_t: magic, version, board[32], can[16].
const IMG = { MAGIC: 0xE9, DESC_MAGIC: 0xABCD5432, DESC_AT: 32, PROJECT: "scrl-ble-board",
  BOARD_MAGIC: 0x4C524353, BOARD_VERSION: 1, BOARD_AT: 288, BOARD_LEN: 56 };
const cstr = (b, o, n) => { let s = ""; for (let i = o; i < o + n && b[i]; i++) s += String.fromCharCode(b[i]); return s; };
const chipName = id => Object.keys(CHIP_IDS).find(k => CHIP_IDS[k] === id);
// Checks of an ESP-IDF app image that need no hash. Offsets: image header 24 bytes (chip ID at 12, "hash
// appended" at 23), first segment header 8 bytes, then esp_app_desc_t (magic, version at +16, project at +48,
// time at +80, date at +96, IDF version at +112), then the board descriptor.
// target = boardOf(Info) of the connected board, or null. With a target the chip and the board ID must match it,
// as the firmware checks them. warnings: the image is good for the board, but the user must know something.
function checkImage(b, target = null) {
  const errors = [], warnings = [];
  const info = { size: b.length, version: "", project: "", built: "", idf: "", hashAppended: false, chip: "", board: "", can: "" };
  if (b.length < IMG.BOARD_AT + IMG.BOARD_LEN) { errors.push("The file is too small for an app image."); return { errors, warnings, info }; }
  if (b.length > OTA.SLOT_SIZE) errors.push(`The image has ${b.length} bytes. The app slot holds ${OTA.SLOT_SIZE}.`);
  if (b[0] !== IMG.MAGIC) errors.push("The first byte is not 0xE9. This is not an ESP app image.");
  info.chip = chipName(u16(b, 12)) || "";
  if (target) {
    const want = CHIP_IDS[target.chip];
    if (u16(b, 12) !== want) errors.push(`The chip ID is 0x${u16(b, 12).toString(16)}${info.chip ? ` (${info.chip})` : ""}. This board needs 0x${(want ?? 0).toString(16)} (${target.chip}).`);
  } else if (!info.chip) {
    errors.push(`The chip ID is 0x${u16(b, 12).toString(16)}. No board of this firmware has that chip.`);
  }
  if (u32(b, IMG.DESC_AT) !== IMG.DESC_MAGIC) {
    errors.push("The image has no app description.");
  } else {
    const d = IMG.DESC_AT;
    info.version = cstr(b, d + 16, 32);
    info.project = cstr(b, d + 48, 32);
    info.built = `${cstr(b, d + 96, 16)} ${cstr(b, d + 80, 16)}`;
    info.idf = cstr(b, d + 112, 32);
    if (info.project !== IMG.PROJECT) errors.push(`The project name is "${info.project}". The board needs "${IMG.PROJECT}".`);
  }
  const d = IMG.BOARD_AT;
  if (u32(b, d) !== IMG.BOARD_MAGIC || u32(b, d + 4) !== IMG.BOARD_VERSION) {
    errors.push("The image has no board ID (firmware before 0.2.0). The board refuses it.");
  } else {
    info.board = cstr(b, d + 8, 32);
    info.can = cstr(b, d + 40, 16);
    if (target && info.board !== target.id) {
      errors.push(`The image is for the board "${info.board}"${BOARDS[info.board] ? ` (${BOARDS[info.board].name})` : ""}. This board is "${target.id}". The board refuses it.`);
    } else if (target && info.can && info.can !== target.can) {
      warnings.push(`The image uses the CAN controller ${CAN_NAMES[info.can] || info.can}. The board now uses ${CAN_NAMES[target.can] || target.can}. On a T-2CAN that is the other channel: move the Vehicle CAN wires to that terminal before the update.`);
    }
  }
  info.hashAppended = b[23] === 1;
  if (!info.hashAppended) errors.push("The image has no SHA-256 at its end.");
  return { errors, warnings, info };
}
// Flash site of the board firmware (repo flipper-tesla-fsd, ble-board/tools/make-flash-site.py). Its builds.json
// lists each build with its board ID, CAN controller ("can_id", since 0.5.0), version, app image and SHA-256.
const FW_SITE = "https://scrl-flash-preview.surge.sh";
// The build of builds.json for the connected board (boardOf(info)), or null. Board ID and CAN controller must match:
// on a T-2CAN the other controller is the other channel. A list without "can_id" (before 0.5.0) is the TWAI build.
function pickBuild(list, target) {
  if (!list || !Array.isArray(list.builds) || !target) return null;
  return list.builds.find(b => b && b.board === target.id && (b.can_id || "twai") === target.can && typeof b.app === "string"
    && /^scrl-[\w-]+\.bin$/.test(b.app) && /^[0-9a-f]{64}$/.test(b.app_sha256 || "")) || null;
}
async function sha256(b) { return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", b)); }
// An ESP-IDF image ends with the SHA-256 of all bytes before it. A damaged download fails here.
async function appendedHashOk(b) {
  const want = b.subarray(b.length - 32);
  const got = await sha256(b.subarray(0, b.length - 32));
  return got.every((v, i) => v === want[i]);
}
const hex = b => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
function uptimeText(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`;
}

export {
  UUIDS, OPTIONAL, FLAG, CMD, isPasskey, passkeyCommand, OTA, OTA_ERR, OTA_ERR_TEXT, otaErrText, LIVE_LEN, STATUS_MAX,
  PHASES, BLOCKS, BLOCK_TEXT, AP_STATES, RESET_REASONS, resetReasonName, parseLive, parseStatus, mergeFlags,
  SETTING_KEYS, LIMITS, intervalMax, limitsFor, parseSettings, settingsDiff, otaBegin, parseOtaEvent, mayWrite,
  FW_SITE, pickBuild, creditIsWhole, CHUNK_STEPS, nextChunk, platformChunk, otaWriteWithResponse, isAppleMobile, otaWriteMode, OTA_IOS_TEXT, IMG, checkImage, sha256, appendedHashOk, hex,
  uptimeText, BOARDS, CHIP_IDS, CAN_NAMES, boardOf, boardName, boardListenOnly,
};
