// Capture of the BLE board (firmware 0.4.0 and later): packet codec, commands and the recorder that makes the file.
// Pure functions: no BLE, no DOM. Works in the browser and in Node.
// The firmware defines the packets: ble-board/main/scrl_capture.h. test/scrl.mjs checks this file against the
// packets that the firmware packers make (test/fixtures/scrl-protocol.json, "capture").
//
// While a capture runs, the board stays in Listen-Only: it sends no frame, and Scroll Ack makes no tick.

export const CAP = Object.freeze({
  HDR_LEN: 8, REC_LEN: 16, ID_REC_LEN: 24, MARK_LEN: 8, STATE_LEN: 20,
  FRAMES: 1, IDS: 2, MARK: 3, STATE: 4,
  MODE_PLAN: 0, MODE_ALL: 1, MODE_LIST: 2, LIST_MAX: 64,
});
// Command codes: SCRL_CMD_CAPTURE_* in scrl_ble.h (lib/scrl.js CMD has them too).
const START = 7, STOP = 8, MARK = 9;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const hex2 = v => v.toString(16).toUpperCase().padStart(2, "0");
export const idText = id => id.toString(16).toUpperCase().padStart(3, "0");
const dataText = (b, o, n) => { let s = ""; for (let i = 0; i < n; i++) s += hex2(b[o + i]); return s; };

// Start command. mode = CAP.MODE_*; ids only for CAP.MODE_LIST.
export function captureStartCommand(mode, ids = []) {
  if (![CAP.MODE_PLAN, CAP.MODE_ALL, CAP.MODE_LIST].includes(mode)) throw new Error(`capture mode ${mode}`);
  if (mode !== CAP.MODE_LIST && ids.length) throw new Error("only a list start takes IDs");
  if (mode === CAP.MODE_LIST && (!ids.length || ids.length > CAP.LIST_MAX)) throw new Error(`1 to ${CAP.LIST_MAX} IDs`);
  const b = new Uint8Array(2 + ids.length * 2);
  b[0] = START; b[1] = mode;
  ids.forEach((id, i) => {
    if (!Number.isInteger(id) || id < 0 || id > 0x7FF) throw new Error(`ID ${id}: a standard ID is 0 to 7FF`);
    b[2 + i * 2] = id & 0xFF; b[3 + i * 2] = id >> 8;
  });
  return b;
}
// The ID list that a person types: hex IDs, split by commas or spaces, "0x" optional ("399, 0x39B").
// Returns the IDs in the typed order, each one once. Throws with a text for the person on a bad list.
export function parseCaptureIds(text) {
  const words = String(text || "").split(/[\s,;]+/).filter(Boolean);
  if (!words.length) throw new Error("type 1 or more IDs");
  const ids = [];
  for (const w of words) {
    const hex = w.replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,3}$/i.test(hex)) throw new Error(`"${w}" is not a hex ID`);
    const id = parseInt(hex, 16);
    if (id > 0x7FF) throw new Error(`${w}: a standard ID is 0 to 7FF`);
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > CAP.LIST_MAX) throw new Error(`at most ${CAP.LIST_MAX} IDs`);
  return ids;
}
export const captureStopCommand = () => Uint8Array.of(STOP);
export function captureMarkCommand(step) {
  if (!Number.isInteger(step) || step < 0 || step > 255) throw new Error(`step ${step}`);
  return Uint8Array.of(MARK, step);
}

// One packet. Throws on a length that does not fit its type.
export function parseCapturePacket(b) {
  if (b.length < CAP.HDR_LEN) throw new Error(`capture packet: ${b.length} bytes`);
  const p = { type: b[0], count: b[1], seq: u16(b, 2), ringLost: u32(b, 4) };
  const body = b.length - CAP.HDR_LEN;
  const need = n => { if (body !== n) throw new Error(`capture packet type ${p.type}: ${body} bytes, want ${n}`); };
  if (p.type === CAP.FRAMES) {
    need(p.count * CAP.REC_LEN);
  } else if (p.type === CAP.IDS) {
    need(p.count * CAP.ID_REC_LEN);
    p.ids = [];
    for (let i = 0; i < p.count; i++) {
      const o = CAP.HDR_LEN + i * CAP.ID_REC_LEN;
      p.ids.push({ id: u16(b, o), dlc: b[o + 2], frames: u32(b, o + 4), firstMs: u32(b, o + 8), lastMs: u32(b, o + 12),
        data: dataText(b, o + 16, Math.min(8, b[o + 2])) });
    }
  } else if (p.type === CAP.MARK) {
    need(CAP.MARK_LEN);
    p.mark = { t: u32(b, 8), step: b[12] };
  } else if (p.type === CAP.STATE) {
    need(CAP.STATE_LEN);
    p.state = { t: u32(b, 8), running: b[12] === 1, mode: b[13], ids: u16(b, 14), rxAll: u32(b, 16), rxQueueLost: u32(b, 20), ext: u32(b, 24) };
  } else {
    throw new Error(`capture packet type ${p.type}`);
  }
  return p;
}

// The frames of a FRAMES packet: [t_ms, id, dlc, lostBefore, data hex].
export function packetFrames(b) {
  const out = [];
  for (let i = 0; i < b[1]; i++) {
    const o = CAP.HDR_LEN + i * CAP.REC_LEN, dlc = Math.min(8, b[o + 6]);
    out.push([u32(b, o), u16(b, o + 4), dlc, (b[o + 7] & 1) === 1, dataText(b, o + 8, dlc)]);
  }
  return out;
}

// Collects the packets of one capture and writes the file. It keeps the raw FRAMES packets (16 bytes per frame),
// not one object per frame: a long drive can bring a million frames.
export class CaptureRecorder {
  constructor(meta = {}) {
    this.meta = meta;          // board name, firmware, mode: goes into the file head
    this.startedAt = new Date();
    this.packets = [];         // FRAMES packets (Uint8Array copies)
    this.frames = 0;           // frames received
    this.flaggedLost = 0;      // records that say "frames were lost before me"
    this.ringLost = 0;         // highest ring_lost that a header showed
    this.seqGaps = [];         // [after this many frames, packets missing]
    this.expectSeq = null;
    this.marks = [];           // { t, step }
    this.ids = new Map();      // id -> latest ID table entry
    this.state = null;         // latest state
    this.firstState = null;
    this.firstT = null; this.lastT = null;
    this.duplicates = 0;       // packets that came two times (the browser or the link gave them again)
    this.last = null;
  }
  // Takes one packet. Returns the parsed packet, or null for an exact repeat of the last one: each packet has its own
  // sequence number, so the same bytes again are the same packet.
  add(bytes) {
    if (this.last && this.last.length === bytes.length && this.last.every((v, i) => v === bytes[i])) { this.duplicates++; return null; }
    const p = parseCapturePacket(bytes);
    this.last = bytes.slice();
    if (this.expectSeq !== null && p.seq !== this.expectSeq) {
      this.seqGaps.push([this.frames, (p.seq - this.expectSeq + 0x10000) & 0xFFFF]);
    }
    this.expectSeq = (p.seq + 1) & 0xFFFF;
    this.ringLost = Math.max(this.ringLost, p.ringLost);
    if (p.type === CAP.FRAMES) {
      const copy = bytes.slice();
      this.packets.push(copy);
      this.frames += p.count;
      for (let i = 0; i < p.count; i++) {
        const o = CAP.HDR_LEN + i * CAP.REC_LEN;
        if (copy[o + 7] & 1) this.flaggedLost++;
      }
      if (p.count) {
        if (this.firstT === null) this.firstT = u32(copy, CAP.HDR_LEN);
        this.lastT = u32(copy, CAP.HDR_LEN + (p.count - 1) * CAP.REC_LEN);
      }
    } else if (p.type === CAP.IDS) {
      for (const e of p.ids) this.ids.set(e.id, e);
    } else if (p.type === CAP.MARK) {
      this.marks.push(p.mark);
    } else if (p.type === CAP.STATE) {
      if (!this.firstState) this.firstState = p.state;
      this.state = p.state;
    }
    return p;
  }
  // Frames that the CAN task queue lost during this capture (its counter runs since power-on).
  get queueLost() { return this.state && this.firstState ? this.state.rxQueueLost - this.firstState.rxQueueLost : 0; }
  get packetsMissing() { return this.seqGaps.reduce((n, [, k]) => n + k, 0); }
  get seconds() { return this.firstT === null ? 0 : (this.lastT - this.firstT) / 1000; }
  // The ID table, busiest first, with the period in ms.
  idTable() {
    return [...this.ids.values()].map(e => ({ ...e, periodMs: e.frames > 1 ? (e.lastMs - e.firstMs) / (e.frames - 1) : 0 }))
      .sort((a, b) => b.frames - a.frames || a.id - b.id);
  }

  // The file: candump log format ("(seconds) can0 ID#DATA"), board time. Lines that start with "#" are notes:
  // the step marks, the gaps, and the ID table at the end. stepText(step) gives the text of a step mark.
  toText(stepText = () => "") {
    const out = [];
    const m = this.meta;
    out.push(`# BLE board capture, ${this.startedAt.toISOString()}`);
    out.push(`# board ${m.board || "?"}, firmware ${m.fw || "?"}, mode ${m.mode ?? "?"}, time = board ms / 1000`);
    out.push(`# frames ${this.frames}, lost in the board ring ${this.ringLost}, lost in the CAN queue ${this.queueLost}, packets missing ${this.packetsMissing}, duplicate packets dropped ${this.duplicates}`);
    const marks = [...this.marks].sort((a, b) => a.t - b.t);
    let mi = 0, gi = 0, n = 0;
    const markLine = mk => `# step ${mk.step} at ${(mk.t / 1000).toFixed(3)}${stepText(mk.step) ? `: ${stepText(mk.step)}` : ""}`;
    for (const b of this.packets) {
      for (const [t, id, dlc, lost, data] of packetFrames(b)) {
        while (mi < marks.length && marks[mi].t <= t) out.push(markLine(marks[mi++]));
        while (gi < this.seqGaps.length && this.seqGaps[gi][0] <= n) out.push(`# gap: ${this.seqGaps[gi++][1]} packet(s) missing here`);
        if (lost) out.push("# frames lost in the board ring before the next frame");
        out.push(`(${(t / 1000).toFixed(3)}) can0 ${idText(id)}#${data}`);
        n++;
      }
    }
    while (mi < marks.length) out.push(markLine(marks[mi++]));
    out.push("# ID table: id, frames, period ms, dlc, last data");
    for (const e of this.idTable()) out.push(`# id ${idText(e.id)} ${e.frames} ${e.periodMs.toFixed(1)} ${e.dlc} ${e.data}`);
    return out.join("\n") + "\n";
  }
}
