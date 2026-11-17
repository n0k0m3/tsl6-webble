// Tests for lib/tsl6-flash.js: image checks, UID14, and the bootloader frame sequence on a fake link.
// No vendor code needed:  node test/flash.mjs
// If public/runtime.bin or public/runtime-nokey.bin is present, the test also checks their hashes.
import fs from "node:fs";
import assert from "node:assert/strict";
import * as F from "../public/lib/tsl6-flash.js";

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} - ${name}`); };
const toHex = u8 => Buffer.from(u8).toString("hex");

// Synthetic image: pages with the right index, a RISC-V jump first, mixed bytes.
function image(nPages, { filler = false, badIndex = -1 } = {}) {
  const buf = new Uint8Array(nPages * F.PAGE);
  for (let i = 0; i < nPages; i++) {
    const o = i * F.PAGE;
    const idx = i === badIndex ? i + 1 : i;
    buf[o] = idx >> 8; buf[o + 1] = idx & 0xff;
    for (let j = 2; j < F.PAGE; j++) buf[o + j] = filler ? 0x31 : (i * 7 + j * 13) & 0xff;
  }
  buf[2] = 0x6f; // jal
  return buf;
}

// Fake link: replies come from reply(cmd, payload, call) -> payload array, or null for "no reply after all tries".
function fakeLink(reply, chunk = 240) {
  const calls = [], logs = [];
  return {
    chunk, calls, logs,
    log: (msg, cls) => logs.push([msg, cls]),
    async request(cmd, payload, { timeout, tries }) {
      const call = { cmd, payload: Uint8Array.from(payload), timeout, tries };
      calls.push(call);
      const r = reply(cmd, payload, call, calls);
      return r == null ? null : { cmd, payload: Uint8Array.from(r) };
    },
  };
}
const okReply = () => [0];

await test("uid14 follows module_id[4:12] + module_id[0:6]", () => {
  assert.equal(toHex(F.uid14("0102030405060708090A0B0C")), "05060708090a0b0c010203040506");
  assert.equal(toHex(F.uid14(" a8a9aaaba0a1a2a3a4a5a6a7 ")), "a0a1a2a3a4a5a6a7a8a9aaaba0a1");
  assert.equal(F.uid14("01020304"), null);
  assert.equal(F.uid14("zz02030405060708090A0B0C"), null);
});

await test("boot and restart arguments", () => {
  const uid = F.uid14("0102030405060708090A0B0C");
  assert.equal(toHex(F.bootArg(uid)), "01" + toHex(uid));
  const st = new Uint8Array(76); for (let i = 0; i < 76; i++) st[i] = i;
  assert.equal(toHex(F.restartArg(st)), "01" + toHex(st.slice(4, 18)));
});

await test("mode from status byte 3 bit 0", () => {
  const rt = new Uint8Array(76); rt[3] = 1;
  const bt = new Uint8Array(16);
  assert.ok(F.inRuntime(rt) && !F.inBoot(rt));
  assert.ok(F.inBoot(bt) && !F.inRuntime(bt));
  assert.ok(!F.inBoot(new Uint8Array(15)) && !F.inRuntime(null));
});

await test("good image passes the checks", async () => {
  const r = await F.inspectImage(image(72), "test");
  assert.deepEqual(r.problems, []);
  assert.equal(r.pages.length, 72);
  assert.match(r.lines.join("\n"), /pages: 72 {2}payload: 73728 bytes/);
});

await test("filler, a bad index and a missing jump are rejected", async () => {
  const fill = await F.inspectImage(image(10, { filler: true }), "test");
  assert.equal(fill.pages, null);
  assert.ok(fill.problems.some(p => /filler, not code/.test(p)));
  const idx = await F.inspectImage(image(5, { badIndex: 3 }), "test");
  assert.ok(idx.problems.some(p => /page 3: index field is 4/.test(p)));
  const nojump = image(5); nojump[2] = 0x13;
  assert.ok(F.checkPages(F.parseImage(nojump)).some(p => /first instruction is not a jump/.test(p)));
  assert.ok(F.checkPages(F.parseImage(image(F.MAX_PAGES + 1))).some(p => /more than the slot holds/.test(p)));
});

await test("parseImage: wrong size throws, vendor JSON is read", () => {
  assert.throws(() => F.parseImage(new Uint8Array(F.PAGE + 1)), /not a multiple of 1026/);
  const pages = F.parseImage(image(2));
  const json = JSON.stringify({ success: true, hex: pages.map(p => Buffer.from(p).toString("hex")) });
  assert.deepEqual(F.parseImage(new TextEncoder().encode("  " + json)), pages);
  assert.throws(() => F.parseImage(new TextEncoder().encode('{"success":false,"msg":"no"}')), /server JSON reports failure: no/);
});

await test("flashPages sends 55, 53, every page, 45 with the bootloader argument", async () => {
  const pages = F.parseImage(image(4));
  const uid = F.uid14("0102030405060708090A0B0C");
  const link = fakeLink(okReply);
  const seen = [];
  await F.flashPages(link, pages, uid, { onPage: (d, t) => seen.push(`${d}/${t}`), now: () => 0 });
  assert.deepEqual(link.calls.map(c => c.cmd), [0x55, 0x53, 0x57, 0x57, 0x57, 0x57, 0x45]);
  const arg = toHex(F.bootArg(uid));
  for (const c of [link.calls[0], link.calls[1], link.calls[6]]) assert.equal(toHex(c.payload), arg);
  assert.deepEqual(link.calls.slice(2, 6).map(c => toHex(c.payload)), pages.map(toHex));
  assert.deepEqual(link.calls.map(c => [c.timeout, c.tries]), [[2000, 3], [3000, 3], [1200, 3], [1200, 3], [1200, 3], [1200, 3], [3000, 3]]);
  assert.deepEqual(seen, ["1/4", "2/4", "3/4", "4/4"]);
});

await test("flashPages: 55 refused, 53 refused, 45 silent", async () => {
  const pages = F.parseImage(image(1));
  const uid = F.uid14("0102030405060708090A0B0C");
  await assert.rejects(F.flashPages(fakeLink(c => (c === 0x55 ? [1] : [0])), pages, uid), /0x55 prepare failed \(reply 01\)/);
  await assert.rejects(F.flashPages(fakeLink(c => (c === 0x53 ? [0xff] : [0])), pages, uid), /0x53 start failed \(reply ff\)/);
  await assert.rejects(F.flashPages(fakeLink(c => (c === 0x45 ? null : [0])), pages, uid), /0x45 finish: no reply/);
});

await test("flashPages: missed page replies drop the write size to 20 and retry", async () => {
  const pages = F.parseImage(image(3));
  const uid = F.uid14("0102030405060708090A0B0C");
  let misses = 0;
  const link = fakeLink((cmd, p) => (cmd === 0x57 && p[1] === 1 && misses++ === 0 ? null : [0]), 240);
  await F.flashPages(link, pages, uid);
  assert.equal(link.chunk, 20);
  const pageCalls = link.calls.filter(c => c.cmd === 0x57).map(c => [c.payload[1], c.tries]);
  assert.deepEqual(pageCalls, [[0, 3], [1, 3], [1, 10], [2, 10]]);
  assert.ok(link.logs.some(([m]) => /page 1: no reply 3 times: bytes per BLE write 240 -> 20/.test(m)));
  // Already at 20: 10 tries, then the flash stops.
  const slow = fakeLink((cmd, p) => (cmd === 0x57 && p[1] === 1 ? null : [0]), 20);
  await assert.rejects(F.flashPages(slow, pages, uid), /page 1 failed 10 times/);
  assert.deepEqual(slow.calls.filter(c => c.cmd === 0x57).map(c => c.tries), [10, 10]);
});

await test("requestRestart sends 01 + status bytes 4-17 once", async () => {
  const st = new Uint8Array(76); st[3] = 1; for (let i = 4; i < 18; i++) st[i] = 0xa0 + i;
  const link = fakeLink(() => [1]);
  const r = await F.requestRestart(link, st);
  assert.equal(toHex(r.payload), "01");
  assert.deepEqual(link.calls.map(c => [c.cmd, toHex(c.payload), c.timeout, c.tries]), [[0x55, toHex(F.restartArg(st)), 1500, 1]]);
});

await test("reconnectFast retries until attach works, and stops when told", async () => {
  let up = true, tries = 0, dropped = 0;
  let first = true;
  const sleep = () => { if (first) { up = false; first = false; } return Promise.resolve(); }; // the link drops during the first wait
  const ok = await F.reconnectFast({
    attach: async () => { if (++tries < 3) throw Object.assign(new Error("no"), { name: "NetworkError" }); up = true; },
    connected: () => up, keepGoing: () => true, close: () => {}, log: () => {}, sleep, onDropped: () => dropped++,
  });
  assert.equal(ok, true); assert.equal(tries, 3); assert.equal(dropped, 1);
  let calls = 0;
  const stopped = await F.reconnectFast({
    attach: async () => { calls++; }, connected: () => false, keepGoing: () => false, close: () => {}, log: () => {}, sleep: () => Promise.resolve(),
  });
  assert.equal(stopped, false); assert.equal(calls, 0);
});

await test("passphrase gate rejects a wrong passphrase", async () => {
  assert.equal(await F.origPassOk("not-the-passphrase"), false);
});

for (const [file, sha] of [["public/runtime-nokey.bin", F.SECURED_SHA], ["public/runtime-prompt.bin", F.PROMPT_SHA], ["public/runtime-prompt-v1.bin", F.PROMPT_V1_SHA], ["public/runtime.bin", "b1b2a3aa5e71d88336719bccb5da822faffc05acf50b5b482e570f1981dabbd5"]]) {
  const path = new URL(`../${file}`, import.meta.url);
  if (!fs.existsSync(path)) { console.log(`skip - ${file} is not here`); continue; }
  await test(`${file} is the known image and passes the checks`, async () => {
    const r = await F.inspectImage(fs.readFileSync(path), file);
    assert.equal(r.sha, sha);
    assert.deepEqual(r.problems, []);
    assert.equal(r.pages.length, 72);
  });
}
console.log(`all ${n} tests passed`);
