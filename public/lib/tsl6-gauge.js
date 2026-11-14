// TSL6 live gauge stream codec (BLE type B0) and phone gauge menu tables.
// Layout from the vendor Mini App gauge page. Not checked on a car yet.
// Pure functions: no BLE, no DOM. Works in the browser and in Node.

// ---------------------------------------------------------------- commands
export const B0 = 0xb0; // 176
// The vendor app sends B0 01 when the gauge opens and again every 1 s while it shows.
// It sends B0 00 when the gauge closes or hides.
export const startPayload = () => Uint8Array.of(1);
export const stopPayload = () => Uint8Array.of(0);
export const KEEPALIVE_MS = 1000;

// A7 values that the vendor gauge page sends. These are car actions.
// The vendor sends them without a confirm dialog. A reimplementation must gate them.
export const GAUGE_CAR_ACTIONS = [
  { a7: 0, id: "doorFL", label: "Open front-left door", zh: "打开左前门", needsStop: true },
  { a7: 1, id: "doorFR", label: "Open front-right door", zh: "打开右前门", needsStop: true },
  { a7: 2, id: "doorRL", label: "Open rear-left door", zh: "打开左后门", needsStop: true },
  { a7: 3, id: "doorRR", label: "Open rear-right door", zh: "打开右后门", needsStop: true },
  // Battery heat: the on/off direction is inferred from the vendor toggle only.
  { a7: 4, id: "battHeatOff", label: "Battery heat off (sent when heat is on)" },
  { a7: 5, id: "battHeatOn", label: "Battery heat on (sent when heat is off)" },
  { a7: 8, id: "frunk", label: "Frunk (shown only at speed 0)" },
  { a7: 9, id: "trunk", label: "Trunk (shown only at speed 0)" },
];

// ---------------------------------------------------------------- frame layout
// Payload offsets (after the 5-byte frame header). All multi-byte words are little-endian.
export const MIN_FRAME_LEN = 16; // the vendor reads bytes 0-15 from every frame
export const FULL_FRAME_LEN = 33; // the vendor reads bytes 15-32 only when length >= 33

export const GEAR = ["", "P", "R", "N", "D"]; // raw 0 and 5-7: no gear letter
export const DRIVE_GEAR = 4;

const u32 = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
const bits = (w, shift, width) => Math.floor(w / 2 ** shift) % 2 ** width;
const signed = (v, width) => (v >= 2 ** (width - 1) ? v - 2 ** width : v);

// Decode one B0 payload. Returns null if the payload is shorter than 16 bytes.
// Values are raw or scaled numbers. Use formatGauge() for the vendor display strings.
export function decodeGauge(p) {
  const u = p instanceof Uint8Array ? p : Uint8Array.from(p);
  if (u.length < MIN_FRAME_LEN) return null;
  const d = { length: u.length, full: u.length >= FULL_FRAME_LEN };

  const w0 = u32(u, 0);
  d.speed = bits(w0, 0, 9); // in car display units, see speedKmh
  d.gear = bits(w0, 9, 3); // 1 P, 2 R, 3 N, 4 D
  d.turn = bits(w0, 12, 2); // bit 0 left, bit 1 right
  d.autopilot = bits(w0, 14, 2); // 0 off; 1, 2 active (blue ring); 3 grey
  d.doors = bits(w0, 16, 4); // bit 0 FL, bit 1 RL, bit 2 FR, bit 3 RR (note the order)
  d.batteryPct = bits(w0, 24, 7);

  const w1 = u32(u, 4);
  // Vendor "light" mask: bit 0 high beam, 1 low beam, 2 position lights, 3 front fog,
  // 4 rear fog (from byte 3 bit 7), 5 brake light (from byte 4 bit 4).
  // Front fog and rear fog are inferred from the icon colours only.
  d.lights = bits(w0, 20, 4) | (bits(w0, 31, 1) << 4) | (bits(w1, 4, 1) << 5);
  d.allowScreenSleep = bits(w1, 0, 1); // 0: the vendor keeps the phone screen on
  d.frunkOpen = bits(w1, 1, 1);
  d.carLightTheme = bits(w1, 2, 1); // 1: car screen is in light mode
  d.sport = bits(w1, 3, 1); // 0: green accents, 1: orange accents
  d.trunkOpen = bits(w1, 5, 1);
  d.odometerRaw = bits(w1, 6, 26); // 0.1 km
  d.odometerKm = d.odometerRaw / 10;

  // Tire pressure, order FL, FR, RL, RR. 0.025 bar per bit. 0 and 255 = no value.
  d.tirePressureRaw = [u[8], u[9], u[10], u[11]];
  d.tirePressureBar = d.tirePressureRaw.map(r => (r === 0 || r === 255 ? null : 0.025 * r));

  const w3 = u32(u, 12);
  d.accelPedalRaw = bits(w3, 0, 8); // 250 = 100 %
  d.rearPowerRaw = signed(bits(w3, 8, 11), 11); // 0.5 kW
  d.frontPowerRaw = signed(bits(w3, 19, 11), 11); // 0.5 kW
  d.accelPedalPct = Math.min(100, Math.round((100 * d.accelPedalRaw) / 250));
  d.rearPowerKw = Math.round(d.rearPowerRaw / 2);
  d.frontPowerKw = Math.round(d.frontPowerRaw / 2);

  if (!d.full) return d;

  const w15 = u[15] | (u[16] << 8) | (u[17] << 16); // 24 bits
  d.altitudeRaw = bits(w15, 6, 14);
  d.altitudeM = signed(d.altitudeRaw, 14);
  d.battHeat = (u[17] >> 4) & 3; // 0 off, 1 green, 2 orange, 3 not drawn
  d.speedKmh = (u[17] >> 6) & 1; // 1: km/h, 0: mph
  d.handsOn = (u[17] >> 7) & 1; // 1: hands-on-wheel warning

  // Brake temperature (vendor name brakeTemp), order FL, FR, RL, RR. 10 bits each, -40 degC offset.
  const w18 = u32(u, 18);
  d.brakeTempRaw = [bits(w18, 0, 10), bits(w18, 10, 10), bits(w18, 20, 10), (u[22] << 2) | bits(w18, 30, 2)];
  d.brakeTempC = d.brakeTempRaw.map(r => r - 40); // raw 0 (-40) = no value

  const w23 = u32(u, 23);
  d.blowerRpm = 5 * bits(w23, 0, 10);
  d.evapPowerW = 5 * bits(w23, 10, 11);
  d.cabinTempRaw = bits(w23, 21, 11);
  d.cabinTempC = 0.1 * d.cabinTempRaw - 40;
  d.ambientTempRaw = u[27];
  d.ambientTempC = 0.5 * d.ambientTempRaw - 40;

  const w28 = u32(u, 28);
  d.cellVoltageRaw = bits(w28, 0, 12);
  d.cellVoltageV = 0.002 * d.cellVoltageRaw;
  d.rangeRaw = bits(w28, 12, 10); // miles
  d.rangeKm = 1.61 * d.rangeRaw;
  d.batteryTempRaw = bits(w28, 22, 9);
  d.batteryTempC = 0.5 * d.batteryTempRaw - 40;

  const w31 = u[31] | (u[32] << 8);
  d.speedLimitRaw = bits(w31, 7, 5);
  d.speedLimit = 5 * d.speedLimitRaw; // the vendor shows it only in R, N, D
  d.blindSpot = [bits(w31, 12, 2), bits(w31, 14, 2)]; // left, right. 0 none, 1 yellow, 2 red, 3 not drawn
  return d;
}

// The prompt build has no altitude (it reads 0x39B in place of 0x3D8). It puts its own state in the
// 14 altitude bits. Only meaningful when the module runs the prompt build in a prompt mode.
//   bits 1:0 phase, 5:2 hands-on state, 9:6 AP state, 13:10 gestures sent (modulo 16)
export const PROMPT_PHASE = [
  ["Ready", "待命"],
  ["Prompt seen, scrolling soon", "检测到提示，即将拨动"],
  ["Scrolled, waiting for the prompt to clear", "已拨动，等待提示消失"],
  ["Prompt seen, but AP is not active", "检测到提示，但AP未激活"],
];
export function promptDiag(raw) {
  return { raw, phase: raw & 3, handsOn: (raw >> 2) & 15, apState: (raw >> 6) & 15, sent: (raw >> 10) & 15, noData: raw === 0 };
}

// Named views of the bit masks.
export function doorsOpen(d) {
  return { fl: !!(d.doors & 1), rl: !!(d.doors & 2), fr: !!(d.doors & 4), rr: !!(d.doors & 8) };
}
export function lightsOn(d) {
  const l = d.lights;
  return { highBeam: !!(l & 1), lowBeam: !!(l & 2), position: !!(l & 4), frontFog: !!(l & 8), rearFog: !!(l & 16), brake: !!(l & 32) };
}

// ---------------------------------------------------------------- display (vendor rules)
const pad2 = n => (n < 10 ? "0" + n : "" + n);
export const clockText = now => pad2(now.getHours()) + ":" + pad2(now.getMinutes());

// Elapsed time since the car went into D, as the vendor shows it: MM:SS or HH:MM:SS.
export function driveTimeText(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const t = pad2(Math.floor(s / 60) % 60) + ":" + pad2(s % 60);
  return h > 0 ? pad2(h) + ":" + t : t;
}

// Big centre text. Gear 1-4: speed, or the gear letter at speed 0. Other gears: the phone clock.
export function speedText(d, now) {
  if (d.gear >= 1 && d.gear <= 4) return d.speed === 0 ? GEAR[d.gear] : String(d.speed);
  return clockText(now);
}

// All strings and numbers the vendor page shows for one frame.
// prev: the result for the previous frame. A short frame keeps the extended values of prev.
export function formatGauge(d, now, prev) {
  const f = prev ? { ...prev, LeftBottom: [...prev.LeftBottom], RightBottom: [...prev.RightBottom] }
    : { LeftBottom: ["0.0km", "0m", "00:00", "00:00"], RightBottom: ["100%", "0km", "0.00V", "0℃"],
      brakeTemp: [0, 0, 0, 0], hvacBlowerSpeedRPM: 0, wattsDemandEvap: 0, hvacCabinTempEst: 0, tempAmbientRaw: 0,
      battHeat: 0, speedUnits: 1, handsOn: 0, fusedSpeedLimit: 0, blindSpotRear: [0, 0] };
  f.speedText = speedText(d, now);
  f.bigSpeed = d.gear >= 1 && d.gear <= 4; // large font for speed or gear letter, small for the clock
  f.gear = d.gear;
  f.turn = d.turn;
  f.autoPilot = d.autopilot;
  f.door = d.doors;
  f.light = d.lights;
  f.sport = d.sport;
  f.frunkIsOpen = d.frunkOpen;
  f.trunkIsOpen = d.trunkOpen;
  f.keepScreenOn = d.allowScreenSleep === 0;
  f.RightBottom[0] = d.batteryPct + "%";
  f.LeftBottom[0] = d.odometerKm.toFixed(1) + "km";
  f.Pressure = d.tirePressureRaw.map(r => (r === 0 || r === 255 ? 0 : (0.025 * r).toFixed(1)));
  f.accelPedalPos = d.accelPedalPct;
  f.rearInverterPower = d.rearPowerKw;
  f.frontInverterPower = d.frontPowerKw;
  if (d.full) {
    f.LeftBottom[1] = d.altitudeM + "m";
    f.battHeat = d.battHeat;
    f.speedUnits = d.speedKmh;
    f.handsOn = d.handsOn;
    f.brakeTemp = [...d.brakeTempC];
    f.hvacBlowerSpeedRPM = d.blowerRpm;
    f.wattsDemandEvap = d.evapPowerW;
    f.hvacCabinTempEst = d.cabinTempC.toFixed(1);
    f.tempAmbientRaw = d.ambientTempC.toFixed(1);
    f.RightBottom[2] = d.cellVoltageV.toFixed(2) + "V";
    f.RightBottom[1] = d.rangeKm.toFixed(0) + "km";
    f.RightBottom[3] = d.batteryTempC.toFixed(1) + "℃";
    f.fusedSpeedLimit = d.gear >= 2 && d.gear <= 4 ? d.speedLimit : 0;
    f.blindSpotRear = [...d.blindSpot];
  }
  return f;
}

// ---------------------------------------------------------------- drawing helpers
// Colours and rules from the vendor template. See the private spec for the full layout.
export const iconOff = lightTheme => (lightTheme ? "#E0E0E0" : "#393939");
export const textOn = lightTheme => (lightTheme ? "#373737" : "#DDD");
export const AUTOPILOT_COLOR = [null, "#1B66FF", "#22FF60", "#888"]; // null = iconOff()
export const BLIND_SPOT_RGB = ["0,255,0", "255,255,0", "255,0,0"]; // edge gradient colour by level
export const BATT_HEAT_COLOR = [null, "#22FF60", "#F6931F"];
export const TIRE_LOW_BAR = 2.2; // pressure <= 2.2 is drawn red (#F16A6A)
export const BRAKE_HOT_C = 120; // brake temperature >= 120 is drawn red (#F16A6A)

// Width of the power bar half, in percent of the half (0-100). Regen scale 65 kW, drive scale 160 kW.
export function powerBarPct(frontKw, rearKw) {
  const v = frontKw + rearKw;
  return Math.min(100, (Math.abs(v) / (v < 0 ? 65 : 160)) * 100);
}

// ---------------------------------------------------------------- 0-100 test
// State: 0 idle, 1 armed, 2 running. Long press on the speed toggles it.
export function accelTestToggle(state, d) {
  if (state !== 0) return { state: 0, zh: "百公里加速测试\r\n已退出", label: "0-100 test stopped" };
  if (!d || d.gear !== DRIVE_GEAR) return { state: 0, zh: "必须在 D 档下\r\n才能开始测式", label: "Shift to D first" };
  if (d.speed > 0) return { state: 0, zh: "车速必须为0\r\n才能开始测式", label: "Stop the car first" };
  return { state: 1, zh: "百公里加速测试\r\n准备就绪", label: "0-100 test ready" };
}

// Feed each frame. Uses the raw speed in car display units, so an mph car measures 0-100 mph.
export function accelTestStep(t, speed, nowMs) {
  if (t.state === 1 && speed > 0) return { state: 2, startMs: nowMs, event: "start" };
  if (t.state === 2 && speed >= 100) {
    const sec = ((nowMs - t.startMs) / 1000).toFixed(3);
    return { state: 0, startMs: t.startMs, event: sec <= 100 ? "result" : "tooSlow", seconds: sec };
  }
  return t;
}

// ---------------------------------------------------------------- gauge menu (phone-side only)
// The vendor stores these in phone storage under the key "gauge" as {id: value}.
// Nothing here goes to the module. Missing or bad values mean 0 (the default).
export const GAUGE_MENU = [
  { id: "gaugeType", zh: "仪表风格", label: "Gauge style",
    options: [[0, "Full gauge (default)", "全功能仪表(默认)"], [1, "Simple gauge", "简洁仪表"], [2, "New gauge (round dial)", "全新仪表"]] },
  { id: "gaugeAspect", zh: "仪表外观", label: "Appearance",
    options: [[0, "Follow car screen (default)", "跟随车机(默认)"], [1, "Dark", "深色外观"], [2, "Light", "浅色外观"]] },
  { id: "gaugeAspectBackground", zh: "深色背景", label: "Dark background",
    options: [[0, "Background image (default)", "黑色背景图(默认)"], [1, "Plain black", "纯黑背景"]] },
  { id: "gaugeLeftBottom", zh: "左下角显示", label: "Bottom-left value",
    options: [[0, "Odometer (default)", "总里程(默认)"], [1, "Altitude", "海拔高度"], [2, "Clock", "北京时间"], [3, "Drive time", "行驶时间"], [4, "Cycle", "自动循环显示"]] },
  { id: "gaugeRightBottom", zh: "右下角显示", label: "Bottom-right value",
    options: [[0, "Battery % (default)", "剩余电量(默认)"], [1, "Range", "剩余里程"], [2, "Cell voltage", "电池电芯电压"], [3, "Battery temperature", "动力电池温度"], [4, "Cycle", "自动循环显示"]] },
  { id: "gaugeTurnSignalStyle", zh: "转向灯样式", label: "Turn signal style",
    options: [[0, "Edge gradient (default)", "渐变背景(默认)"], [1, "Arrow", "箭头指示"]] },
  { id: "gaugeBrakeLight", zh: "刹车灯显示", label: "Brake light",
    options: [[0, "On (default)", "开启(默认)"], [1, "Off", "关闭"]] },
  { id: "gaugeHandsOn", zh: "方向盘手扶提示", label: "Hands-on-wheel warning",
    options: [[0, "On (default)", "开启(默认)"], [1, "Off", "关闭"]] },
  { id: "gaugeRainbow", zh: "AP彩虹之路", label: "AP rainbow road",
    options: [[0, "Off (default)", "关闭(默认)"], [1, "On", "开启"]] },
  { id: "gaugeAir", zh: "空调数据显示", label: "A/C data",
    options: [[0, "On (default)", "开启(默认)"], [1, "Off", "关闭"]] },
];
export const GAUGE_MENU_BY_ID = Object.fromEntries(GAUGE_MENU.map(m => [m.id, m]));

// Clean gauge preferences: every id present, every value a listed option, else 0.
export function normalizeGaugePrefs(obj) {
  const out = {};
  for (const m of GAUGE_MENU) {
    const v = obj && obj[m.id];
    out[m.id] = m.options.some(o => o[0] === v) ? v : 0;
  }
  return out;
}

// Bottom corner text index. Values 0-3 select one item. Value 4 cycles every 4 s.
export const CORNER_CYCLE = 4;
export const CORNER_CYCLE_MS = 4000;
