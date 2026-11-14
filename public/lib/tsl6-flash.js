// Firmware flash over BLE: image checks, the bootloader UID, and the two update sequences.
// Moved from flash.html, which flashed a module on the car (2026-11-13). Keep the timeouts, the try counts
// and the frame order as they are. flash.html keeps its own copy until a car flash passes with the app page.
//
// The link interface (app/ble.js LinkBase):
//   request(cmd, payload, {timeout, tries}) -> reply frame {cmd, payload} or null
//   chunk (bytes per BLE write), log(msg, cls)

export const PAGE = 1026, PAYLOAD = 1024, MAX_PAGES = Math.floor(0x17F00 / PAYLOAD) + 1;
export const TARGET_RUNTIME = 1;
export const SAFE_CHUNK = 20;
export const BOOT_WINDOW_MS = 10000; // the bootloader goes back to the runtime after about 10 s without a valid 0x53

export const KNOWN_IMAGES = {
  "b1b2a3aa5e71d88336719bccb5da822faffc05acf50b5b482e570f1981dabbd5": "original June 2026 dump (runtime V1.0.00, HAS the vendor backdoor)",
  "7008bd0d6802de2daa9fb7743f3cc460f21dbaa35c799c94c55082c6d93093af": "secured build (June 2026 dump, backdoor removed)",
};
export const SECURED_SHA = "7008bd0d6802de2daa9fb7743f3cc460f21dbaa35c799c94c55082c6d93093af";
// The secured build is served by the live site only (not in git). Both images sit next to index.html.
export const SECURED_URL = new URL("../runtime-nokey.bin", import.meta.url).href;
export const DUMP_URLS = [
  new URL("../runtime.bin", import.meta.url).href,
  "https://raw.githubusercontent.com/LQCross/TSL6-Firmware/main/latest-tsl6-535C62E239E339E31475FB10/runtime/runtime.bin",
];
// Passphrase guard for the original build (PBKDF2-SHA256 of the passphrase; the passphrase itself is not in this file).
export const ORIG_GATE = {"iter":310000,"salt":"4sUMFTXPS/rKVezhcX4RWw==","hash":"17a4238a52b63c3c047efb48bef5e65c4ce85537c19dfad1d474ec61d41b4365"};

export const lhex = u8 => Array.from(u8, b => b.toString(16).padStart(2, "0")).join("");

// Status mode, from byte 3 bit 0. Runtime status: 18 bytes or more. Bootloader status: 16 bytes or more.
export const inRuntime = st => !!(st && st.length >= 18 && (st[3] & 1));
export const inBoot = st => !!(st && st.length >= 16 && !(st[3] & 1));

// Bootloader UID14 from the 12-byte module ID in the boot-mode status (proven on hardware 2026-11-12).
export function uid14(id) {
  const t = id.trim();
  if (!/^[0-9a-fA-F]{24}$/.test(t)) return null;
  const raw = new Uint8Array(12);
  for (let i = 0; i < 12; i++) raw[i] = parseInt(t.substr(i * 2, 2), 16);
  const u = new Uint8Array(14);
  u.set(raw.slice(4, 12), 0);
  u.set(raw.slice(0, 6), 8);
  return u;
}

// 0x55 / 0x53 / 0x45 argument: target 01 + UID14.
export function bootArg(uid) {
  const arg = new Uint8Array(15);
  arg[0] = TARGET_RUNTIME;
  arg.set(uid, 1);
  return arg;
}
// Runtime 0x55 argument: 01 + status bytes 4-17 as sent (no password needed).
export function restartArg(status) {
  const arg = new Uint8Array(15);
  arg[0] = 1;
  arg.set(status.slice(4, 18), 1);
  return arg;
}

export function parseImage(buf) {
  const u8 = new Uint8Array(buf);
  const first = u8.find(b => b > 0x20);
  if (first === 0x7b) { // JSON reply of the vendor server
    const j = JSON.parse(new TextDecoder().decode(u8));
    if (!j.success) throw new Error(`server JSON reports failure: ${j.msg}`);
    return j.hex.map(h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16))));
  }
  if (u8.length % PAGE) throw new Error(`file size ${u8.length} is not a multiple of ${PAGE}`);
  const out = [];
  for (let i = 0; i < u8.length; i += PAGE) out.push(u8.slice(i, i + PAGE));
  return out;
}

export function checkPages(p) {
  const problems = [];
  if (!p.length) return ["image has no pages"];
  if (p.length > MAX_PAGES) problems.push(`${p.length} pages is more than the slot holds (${MAX_PAGES})`);
  p.forEach((pg, i) => {
    if (pg.length !== PAGE) problems.push(`page ${i}: ${pg.length} bytes, expected ${PAGE}`);
    else if (((pg[0] << 8) | pg[1]) !== i) problems.push(`page ${i}: index field is ${(pg[0] << 8) | pg[1]}`);
  });
  const counts = new Uint32Array(256);
  let total = 0;
  for (const pg of p) for (let i = 2; i < pg.length; i++) { counts[pg[i]]++; total++; }
  let top = 0;
  for (let v = 1; v < 256; v++) if (counts[v] > counts[top]) top = v;
  if (counts[top] > total * 0.5) problems.push(`${Math.floor(counts[top] * 100 / total)}% of the image is byte 0x${top.toString(16).padStart(2, "0")}: filler, not code`);
  if ((p[0][2] & 0x7f) !== 0x6f) problems.push(`first instruction is not a jump (${lhex(p[0].slice(2, 6))})`);
  return problems;
}

export function contains(p, text) {
  const needle = new TextEncoder().encode(text);
  const all = new Uint8Array(p.length * PAYLOAD);
  p.forEach((pg, i) => all.set(pg.slice(2), i * PAYLOAD));
  outer: for (let i = 0; i <= all.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (all[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export const sha256hex = async buf => lhex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));

// Parse and check an image. Returns {pages (null if rejected), problems, lines, sha}. Throws on a parse error.
export async function inspectImage(buf, source) {
  const p = parseImage(buf);
  const sha = await sha256hex(buf);
  const problems = checkPages(p);
  const lines = [
    `source: ${source}`,
    `pages: ${p.length}  payload: ${p.length * PAYLOAD} bytes`,
    `sha256: ${sha}`,
    KNOWN_IMAGES[sha] ? `known image: ${KNOWN_IMAGES[sha]}` : "unknown image (not a build this page knows)",
    `contains "TSL6": ${contains(p, "TSL6")}   contains "CH32V20x_BLE_LIB": ${contains(p, "CH32V20x_BLE_LIB")}`,
  ];
  return { pages: problems.length ? null : p, problems, lines, sha };
}

export async function origPassOk(pass) {
  const salt = Uint8Array.from(atob(ORIG_GATE.salt), c => c.charCodeAt(0));
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ORIG_GATE.iter }, k, 256));
  return lhex(bits) === ORIG_GATE.hash;
}

// Fetch helpers. fetchFn is injectable for tests.
export async function fetchSecured(fetchFn = fetch) {
  const r = await fetchFn(SECURED_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const sha = await sha256hex(buf);
  if (sha !== SECURED_SHA) throw new Error(`hash ${sha.slice(0, 16)}... is not the secured build`);
  return { buf, url: SECURED_URL };
}
export async function fetchStock(log, fetchFn = fetch) {
  for (const url of DUMP_URLS) {
    try {
      const r = await fetchFn(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { buf: await r.arrayBuffer(), url };
    } catch (e) { log(`fetch ${url}: ${e.message}`, "warn"); }
  }
  throw new Error("could not load the dump from any source");
}

// Drop to 20 bytes (always safe) after missed page replies with large writes.
// It changes the link for this session only. The saved setting (Device tab) stays.
function fallbackChunk(link, why) {
  if (link.chunk <= SAFE_CHUNK) return false;
  link.log(`${why}: bytes per BLE write ${link.chunk} -> ${SAFE_CHUNK}`, "warn");
  link.chunk = SAFE_CHUNK;
  return true;
}

// Bootloader update: 0x55 prepare, 0x53 start, 0x57 per page, 0x45 finish.
// The caller checks that the module is in boot mode. onPage(done, total, seconds) reports progress.
export async function flashPages(link, pages, uid, { onPage = () => {}, now = () => performance.now() } = {}) {
  const arg = bootArg(uid);

  let r = await link.request(0x55, arg, { timeout: 2000, tries: 3 });
  if (r === null || (r.payload.length && r.payload[0] !== 0)) throw new Error(`0x55 prepare failed (reply ${r ? lhex(r.payload) : "none"}). Wrong module ID, or not in boot mode`);
  link.log("0x55 prepare: OK", "ok");

  r = await link.request(0x53, arg, { timeout: 3000, tries: 3 });
  if (r === null || (r.payload.length && r.payload[0] === 0xff)) throw new Error(`0x53 start failed (reply ${r ? lhex(r.payload) : "none"})`);
  link.log("0x53 start: OK, boot flag set to update mode", "ok");

  const t0 = now();
  for (let i = 0; i < pages.length; i++) {
    r = await link.request(0x57, pages[i], { timeout: 1200, tries: link.chunk > SAFE_CHUNK ? 3 : 10 });
    if (r === null && fallbackChunk(link, `page ${i}: no reply 3 times`)) r = await link.request(0x57, pages[i], { timeout: 1200, tries: 10 });
    if (r === null) throw new Error(`page ${i} failed 10 times. The module stays in the bootloader. Retry the flash`);
    onPage(i + 1, pages.length, (now() - t0) / 1000);
  }
  link.log(`all ${pages.length} pages written`, "ok");

  r = await link.request(0x45, arg, { timeout: 3000, tries: 3 });
  if (r === null) throw new Error("0x45 finish: no reply. Power-cycle the module and read status");
  link.log("0x45 finish: OK. The module now jumps to the new runtime and drops the connection", "ok");
}

// Runtime 0x55: the runtime replies 55 01, drops BLE after 200 ms, sets boot flag mode 1 and resets after 400 ms.
// Returns the reply or null. The caller then waits for the drop and reconnects at once (see reconnectFast).
export async function requestRestart(link, status) {
  const r = await link.request(0x55, restartArg(status), { timeout: 1500, tries: 1 });
  link.log(r ? `55 reply ${lhex(r.payload)}: the module restarts into boot mode` : "no 55 reply. The module may already be restarting", r ? "ok" : "warn");
  return r;
}

// Reconnect to the same device after the restart. Keep trying, like the vendor app (it retries every 1 s).
// A connect can fail at once while the bootloader is not advertising yet, so one try is not enough.
// attach(): open GATT and read the status. keepGoing(): false stops the loop (flash started, or the user connected).
// onDropped(): called after the wait for the drop, before the loop (the page enables Connect again there).
export async function reconnectFast({ attach, connected, keepGoing, close, log, sleep, onDropped = () => {} }) {
  for (let t = 0; connected() && t < 30; t++) await sleep(100); // wait for the drop (about 200 ms)
  onDropped();
  await sleep(700);
  const deadline = Date.now() + 8000;
  for (let a = 1; keepGoing() && !connected() && Date.now() < deadline; a++) {
    const left = deadline - Date.now();
    try {
      await Promise.race([attach(), sleep(Math.min(3000, left)).then(() => { throw new Error("timeout"); })]);
    } catch (e) {
      if (connected()) break; // attach finished late
      log(`reconnect try ${a}: ${e.name || "Error"}: ${e.message}`, "warn");
      try { close(); } catch (_) { /* not connected */ }
      await sleep(500);
    }
  }
  return connected();
}
