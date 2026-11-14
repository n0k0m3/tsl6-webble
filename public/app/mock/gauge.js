// Mock B0 gauge stream. B0 01 starts it (and keeps it alive), B0 00 stops it.
// Without a keep-alive for 3 s the mock stops too (the real behaviour is not known).
// While on, it sends a synthetic 33-byte frame every 200 ms from a 56 s drive cycle:
//   0-6 s P (front-left door open 1.5-4 s), 6 R, 7 N, 8-11 D at 0 (arm the 0-100 test here),
//   11-17 launch to 120 km/h (100 at 15 s), 17-30 cruise with AP, turn signal, blind spot, hands-on warning,
//   30-38 regen to 0, 38-41 D at 0, 41-44 reverse, 44-56 P (trunk 47-51 s, frunk 50-53 s).
// Battery heat follows the mock status (A7 04/05 from the Status page or the gauge).
import { registerMock, registerTicker } from "../mock.js";

const CYCLE_S = 56;
const FRAME_MS = 200;
const KEEPALIVE_TIMEOUT_MS = 3000;

let on = false, lastKeep = 0, lastSend = 0, t0 = 0, odo = 1234567; // odometer in 0.1 km

registerMock(0xb0, p => {
  if (p[0] === 1) {
    if (!on) { t0 = Date.now(); lastSend = 0; }
    on = true;
    lastKeep = Date.now();
  } else on = false;
  return null;   // the stream has no reply; the ticker sends the frames
});

// Write an unsigned (or two's complement) value at a bit position. Bits count little-endian over the payload.
function put(u, pos, width, v) {
  const m = width >= 31 ? 0x7fffffff : (1 << width) - 1;
  v &= m;
  for (let i = 0; i < width; i++) if ((v >> i) & 1) { const b = pos + i; u[b >> 3] |= 1 << (b & 7); }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const blink = t => Math.floor(t * 3) % 2 === 0;

function scene(t) {
  const s = { gear: 1, speed: 0, turn: 0, ap: 0, doors: 0, lights: 0b100, frunk: 0, trunk: 0, pedal: 0,
    front: 0, rear: 0, limit: 0, bs: [0, 0], hands: 0 };
  if (t < 6) { s.gear = 1; if (t >= 1.5 && t < 4) s.doors = 1; }
  else if (t < 7) s.gear = 2;
  else if (t < 8) s.gear = 3;
  else if (t < 11) { s.gear = 4; s.lights |= 32; }
  else if (t < 17) {
    s.gear = 4; s.speed = Math.round(clamp((t - 11) * 25, 0, 120));
    s.pedal = t < 16 ? 100 : 30; s.front = t < 16 ? 150 : 30; s.rear = t < 16 ? 220 : 40; s.lights |= 2;
  } else if (t < 30) {
    s.gear = 4; s.speed = Math.round(110 + 4 * Math.sin(t)); s.pedal = 20; s.front = 6; s.rear = 9; s.lights |= 2; s.limit = 100;
    if (t < 28) s.ap = 1;
    if (t >= 19 && t < 22 && blink(t)) s.turn = 1;
    if (t >= 23 && t < 25) s.bs[1] = 1;
    if (t >= 25 && t < 26.5) s.bs[1] = 2;
    if (t >= 26 && t < 28) s.hands = 1;
  } else if (t < 38) {
    s.gear = 4; s.speed = Math.round(clamp(110 * (1 - (t - 30) / 8), 0, 110)); s.front = -20; s.rear = -30; s.lights |= 2; s.limit = 80;
    if (t >= 34) s.lights |= 32;
    if (t >= 31 && t < 33 && blink(t)) s.turn = 2;
  } else if (t < 41) { s.gear = 4; s.lights |= 32; }
  else if (t < 44) { s.gear = 2; s.speed = 3; s.pedal = 8; s.rear = 4; s.bs[0] = t < 43 ? 1 : 0; }
  else {
    s.gear = 1;
    if (t >= 47 && t < 51) s.trunk = 1;
    if (t >= 50 && t < 53) s.frunk = 1;
  }
  return s;
}

function frame(t, mock) {
  const s = scene(t);
  odo += (s.speed * FRAME_MS) / 3600 / 100; // km/h over one frame, in 0.1 km
  const u = new Uint8Array(33);
  put(u, 0, 9, s.speed); put(u, 9, 3, s.gear); put(u, 12, 2, s.turn); put(u, 14, 2, s.ap);
  put(u, 16, 4, s.doors); put(u, 20, 4, s.lights & 15); put(u, 24, 7, 78); put(u, 31, 1, (s.lights >> 4) & 1);
  put(u, 32, 1, 0);                      // keep the phone screen on
  put(u, 33, 1, s.frunk); put(u, 34, 1, 0); put(u, 35, 1, 0); put(u, 36, 1, (s.lights >> 5) & 1); put(u, 37, 1, s.trunk);
  put(u, 38, 26, Math.round(odo));
  u.set([116, 117, 84, 116], 8);          // tire pressure 2.9, 2.9, 2.1 (low), 2.9 bar
  put(u, 96, 8, Math.round(s.pedal * 2.5));
  put(u, 104, 11, s.rear * 2); put(u, 115, 11, s.front * 2);
  put(u, 126, 14, 42);                    // altitude 42 m
  const heat = (mock.state[18] >> 1) & 1;  // mock status: battery preheat bit
  put(u, 140, 2, heat); put(u, 142, 1, 1); put(u, 143, 1, s.hands);
  const brake = t >= 30 && t < 44 ? 135 : 60;
  [brake, brake, 55, 55].forEach((c, i) => put(u, 144 + 10 * i, 10, c + 40));
  put(u, 184, 10, 300 / 5); put(u, 194, 11, 1200 / 5); put(u, 205, 11, Math.round((22.5 + 40) * 10));
  u[27] = Math.round((15 + 40) * 2);
  put(u, 224, 12, 1975); put(u, 236, 10, 250); put(u, 246, 9, Math.round((31 + 40) * 2));
  put(u, 255, 5, s.limit / 5); put(u, 260, 2, s.bs[0]); put(u, 262, 2, s.bs[1]);
  return u;
}

registerTicker(mock => {
  if (!mock.connected || !mock.auth) { on = false; return; }
  if (!on) return;
  const now = Date.now();
  if (now - lastKeep > KEEPALIVE_TIMEOUT_MS) { on = false; mock.log("mock: B0 stream stopped (no keep-alive)", "warn"); return; }
  if (now - lastSend < FRAME_MS) return;
  lastSend = now;
  mock.reply(0xb0, frame(((now - t0) / 1000) % CYCLE_S, mock));
});
