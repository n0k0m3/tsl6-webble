// Protocol codec of the H2 board (M5Stack NanoH2 + Unit Mini CAN, firmware "scrl-ble-board").
// Pure functions: no BLE, no DOM. Works in the browser and in Node.
// The firmware defines the protocol: ble-board/main/scrl_ble.h (service, commands), scrl_status.h (Status, Live),
// scrl_settings.h, scrl_ota.h. test/scrl.mjs checks this file against test/fixtures/scrl-protocol.json, which
// tools/scrl-fixture.mjs writes from the firmware sources and the firmware packers.

const uuid = n => `e591${n.toString(16).padStart(4, "0")}-51ba-4d0b-8422-5cb9dc778552`;
const UUIDS = { service: uuid(1), info: uuid(2), status: uuid(3), live: uuid(4), settings: uuid(5),
  command: uuid(6), log: uuid(7), otaCtrl: uuid(8), otaData: uuid(9) };

// SCRL_FLAG_* in scrl_status.h. The Live record carries only the low byte.
const FLAG = { TX_ALLOWED: 1 << 0, TIMER_ARMED: 1 << 1, ACTIVE: 1 << 2, WRONG_BUS: 1 << 3, OTA_BLIND: 1 << 4,
  ENABLED: 1 << 5, BUS_OFF_LOCK: 1 << 6, BLE_OTA: 1 << 7, AUTOPARK: 1 << 8, TESLA_OTA: 1 << 9, HW4_SEEN: 1 << 10,
  IMAGE_PENDING: 1 << 11, PINS_CHECKED: 1 << 12, PAIRING_OPEN: 1 << 13, CAN_RUNNING: 1 << 14 };
// SCRL_CMD_* in scrl_ble.h.
const CMD = { RESET_COUNTERS: 1, REBOOT: 2, FORGET_BONDS: 3, FACTORY_RESET: 4, CONFIRM_IMAGE: 5, SET_PASSKEY: 6 };
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
  "the SHA-256 does not match", "this is not a valid ESP32-H2 app image", "the board got no data for 30 s",
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
const LIMITS = { delay_ms: [0, 5000], gap_ms: [0, 2000], interval_ms: [1000, 10000], mode: [0, 1], pattern: [0, 3], op_mode: [0, 1] };
function parseSettings(text) {
  const j = JSON.parse(text);
  if (!j || typeof j !== "object") throw new Error("Settings JSON: not an object");
  if (typeof j.enabled !== "boolean") throw new Error("Settings JSON: bad enabled");
  const out = { enabled: j.enabled };
  for (const k of SETTING_KEYS.slice(1)) {
    if (!Number.isInteger(j[k]) || j[k] < 0) throw new Error(`Settings JSON: bad ${k}`);
    out[k] = j[k];
  }
  return out;
}
// Range errors of a form, as a list of keys. The board clamps too, but the page shows the error first.
function settingsErrors(s) {
  const bad = [];
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (!Number.isInteger(s[k]) || s[k] < lo || s[k] > hi) bad.push(k);
  }
  if (typeof s.enabled !== "boolean") bad.push("enabled");
  return bad;
}
// Only the keys that differ. A write that names op_mode 1 releases a bus-off lock on the board,
// so a save must not name op_mode when the user did not change it.
function settingsDiff(board, form) {
  const out = {};
  for (const k of SETTING_KEYS) if (board[k] !== form[k]) out[k] = form[k];
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
// The page cannot read the MTU. iOS and macOS use 185 (182 per write). Others reach 247 or more.
const platformChunk = ua => (/iPhone|iPad|iPod|Macintosh|Mac OS X/.test(ua || "") ? 180 : 240);

const IMG = { MAGIC: 0xE9, CHIP_ID_H2: 0x0010, DESC_MAGIC: 0xABCD5432, DESC_AT: 32, PROJECT: "scrl-ble-board" };
const cstr = (b, o, n) => { let s = ""; for (let i = o; i < o + n && b[i]; i++) s += String.fromCharCode(b[i]); return s; };
// Checks of an ESP-IDF app image that need no hash. Offsets: image header 24 bytes (chip ID at 12, "hash
// appended" at 23), first segment header 8 bytes, then esp_app_desc_t (magic, version at +16, project at +48,
// time at +80, date at +96, IDF version at +112).
function checkImage(b) {
  const errors = [];
  const info = { size: b.length, version: "", project: "", built: "", idf: "", hashAppended: false };
  if (b.length < IMG.DESC_AT + 256) { errors.push("The file is too small for an app image."); return { errors, info }; }
  if (b.length > OTA.SLOT_SIZE) errors.push(`The image has ${b.length} bytes. The app slot holds ${OTA.SLOT_SIZE}.`);
  if (b[0] !== IMG.MAGIC) errors.push("The first byte is not 0xE9. This is not an ESP app image.");
  if (u16(b, 12) !== IMG.CHIP_ID_H2) errors.push(`The chip ID is 0x${u16(b, 12).toString(16)}. The board needs 0x10 (ESP32-H2).`);
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
  info.hashAppended = b[23] === 1;
  if (!info.hashAppended) errors.push("The image has no SHA-256 at its end.");
  return { errors, info };
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
  UUIDS, FLAG, CMD, isPasskey, passkeyCommand, OTA, OTA_ERR, OTA_ERR_TEXT, otaErrText, LIVE_LEN, STATUS_MAX,
  PHASES, BLOCKS, BLOCK_TEXT, AP_STATES, RESET_REASONS, resetReasonName, parseLive, parseStatus, mergeFlags,
  SETTING_KEYS, LIMITS, parseSettings, settingsErrors, settingsDiff, otaBegin, parseOtaEvent, mayWrite,
  creditIsWhole, CHUNK_STEPS, nextChunk, platformChunk, IMG, checkImage, sha256, appendedHashOk, hex,
  uptimeText,
};
