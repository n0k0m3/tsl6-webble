// TSL6 runtime settings codec.
// Bit map from the vendor Mini App (see docs/miniapp-protocol.md).
// Pure functions: no BLE, no DOM. Works in the browser and in Node.
import { H2_TYPE, h2Fields, h2Options } from "./h2-menus.js";

const OFF_ON = [[0, "Off (default)"], [1, "On"]];
const ON_OFF_INV = [[0, "On (default)"], [1, "Off"]];
const SECONDS_0_7 = (zero) => [[0, zero], ...[1, 2, 3, 4, 5, 6, 7].map(s => [s, `${s} s`])];

// Device types that use this layout. Others are not supported.
export const TSL_TYPES = [3, 5, 6, 7, 8, 19];
// Types where the vendor app shows the CAN1-3 state and the newer wheel labels.
const NEW_TYPES = [6, 7, 8, 19];

const BEEP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 50, 70, 90, 110, 130, 150, 170, 255];
const BEEP_PCT = ["0%", "5%", "10%", "15%", "20%", "25%", "30%", "35%", "40%", "45%", "50%",
  "55%", "60%", "65%", "70%", "75%", "80%", "85%", "90%", "95%", "100% (default)"];

const TIME_RAND = [[1, "Every 2-3 s, random (default)"], [2, "Every 3-5 s, random"], [3, "Every 5-10 s, random"],
  [4, "Every 10-15 s, random"], [5, "Every 15-20 s, random"], [6, "Every 20-25 s, random"],
  [7, "Every 25-30 s, random"], [8, "Every 30-35 s, random"], [15, "Fixed-point assist"]];
// App extras, not in the vendor menu: scroll interval values for the prompt build (Firmware page).
// The prompt build scrolls once per hands-on prompt, after a random delay of mean +/- 50 %.
// The stock build runs 0 as every 2-3 s and 9-14 as every 35-65 s.
// [value, delay mean in ms], in menu order (shortest delay first).
export const PROMPT_TIMES = [[9, 300], [0, 600], [10, 1000], [11, 1500], [12, 2000], [13, 3000], [14, 5000]];
const PROMPT_MEAN = new Map(PROMPT_TIMES);
// Delay mean in ms for a prompt-build scroll interval value, or 0 for a stock value.
export const promptDelayMs = time => PROMPT_MEAN.get(time) || 0;
export const isPromptTime = time => PROMPT_MEAN.has(time);
const secs = ms => (ms / 1000).toString();
export const TIME_PROMPT = PROMPT_TIMES.map(([v, ms]) => [v, `On hands-on prompt, after about ${secs(ms)} s`]);
export const TIME_PROMPT_ZH = Object.fromEntries(PROMPT_TIMES.map(([v, ms]) => [v, `手扶提示时，约${secs(ms)}秒后`]));
const TIME_FIXED = [[1, "Every 2 s"], [2, "Every 3 s"], [3, "Every 5 s"], [4, "Every 10 s"], [5, "Every 15 s"],
  [6, "Every 20 s"], [7, "Every 25 s"], [8, "Every 30 s"], [15, "Fixed-point assist"]];

// byte = payload offset, shift/width = bit field. group = UI section.
// types: only shown (and only written by the vendor) for these device types.
// parent: a sub-setting that the vendor shows under another one.
export const FIELDS = [
  // Scroll (nag) settings
  { id: "time", group: "scroll", byte: 27, shift: 0, width: 4, label: "Scroll interval", options: TIME_RAND },
  { id: "rand", group: "scroll", byte: 28, shift: 0, width: 1, label: "Random interval", options: [[0, "Off"], [1, "On (default)"]] },
  { id: "automdr", group: "scroll", byte: 28, shift: 4, width: 1, label: "AP auto assist", types: [6, 7, 8, 9, 19], options: [[0, "Off (default)"], [1, "Follow AP"]] },
  { id: "lr", group: "scroll", byte: 28, shift: 6, width: 2, label: "Scroll wheel", types: [5, 6, 7, 8, 9, 19],
    options: [[0, "Left wheel (default)"], [1, "Right wheel"], [2, "Left and right, alternate"], [3, "Left and right, random"]] },
  { id: "ModeMDR", group: "scroll", byte: 29, shift: 0, width: 2, label: "Assist method", types: [19],
    options: [[0, "Wheel (default)"], [1, "Senseless assist"], [2, "Wheel + senseless"]] },
  { id: "enable_save", group: "scroll", byte: 30, shift: 0, width: 1, label: "Save state", types: [3, 5], options: [[0, "Do not save (default)"], [1, "Save"]] },
  { id: "jg", group: "scroll", byte: 32, shift: 0, width: 4, label: "Up/down tick gap",
    options: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => [v, `${(v / 10).toFixed(1)} s${v === 1 ? " (default)" : ""}`]) },
  { id: "dblclickMDR", group: "scroll", byte: 32, shift: 7, width: 1, label: "Double-click toggles assist", types: [3, 5], options: ON_OFF_INV },
  { id: "jj", group: "scroll", byte: 33, shift: 0, width: 2, label: "Tick order",
    options: [[0, "Up, then down"], [1, "Down, then up (default)"], [2, "Alternate"], [3, "Random"]] },

  // Basic settings
  { id: "beep", group: "basic", byte: 26, shift: 0, width: 8, label: "Beep volume", options: BEEP.map((v, i) => [v, BEEP_PCT[i]]) },
  { id: "led", group: "basic", byte: 27, shift: 4, width: 1, label: "LED", options: ON_OFF_INV },
  { id: "BLEPWR", group: "basic", byte: 31, shift: 0, width: 2, label: "BLE signal strength (needs restart)", types: [3, 6, 8, 9, 19],
    options: [[0, "Strong (default)"], [1, "Medium"], [2, "Weak"]] },

  // Vehicle functions (vendor "tsl6list")
  { id: "mianSwitch", group: "car", byte: 28, shift: 3, width: 1, label: "Module master switch", options: [[0, "Module on (default)"], [1, "Module off"]] },
  { id: "apAutoOpenType", group: "car", byte: 28, shift: 1, width: 2, label: "AP resume",
    options: [[0, "Off (default)"], [1, "Double-click right wheel"], [2, "Stalk fully down"], [3, "Follow AP"]] },
  { id: "apAutoOpenTime", group: "car", parent: "apAutoOpenType", byte: 30, shift: 1, width: 3, label: "AP resume delay",
    options: [[0, "Resume at once (default)"], ...[1, 2, 3, 4, 5, 6, 7].map(s => [s, `After ${s} s`])] },
  { id: "oneClickOpenAP", group: "car", byte: 31, shift: 3, width: 1, label: "One-click AP", options: OFF_ON },
  { id: "APSpeedExit", group: "car", byte: 31, shift: 2, width: 1, label: "Exit AP on overspeed", options: OFF_ON },
  { id: "fsd", group: "car", byte: 28, shift: 5, width: 1, label: "EAP assist", options: OFF_ON },
  { id: "OffAPAutoWiper", group: "car", byte: 25, shift: 7, width: 1, label: "Turn off auto wipers", options: OFF_ON },
  { id: "dynamicBrakeLight", group: "car", byte: 33, shift: 6, width: 2, label: "Dynamic brake light",
    options: [[0, "Off (default)"], [1, "Light braking"], [2, "Hard braking"]] },
  { id: "apHighBeam", group: "car", byte: 31, shift: 4, width: 2, label: "Manual high beam",
    options: [[0, "Off (default)"], [1, "Old: AP manual high beam"], [2, "New"]] },
  { id: "blinkHighBeam", group: "car", byte: 30, shift: 6, width: 1, label: "Flash high beam 3 times", options: OFF_ON },
  { id: "pluseHighBeam", group: "car", byte: 25, shift: 0, width: 2, label: "High-beam strobe speed",
    options: [[0, "Off (default)"], [1, "Fast"], [2, "Medium"], [3, "Slow"]] },
  { id: "pluseHighBeamAndLowBeam", group: "car", parent: "pluseHighBeam", byte: 25, shift: 2, width: 1, label: "Low beam follows strobe", options: OFF_ON },
  { id: "pluseFrontFogLight", group: "car", byte: 30, shift: 5, width: 1, label: "Front fog strobe", options: OFF_ON },
  { id: "pluseRearFogLight", group: "car", byte: 31, shift: 6, width: 1, label: "Rear fog strobe", options: OFF_ON },
  { id: "gentryHorn", group: "car", byte: 34, shift: 4, width: 2, label: "Soft horn at low speed",
    options: [[0, "Off (default)"], [1, "Below 10"], [2, "Below 20"], [3, "Below 30"]] },
  { id: "gentryHornCount", group: "car", parent: "gentryHorn", byte: 34, shift: 6, width: 2, label: "Soft horn count",
    options: [[0, "1 time"], [1, "2 times"], [2, "3 times"], [3, "4 times"]] },
  { id: "pluseHorn", group: "car", byte: 27, shift: 6, width: 2, label: "Pulse horn speed",
    options: [[0, "Off (default)"], [1, "Fast"], [2, "Medium"], [3, "Slow"]] },
  { id: "longPluseHorn", group: "car", parent: "pluseHorn", byte: 27, shift: 5, width: 1, label: "Long press horn starts pulse horn", options: OFF_ON },
  { id: "hornLinkedHighBeam", group: "car", byte: 32, shift: 5, width: 1, label: "Horn also flashes high beam", options: OFF_ON },
  { id: "highBeamLinkedHorn", group: "car", byte: 32, shift: 6, width: 1, label: "High beam also sounds horn", options: OFF_ON },
  { id: "turnLightPriority", group: "car", byte: 33, shift: 2, width: 2, label: "Turn signal priority",
    options: [[0, "Off (default)"], [1, "Mode 1"], [2, "Mode 2"]] },
  { id: "openDoorHazardLight", group: "car", byte: 30, shift: 4, width: 1, label: "Hazards on door open", options: OFF_ON },
  { id: "backHazardLight", group: "car", byte: 30, shift: 7, width: 1, label: "Hazards while reversing", options: OFF_ON },
  { id: "KERS", group: "car", byte: 24, shift: 5, width: 3, label: "Regenerative braking",
    options: [[0, "Car setting (default)"], [1, "0%"], [2, "25%"], [3, "50%"], [4, "75%"], [5, "100%"]] },
  { id: "stoppingMode", group: "car", byte: 25, shift: 5, width: 2, label: "Stopping mode",
    options: [[0, "Car setting (default)"], [1, "Hold"], [2, "Creep"], [3, "Roll"]] },
  { id: "autoSportMode", group: "car", byte: 24, shift: 0, width: 3, label: "Auto sport mode",
    options: [[0, "Off (default)"], ...[20, 30, 40, 50, 60, 70, 80].map((p, i) => [i + 1, `Accelerator >= ${p}%`])] },
  { id: "autoParkBrake", group: "car", byte: 24, shift: 4, width: 1, label: "Auto park brake", options: OFF_ON },
  { id: "frontRightEasyAccess", group: "car", byte: 25, shift: 3, width: 2, label: "Passenger easy entry",
    options: [[0, "Off (default)"], [1, "On passenger belt release"], [2, "On passenger door open/close"]] },
  { id: "TimeOpenFrontBox", group: "car", byte: 29, shift: 2, width: 3, label: "Frunk by long door-handle pull", options: SECONDS_0_7("Off (default)") },
  { id: "TimeOpenChargeDoor", group: "car", byte: 29, shift: 5, width: 3, label: "Charge port by long door-handle pull", options: SECONDS_0_7("Off (default)") },

  // Vendor "lab" settings. Shown only after an unlock code in the vendor app.
  { id: "frontLeftBuckle", group: "lab", byte: 34, shift: 1, width: 1, label: "Driver seat-belt chime", options: ON_OFF_INV },
  { id: "frontRightBuckle", group: "lab", byte: 34, shift: 2, width: 1, label: "Passenger seat-belt chime", options: ON_OFF_INV },
  { id: "rearBuckle", group: "lab", byte: 34, shift: 3, width: 1, label: "Rear seat-belt chime", options: ON_OFF_INV },
  { id: "airAutoArid", group: "lab", byte: 59, shift: 6, width: 2, layout76: true, label: "A/C auto dry",
    options: [[0, "Off (default)"], [1, "Dry 1 min"], [2, "Dry 5 min"], [3, "Dry 10 min"]] },
  { id: "backHazardRearFogLight", group: "lab", byte: 24, shift: 3, width: 1, label: "Rear fog light while reversing", options: OFF_ON },
  { id: "steerAssistanceLighting", group: "lab", byte: 31, shift: 7, width: 1, label: "Cornering light", types: NEW_TYPES, options: OFF_ON },
];

export const BY_ID = Object.fromEntries(FIELDS.map(f => [f.id, f]));

export const MIN_STATUS_LEN = 18;
export const MIN_SETTINGS_LEN = 35; // bytes 24..34

const mask = f => ((1 << f.width) - 1) << f.shift;

function present(f, payload) {
  if (f.layout76) return payload.length === 76;
  return payload.length > f.byte;
}

// Options for a field, given the other decoded values (the "time" labels depend on "rand").
// promptBuild adds the "time" prompt values (TIME_PROMPT) first. Without it the lists match the vendor menus.
export function optionsFor(f, values, hwType, { promptBuild = false } = {}) {
  // The H2 board has its own menus (lib/h2-menus.js). They hold only what the board can do.
  if (hwType === H2_TYPE) return h2Options(f.id, values ? values[f.id] : undefined, values).map(([v, en]) => [v, en]);
  if (f.id === "time") {
    const list = values && values.rand === 0 ? TIME_FIXED : TIME_RAND;
    return promptBuild ? [...TIME_PROMPT, ...list] : list;
  }
  if (f.id === "lr" && [6, 8, 19].includes(hwType)) {
    return [[0, "Left wheel, volume (default)"], [1, "Right wheel, speed"], [2, "Left and right, alternate"], [3, "Right wheel, follow distance"]];
  }
  return f.options;
}

// Field shown for this device type?
export function appliesTo(f, hwType) {
  // The H2 board has only its own fields (H2_FIELDS and the ported features that it reports).
  if (hwType === H2_TYPE) return h2Fields().includes(f.id);
  return !f.types || f.types.includes(hwType);
}

export function decodeStatus(p) {
  const u = p instanceof Uint8Array ? p : new Uint8Array(p);
  const out = { length: u.length };
  if (u.length < 4) return out;
  out.typeHint = u[0];
  out.bootVer = u[1];
  out.runVer = u[2];
  out.flags = u[3];
  out.runtimeOk = (u[3] & 1) === 1;
  if (u.length >= 16) out.moduleId = hex(u.slice(4, 16));
  if (u.length >= 18) {
    out.uid14 = u.slice(4, 18);
    out.mac = hex(u.slice(12, 18).reverse(), ":");
  }
  if (u.length >= 24) {
    out.fxp = u[18];
    out.on = u[19];
    out.noNagActive = (u[19] & 1) === 1;
    out.timerMs = u[20] | (u[21] << 8);
    out.dat0 = u[22];
    out.dat1 = u[23];
    out.can = [(u[23] >> 0) & 1, (u[23] >> 1) & 1, (u[23] >> 2) & 1];
  }
  if (u.length >= 40) out.blePassword = String.fromCharCode(...u.slice(36, 40));
  if (u.length === 178) out.vin = u[46] !== 0xff ? String.fromCharCode(...u.slice(46, 63)) : "";
  else if (u.length >= 58) out.vin = u[40] === 1 ? String.fromCharCode(...u.slice(41, 58)) : "";
  return out;
}

// Raw field values. A field that the payload does not cover is left out.
export function decodeSettings(p) {
  const u = p instanceof Uint8Array ? p : new Uint8Array(p);
  const v = {};
  for (const f of FIELDS) if (present(f, u)) v[f.id] = (u[f.byte] & mask(f)) >> f.shift;
  return v;
}

// Build the A3 payload from the last status payload and new raw values.
// Policy (differs from the vendor on purpose):
//  - Only the fields in `values` change. Every other bit stays as the module sent it,
//    including bits that no field maps and values that no menu lists.
//  - Bytes 18-23 (live state) are set to 0, as the vendor does.
//  - Vendor side rules kept: apAutoOpenType > 0 forces fsd = 0, fsd = 1 forces apAutoOpenType = 0
//    (only for the field the caller changed), enable_save is 0 on types 6/7/8/19.
export function encodeSettings(base, values, hwType, changedId) {
  const u = Uint8Array.from(base);
  if (u.length < MIN_SETTINGS_LEN) throw new Error(`status payload too short (${u.length} < ${MIN_SETTINGS_LEN})`);
  const vals = { ...values };
  if (changedId === "apAutoOpenType" && vals.apAutoOpenType > 0) vals.fsd = 0;
  if (changedId === "fsd" && vals.fsd > 0) vals.apAutoOpenType = 0;
  if (NEW_TYPES.includes(hwType)) vals.enable_save = 0;
  for (let i = 18; i < 24; i++) u[i] = 0;
  for (const [id, raw] of Object.entries(vals)) {
    const f = BY_ID[id];
    if (!f || !present(f, u)) continue;
    const max = (1 << f.width) - 1;
    if (!Number.isInteger(raw) || raw < 0 || raw > max) throw new Error(`${id}: value ${raw} out of range 0..${max}`);
    u[f.byte] = (u[f.byte] & ~mask(f)) | (raw << f.shift);
  }
  return u;
}

// Reason why runtime V1.0.00 would reject this payload as an A3 write, or null.
// From the runtime disassembly: A3 needs exactly 76 bytes, UID14 at bytes 4-17,
// and printable ASCII (0x20-0x7E) in bytes 36-39 (the BLE password).
// An A0 reply on a link without the password has bytes 18-39 and 59-74 set to 0.
export function writeBlocker(p) {
  if (p.length !== 76) return `runtime accepts A3 only with 76 bytes (this payload has ${p.length})`;
  for (let i = 36; i < 40; i++) {
    if (p[i] < 0x20 || p[i] > 0x7e) return "the status is blank: send the BLE password, then read the status again";
  }
  return null;
}

// True if a status reply holds the settings that an A3 write sent.
// Compares only the bytes that runtime V1.0.00 stores from A3: 24-39 and 59-74.
export function settingsEchoMatches(sent, reply) {
  if (sent.length !== reply.length) return false;
  for (let i = 24; i < sent.length; i++) {
    if ((i < 40 || (i >= 59 && i < 75)) && sent[i] !== reply[i]) return false;
  }
  return true;
}

// True if the A3 echo matches what was sent (bytes 18-23 masked, as the vendor checks).
export function echoMatches(sent, echo) {
  if (sent.length !== echo.length) return false;
  for (let i = 0; i < sent.length; i++) if (!(i >= 18 && i < 24) && sent[i] !== echo[i]) return false;
  return true;
}

export function hex(a, sep = "") {
  return Array.from(a, b => b.toString(16).padStart(2, "0").toUpperCase()).join(sep);
}
