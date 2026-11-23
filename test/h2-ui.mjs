// Browser test of the app with the BLE board, in headless Chrome. It needs playwright-core and a Chrome or Chromium:
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs CHROME=/usr/bin/google-chrome node test/h2-ui.mjs
//
// Without PLAYWRIGHT_CORE the test looks for the package "playwright-core". Without it, the test skips.
// The test serves public/ on 127.0.0.1 itself.
//
// Three groups:
//   1. ?mock=h2: the app with the mock board.
//   2. No mock, and a fake navigator.bluetooth with a board behind it: the real connect path and GattTransport.
//   3. The same fake with a TSL6 behind it (the mock module of the app): the real connect path and WebLink.
//      The connect path of the TSL6 changed when the chooser learned the board, so it is checked here too.
// All groups answer from the mocks in the app. They prove the wiring of the app, not a module, not a board and not
// a real Bluetooth stack.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
const spec = process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core";
const pw = await import(spec).catch(() => null);
if (!pw) { console.log("# skip: playwright-core not found. Set PLAYWRIGHT_CORE to its index.mjs"); process.exit(0); }
const { chromium } = pw;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split("?")[0]).replace(/^\/$/, "/index.html"));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

// A small image with the layout of an ESP-IDF app: header, one segment header, app description, the board
// descriptor of the firmware (offset 288), SHA-256 at the end.
const CHIPS = { esp32: 0x00, esp32s3: 0x09, esp32h2: 0x10 };
function image(project, { version = "9.9.9", size = 64 * 1024, board = "nanoh2-minican", chip = "esp32h2", can = "twai" } = {}) {
  const b = Buffer.alloc(size);
  for (let i = 400; i < size - 32; i++) b[i] = (i * 31 + 7) & 0xFF;
  b[0] = 0xE9; b[1] = 1; b[12] = CHIPS[chip]; b[23] = 1;
  b.writeUInt32LE(0xABCD5432, 32);
  b.write(version, 32 + 16); b.write(project, 32 + 48); b.write("12:00:00", 32 + 80); b.write("Jan  1 2026", 32 + 96); b.write("v5.5.6", 32 + 112);
  b.writeUInt32LE(0x4C524353, 288); b.writeUInt32LE(1, 292); b.write(board, 296); b.write(can, 328);
  crypto.createHash("sha256").update(b.subarray(0, size - 32)).digest().copy(b, size - 32);
  return { name: `scrl-${board}${can === "twai" ? "" : "-can1"}.bin`, mimeType: "application/octet-stream", buffer: b };
}
const BIN = image("scrl-ble-board"), HELLO = image("hello_world");
const T2 = image("scrl-ble-board", { board: "lilygo-t2can", chip: "esp32s3" });
const T2_CAN1 = image("scrl-ble-board", { board: "lilygo-t2can", chip: "esp32s3", can: "mcp2515" });
const WAVESHARE = image("scrl-ble-board", { board: "waveshare-s3-can", chip: "esp32s3" });

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true });
const results = [];
async function scenario(name, query, { init, ...opts }, fn) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, ...opts });
  const page = await ctx.newPage();
  if (init) await page.addInitScript(init[0], init[1]);
  const errors = [];
  page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.goto(`${base}?${query}`);
  await page.waitForSelector("#tabs .tab");
  try {
    await fn(page);
    assert.deepEqual(errors, []);
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message.split("\n").slice(0, 3).join(" ")}`);
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `fail-${name}.png`), fullPage: true });
  }
  await ctx.close();
}
const text = (page, sel) => page.locator(sel).innerText();
const ids = (page, sel, attr) => page.$$eval(sel, (els, a) => els.map(e => e.getAttribute(a)), attr);
const tab = async (page, id) => { await page.click(`[data-id=tab-${id}]`); await page.waitForTimeout(250); };
const toastIs = (page, re) => page.waitForFunction(s => { const t = document.getElementById("toast"); return !!t && new RegExp(s).test(t.textContent); }, re.source, { timeout: 8000 });
const dlgOk = page => page.click(".dlg-btn.primary");
const connect = async page => { await page.click("[data-id=connect]"); await page.waitForSelector("[data-row=apAssist]", { timeout: 20000 }); };
const board = async page => { await tab(page, "tools"); await page.click("[data-id=tool-board]"); await page.waitForSelector("[data-page=board] [data-row=sent]"); };
const kv = (page, row) => text(page, `[data-page=board] [data-row=${row}] .kv`);

// ---------------------------------------------------------------- group 1: the mock board
await scenario("rows-are-exactly-the-board-rows", "mock=h2&notsl6", {}, async page => {
  await connect(page);
  assert.deepEqual(await ids(page, "[data-page=car] [data-row]", "data-row"), ["vehicleType", "apAssist"]);
  assert.equal(await page.isVisible("[data-id=open-gauges]"), false, "no gauges for the board");
  assert.match(await text(page, ".vehicle-name"), /M5Stack NanoH2/);
  await tab(page, "settings");
  assert.deepEqual(await ids(page, "[data-page=settings] [data-id^=set-]", "data-id"), ["set-search", "set-opmode", "set-lr", "set-time", "set-rand", "set-jg", "set-jj"]);
  assert.equal(await page.isVisible("[data-id=set-mianSwitch]"), false, "no master switch");
  assert.equal(await page.isVisible("[data-id=set-lab]"), false, "no lab rows");
  await tab(page, "tools");
  assert.deepEqual(await ids(page, "[data-id^=tool-]", "data-id"), ["tool-board", "tool-boardfw", "tool-capture", "tool-log", "tool-reset"]);
  await tab(page, "me");
  assert.equal(await page.isDisabled("[data-id=pref-hwType]"), true, "the type picker is locked for a board");
  assert.match(await text(page, "[data-id=pref-hwType]"), /BLE board: M5Stack NanoH2/);
  assert.equal(await page.isVisible("[data-id=enter-password]"), false, "the board has no BLE password");
  assert.match(await text(page, "[data-page=device]"), /Board ID\s*74dafe000001/);
  assert.match(await text(page, "[data-page=device]"), /Board type\s*nanoh2-minican[\s\S]*Chip\s*esp32h2[\s\S]*CAN controller\s*TWAI/);
  // a paired phone gets no pairing hint
  assert.doesNotMatch(await page.locator("#toast").textContent().catch(() => ""), /passkey/);
});

// Firmware 0.6.0: the TSL6 characteristic runs the TSL6 app protocol to the board's TSL6 engine. The pages are the
// TSL6 pages of device type 6; the board keeps its op mode, its Scroll Ack rows and its own tools.
await scenario("engine-link-gives-the-tsl6-pages", "mock=h2", {}, async page => {
  await connect(page);
  await page.waitForSelector("[data-row=pulseHorn]", { timeout: 8000 });
  const rows = await ids(page, "[data-page=car] [data-row]", "data-row");
  for (const id of ["vehicleType", "apAssist", "batteryHeat", "chargeDoor", "pulseHorn", "sportMode"]) assert.ok(rows.includes(id), `Car row ${id}`);
  assert.match(await text(page, ".vehicle-name"), /Tesla Model Y/, "the engine detects the car");
  assert.equal(await page.isVisible("[data-id=open-gauges]"), true, "the TSL6 Gauges button");
  await tab(page, "settings");
  const set = await ids(page, "[data-page=settings] [data-id^=set-]", "data-id");
  for (const id of ["set-opmode", "set-mianSwitch", "set-lr", "set-time", "set-fsd", "set-autoSportMode", "set-lab"]) assert.ok(set.includes(id), `${id} shown`);
  for (const id of ["set-KERS", "set-stoppingMode"]) assert.ok(set.includes(id), `${id} shown, as on a TSL6`);
  assert.ok(set.includes("set-BLEPWR"), "BLE signal strength: the board radio power");
  for (const id of ["set-beep", "set-led", "set-automdr"]) assert.ok(!set.includes(id), `${id} not shown`);
  // A TSL6 row goes to the engine (A3), not to the board settings.
  await page.click("[data-id=set-autoSportMode]");
  await page.click('.opt[data-v="1"]');
  await toastIs(page, /Saved/);
  await tab(page, "tools");
  const tools = await ids(page, "[data-id^=tool-]", "data-id");
  for (const id of ["tool-board", "tool-boardfw", "tool-capture", "tool-shortcuts", "tool-blebtn", "tool-gauge", "tool-battery", "tool-backup", "tool-blehost", "tool-debug", "tool-log", "tool-reset"]) assert.ok(tools.includes(id), `${id} shown`);
  assert.ok(tools.includes("tool-rgb"), "ambient light: the whole-car records go to CAN 0x679");
  for (const id of ["tool-password", "tool-firmware"]) assert.ok(!tools.includes(id), `${id} not shown`);
  await page.click("[data-id=tool-shortcuts]");
  await page.waitForTimeout(1500);
  await tab(page, "tools");
  await page.click("[data-id=tool-battery]");
  await page.waitForTimeout(1500);
  await tab(page, "tools");
  await page.click("[data-id=tool-log]");
  const log = await text(page, "#page");
  assert.doesNotMatch(log, /settings write \{"tsl6"/, "the TSL6 bytes go to the engine, not to the board settings");
  assert.match(log, /rx AB \(256\)/, "the shortcut table came from the engine");
  assert.match(log, /rx D0/, "the battery info came from the engine");
});

await scenario("tsl6-settings-key-rows-without-the-engine-link", "mock=h2&noengine", {}, async page => {
  await connect(page);
  await tab(page, "settings");
  const rows = await ids(page, "[data-page=settings] [data-id^=set-]", "data-id");
  for (const id of ["set-opmode", "set-lr", "set-time", "set-fsd", "set-autoSportMode", "set-pluseHorn", "set-lab"]) assert.ok(rows.includes(id), `${id} shown`);
  for (const id of ["set-mianSwitch", "set-beep", "set-led", "set-automdr"]) assert.ok(!rows.includes(id), `${id} not shown`);
  await page.click("[data-id=set-autoSportMode]");
  await page.click('.opt[data-v="1"]');
  await toastIs(page, /Saved/);
  await tab(page, "tools");
  await page.click("[data-id=tool-log]");
  await page.waitForFunction(() => /settings write \{"tsl6":"01/.test(document.querySelector("#page").textContent), null, { timeout: 8000 });
});

await scenario("ap-assist-switch-and-settings-menus", "mock=h2", {}, async page => {
  await connect(page);
  const sw = page.locator("[data-id=sw-apAssist]");
  await page.waitForFunction(() => document.querySelector("[data-id=sw-apAssist]").getAttribute("aria-checked") === "true");
  assert.match(await text(page, ".hero-sub"), /On hands-on prompt, about 0\.6 s after it/);
  await page.waitForFunction(() => /sent \d+ · hands-on 1, AP 6/.test(document.querySelector("[data-id=prompt-diag]").textContent));
  await sw.click();
  await page.waitForFunction(() => document.querySelector("[data-id=sw-apAssist]").getAttribute("aria-checked") === "false");
  await sw.click();
  await page.waitForFunction(() => document.querySelector("[data-id=sw-apAssist]").getAttribute("aria-checked") === "true");
  // Settings: scroll interval -> timer, from the list sheet
  await tab(page, "settings");
  await page.click("[data-id=set-time]");
  assert.deepEqual(await ids(page, ".opt", "data-v"), ["9", "0", "10", "11", "12", "13", "14", "1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(await page.isVisible(".sheet-help"), false, "no TSL6 help text for the board");
  await page.click('.opt[data-v="2"]');
  await toastIs(page, /Saved/);
  assert.match(await text(page, "[data-id=set-time]"), /Every 4-6 s/);
  // tick gap: the slider sheet
  await page.click("[data-id=set-jg]");
  await page.locator("[data-id=opt-range]").fill("2");
  await dlgOk(page);
  await page.waitForFunction(() => /0\.3 s/.test(document.querySelector("[data-id=set-jg]").textContent), null, { timeout: 8000 });
  // tick order: "Up only" is a board choice
  await page.click("[data-id=set-jj]");
  assert.deepEqual(await page.$$eval(".opt", els => els.map(e => e.textContent.trim())), ["Down, then up (default)", "Up, then down", "Alternate", "Random"]);
  await page.click('.opt[data-v="2"]');
  await page.waitForFunction(() => /Alternate/.test(document.querySelector("[data-id=set-jj]").textContent), null, { timeout: 8000 });
  // The board holds exactly these values.
  await board(page);
  assert.equal(await text(page, "[data-id=board-interval_ms] .val"), "5000 ms");
  assert.equal(await text(page, "[data-id=board-gap_ms] .val"), "300 ms");
  assert.equal(await text(page, "[data-id=board-delay_ms] .val"), "600 ms", "the prompt delay did not change");
  await tab(page, "status");
  assert.match(await text(page, ".hero-sub"), /Every 4-6 s while AP is active/);
});

await scenario("ported-scroll-settings-wheel-and-random-interval", "mock=h2", {}, async page => {
  await connect(page);
  await tab(page, "settings");
  await page.click("[data-id=set-lr]");
  assert.deepEqual(await page.$$eval(".opt", els => els.map(e => e.textContent.trim())),
    ["Left wheel, volume (default)", "Right wheel, speed", "Left and right, alternate"]);
  await page.click('.opt[data-v="1"]');
  await toastIs(page, /Saved/);
  await page.waitForFunction(() => /Right wheel/.test(document.querySelector("[data-id=set-lr]").textContent), null, { timeout: 8000 });
  await page.click("[data-id=set-time]");
  await page.click('.opt[data-v="1"]');
  await toastIs(page, /Saved/);
  await page.waitForFunction(() => /Every 2-3 s/.test(document.querySelector("[data-id=set-time]").textContent), null, { timeout: 8000 });
  await page.click("[data-id=set-rand]");
  assert.deepEqual(await page.$$eval(".opt", els => els.map(e => e.textContent.trim())), ["Off: the exact timer interval", "On (default)"]);
  await page.click('.opt[data-v="0"]');
  await toastIs(page, /Saved/);
  await page.waitForFunction(() => /Every 2\.5 s/.test(document.querySelector("[data-id=set-time]").textContent), null, { timeout: 8000 });
  await tab(page, "status");
  assert.match(await text(page, ".hero-sub"), /Every 2\.5 s while AP is active/, "rand 0: the exact interval");
  await tab(page, "tools");
  await page.click("[data-id=tool-log]");
  await page.waitForFunction(() => /SET {2}on=1/.test(document.querySelector("#page").textContent));
});

await scenario("long-timer-values-15-to-35-s", "mock=h2", {}, async page => {
  await connect(page);
  await tab(page, "settings");
  await page.click("[data-id=set-time]");
  await page.click('.opt[data-v="8"]');
  await toastIs(page, /Saved/);
  await page.waitForFunction(() => /Every 26-39 s/.test(document.querySelector("[data-id=set-time]").textContent), null, { timeout: 8000 });
  await board(page);
  assert.equal(await text(page, "[data-id=board-interval_ms] .val"), "32500 ms");
  await page.click("[data-id=board-interval_ms]");
  assert.match(await text(page, ".dlg"), /1000 to 35000 ms/);
  await page.fill(".dlg-input", "35001");
  await dlgOk(page);
  await toastIs(page, /whole number from 1000 to 35000/);
  await tab(page, "status");
  assert.match(await text(page, ".hero-sub"), /Every 26-39 s while AP is active/);
});

await scenario("board-without-imax-keeps-the-10-s-limit", "mock=h2&noimax", {}, async page => {
  await connect(page);
  await tab(page, "settings");
  await page.click("[data-id=set-time]");
  assert.deepEqual(await ids(page, ".opt", "data-v"), ["9", "0", "10", "11", "12", "13", "14", "1", "2", "3", "4"]);
  await page.keyboard.press("Escape");
  await board(page);
  await page.click("[data-id=board-interval_ms]");
  assert.match(await text(page, ".dlg"), /1000 to 10000 ms/);
});

const capturePage = async page => { await tab(page, "tools"); await page.click("[data-id=tool-capture]"); await page.waitForSelector("[data-page=capture]"); };
const capKv = (page, row) => text(page, `[data-page=capture] [data-row=${row}] .kv`);

await scenario("capture-start-mark-stop-save", "mock=h2", {}, async page => {
  await connect(page);
  await capturePage(page);
  assert.equal(await page.isDisabled("[data-id=cap-stop]"), true);
  assert.equal(await page.locator("[data-page=capture] [data-id^=cap-step-]").count(), 21, "21 steps");
  await page.click("[data-id=cap-start]");
  await toastIs(page, /Listen-Only/);
  await page.waitForFunction(() => /\d+ \(\d+\/s\)/.test(document.querySelector("[data-page=capture] [data-row=frames] .kv").textContent), null, { timeout: 8000 });
  assert.equal(await page.isDisabled("[data-id=cap-start]"), true, "no second start");
  // The board reports the capture: no Active, no tick.
  await page.click("[data-id=cap-step-1]");
  await page.waitForFunction(() => /✓/.test(document.querySelector("[data-id=cap-step-1]").textContent), null, { timeout: 8000 });
  await page.waitForFunction(() => /0x118/.test(document.querySelector("[data-id=cap-ids]").textContent), null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.click("[data-id=cap-stop]");
  await page.waitForFunction(() => /Stopped after/.test(document.querySelector("[data-page=capture] [data-row=state] .kv").textContent), null, { timeout: 8000 });
  assert.match(await capKv(page, "lost"), /^0 \/ 0 \/ 0$/);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-id=cap-save]")]);
  assert.match(dl.suggestedFilename(), /^scrl-capture-\d{8}-\d{4}\.log$/);
  const file = fs.readFileSync(await dl.path(), "utf8");
  assert.match(file, /^# BLE board capture/);
  assert.match(file, /# step 1 at [\d.]+: Touch nothing for 60 s/);
  assert.match(file, /\n\([\d.]+\) can0 118#[0-9A-F]{16}\n/);
  assert.match(file, /# id 400 /, "the ID table has the IDs that do not stream");
  assert.doesNotMatch(file, /can0 400#/, "plan mode streams only the plan IDs");
  await board(page);
  assert.doesNotMatch(await text(page, "[data-page=board]"), /Listen-Only build/);
});

await scenario("capture-id-list", "mock=h2", {}, async page => {
  await connect(page);
  await capturePage(page);
  assert.equal(await page.isVisible("[data-id=cap-list]"), false, "no list field in plan mode");
  await page.selectOption("[data-id=cap-mode]", "2");
  assert.equal(await page.isVisible("[data-id=cap-list]"), true, "the list field shows in list mode");
  await page.fill("[data-id=cap-list]", "118, 0x800");
  await page.click("[data-id=cap-start]");
  await toastIs(page, /ID list: 0x800: a standard ID is 0 to 7FF/);
  assert.match(await capKv(page, "state"), /Not started/, "a bad list starts nothing");
  await page.fill("[data-id=cap-list]", "118 0x401");
  await page.click("[data-id=cap-start]");
  await toastIs(page, /Listen-Only/);
  assert.equal(await page.isDisabled("[data-id=cap-list]"), true, "no list change while it runs");
  await page.waitForFunction(() => /\d+ \(\d+\/s\)/.test(document.querySelector("[data-page=capture] [data-row=frames] .kv").textContent), null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.click("[data-id=cap-stop]");
  await page.waitForFunction(() => /Stopped after/.test(document.querySelector("[data-page=capture] [data-row=state] .kv").textContent), null, { timeout: 8000 });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-id=cap-save]")]);
  const file = fs.readFileSync(await dl.path(), "utf8");
  assert.match(file, /mode 2/);
  assert.match(file, /can0 118#/);
  assert.match(file, /can0 401#/, "a listed table-only ID streams");
  assert.doesNotMatch(file, /can0 129#/, "an ID that is not in the list does not stream");
  assert.match(file, /# id 129 /, "the ID table still has every ID");
});

await scenario("capture-drops-duplicate-packets", "mock=h2&capdup", {}, async page => {
  await connect(page);
  await capturePage(page);
  await page.click("[data-id=cap-start]");
  await page.click("[data-id=cap-start]", { force: true, trial: false }).catch(() => {}); // a second tap does nothing
  await page.waitForFunction(() => /\d+ \(\d+\/s\)/.test(document.querySelector("[data-page=capture] [data-row=frames] .kv").textContent), null, { timeout: 8000 });
  await page.click("[data-id=cap-step-2]");
  await page.waitForTimeout(1500);
  await page.click("[data-id=cap-stop]");
  await page.waitForFunction(() => /Stopped after/.test(document.querySelector("[data-page=capture] [data-row=state] .kv").textContent), null, { timeout: 8000 });
  assert.match(await capKv(page, "lost"), /^0 \/ 0 \/ 0$/, "no false gap from the repeats");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-id=cap-save]")]);
  const file = fs.readFileSync(await dl.path(), "utf8");
  assert.match(file, /packets missing 0, duplicate packets dropped [1-9]/);
  assert.equal((file.match(/^# step 2 /gm) || []).length, 1, "one step line");
  const lines = file.split("\n").filter(l => l.startsWith("("));
  assert.equal(new Set(lines).size, lines.length, "no frame line two times");
});

await scenario("capture-needs-firmware-0-4-0", "mock=h2&nocap", {}, async page => {
  await connect(page);
  await capturePage(page);
  assert.match(await text(page, "[data-page=capture]"), /No capture on this board/);
});

await scenario("capture-link-drop-keeps-the-frames", "mock=h2&capdrop=2", {}, async page => {
  await connect(page);
  await capturePage(page);
  await page.click("[data-id=cap-start]");
  await page.waitForFunction(() => /\d+ \(\d+\/s\)/.test(document.querySelector("[data-page=capture] [data-row=frames] .kv")?.textContent || ""), null, { timeout: 8000 });
  await page.waitForFunction(() => /Stopped after/.test(document.querySelector("[data-page=capture] [data-row=state] .kv")?.textContent || ""), null, { timeout: 10000 });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-id=cap-save]")]);
  assert.match(fs.readFileSync(await dl.path(), "utf8"), /can0 3C2#/);
});

await scenario("board-without-ported-settings-keeps-the-old-rows", "mock=h2&nofeat", {}, async page => {
  await connect(page);
  await tab(page, "settings");
  assert.deepEqual(await ids(page, "[data-page=settings] [data-id^=set-]", "data-id"), ["set-search", "set-opmode", "set-time", "set-jg", "set-jj"]);
  await page.click("[data-id=set-jj]");
  assert.deepEqual(await page.$$eval(".opt", els => els.map(e => e.textContent.trim())), ["Down, then up (default)", "Up, then down", "Up only", "Down only"]);
});

await scenario("exact-time-shows-as-custom-and-stays", "mock=h2", {}, async page => {
  await connect(page);
  await board(page);
  await page.click("[data-id=board-delay_ms]");
  await page.fill(".dlg-input", "9000");
  await dlgOk(page);
  await toastIs(page, /whole number from 0 to 5000/);
  await page.click("[data-id=board-delay_ms]");
  await page.fill(".dlg-input", "700");
  await dlgOk(page);
  await toastIs(page, /Saved/);
  assert.equal(await text(page, "[data-id=board-delay_ms] .val"), "700 ms");
  await tab(page, "settings");
  assert.match(await text(page, "[data-id=set-time]"), /Custom value/);
  await page.click("[data-id=set-jj]");
  await page.click('.opt[data-v="0"]');
  await toastIs(page, /Saved/);
  assert.match(await text(page, "[data-id=set-time]"), /Custom value/, "another save keeps the custom delay");
  await board(page);
  assert.equal(await text(page, "[data-id=board-delay_ms] .val"), "700 ms");
  await tab(page, "status");
  assert.match(await text(page, ".hero-sub"), /about 0\.7 s after it/);
});

await scenario("op-mode-needs-a-confirm-and-settings-show-in-listen-only", "mock=h2&lo", {}, async page => {
  await connect(page);
  await tab(page, "settings");
  assert.match(await text(page, "[data-id=set-opmode]"), /Listen-Only/);
  assert.equal(await page.isVisible("[data-id=set-time]"), true, "the settings show in Listen-Only too");
  await page.click("[data-id=set-opmode]");
  await page.waitForSelector("[data-id=board-op]");
  assert.equal(await page.getAttribute("[data-id=board-op]", "aria-checked"), "false");
  await page.click("[data-id=board-op]");
  assert.match(await text(page, ".dlg"), /send frames on Vehicle CAN/);
  await page.click(".dlg-btn:not(.primary)"); // Cancel
  await page.waitForTimeout(300);
  assert.equal(await page.getAttribute("[data-id=board-op]", "aria-checked"), "false", "Cancel keeps Listen-Only");
  await page.click("[data-id=board-op]");
  await dlgOk(page);
  await page.waitForFunction(() => document.querySelector("[data-id=board-op]").getAttribute("aria-checked") === "true");
  await page.waitForFunction(() => /Active now/.test(document.querySelector("[data-page=board]").textContent));
});

await scenario("bus-off-lock", "mock=h2&lock", {}, async page => {
  await connect(page);
  assert.match(await text(page, "[data-id=board-banner]"), /3 bus-off events/);
  // a save of another setting must not release the lock
  await tab(page, "settings");
  await page.click("[data-id=set-jj]");
  await page.click('.opt[data-v="0"]');
  await toastIs(page, /Saved/);
  await tab(page, "status");
  assert.match(await text(page, "[data-id=board-banner]"), /3 bus-off events/);
  await page.click("[data-id=warn-lock]");
  assert.match(await text(page, ".dlg"), /Check the wiring first/);
  await dlgOk(page);
  await page.waitForFunction(() => !/bus-off/.test(document.querySelector("[data-id=board-banner]").textContent));
});

await scenario("unconfirmed-image-on-the-landing-tab", "mock=h2&pending", {}, async page => {
  await connect(page);
  assert.match(await text(page, "[data-id=board-banner]"), /goes back to the old image in (10 min 00|9 min \d\d) s/);
  // the countdown runs, and the button is not replaced by the 1 Hz update
  const btn = await page.locator("[data-id=warn-pending]").elementHandle();
  const t0 = await text(page, "[data-id=board-banner]");
  await page.waitForFunction(t => document.querySelector("[data-id=board-banner]").textContent !== t, t0, { timeout: 5000 });
  assert.equal(await btn.evaluate(e => e.isConnected), true, "same button element after an update");
  await page.click("[data-id=warn-pending]");
  await toastIs(page, /confirmed/);
  await page.waitForFunction(() => !/not confirmed/.test(document.querySelector("[data-id=board-banner]").textContent));
});

await scenario("restore-defaults-and-restart", "mock=h2", {}, async page => {
  await connect(page);
  await tab(page, "tools");
  await page.click("[data-id=tool-reset]");
  assert.match(await text(page, ".dlg"), /Scroll Ack goes off and the board goes to Listen-Only\. The TSL6 car features go back to their factory settings, with the shortcuts and the BLE buttons\. The bonds and the passkey stay/);
  await dlgOk(page);
  await toastIs(page, /Defaults restored/);
  await tab(page, "settings");
  await page.waitForFunction(() => /Listen-Only/.test(document.querySelector("[data-id=set-opmode]").textContent));
  await tab(page, "status");
  assert.equal(await page.getAttribute("[data-id=sw-apAssist]", "aria-checked"), "false");
  await tab(page, "me");
  await page.click("[data-id=restart]");
  await dlgOk(page);
  await page.waitForSelector("[data-id=connect]", { timeout: 8000 }); // the link dropped
});

await scenario("passkey-forget-factory", "mock=h2", {}, async page => {
  await connect(page);
  await board(page);
  const type = async v => { await page.fill(".dlg-input", v); await dlgOk(page); };
  await page.click("[data-id=board-passkey]");
  await type("12345");
  await toastIs(page, /6 digits/);
  await page.click("[data-id=board-passkey]");
  await type("004271"); await page.waitForSelector(".dlg-input"); await type("004272");
  await toastIs(page, /differ/);
  await page.click("[data-id=board-passkey]");
  await type("004271"); await page.waitForSelector(".dlg-input"); await type("004271");
  await toastIs(page, /has the new passkey/);
  // the app log (it offers a capture copy) names the command, never the digits
  await tab(page, "tools");
  await page.click("[data-id=tool-log]");
  const logText = await text(page, "#page");
  assert.match(logText, /set-passkey command/);
  assert.match(logText, /CMD {2}passkey changed/, "the board log lines reach the app log");
  assert.doesNotMatch(logText, /004271/);
  await board(page);
  await page.click("[data-id=board-factory]");
  assert.match(await text(page, ".dlg"), /The passkey stays/);
  await dlgOk(page);
  await toastIs(page, /erased its data/);
  await tab(page, "status");
  await page.waitForSelector("[data-id=connect]", { timeout: 8000 });
});

// The flash site is served from the test: builds.json and the image of the mock board.
async function fakeSite(page, image, sha = crypto.createHash("sha256").update(image.buffer).digest("hex")) {
  await page.route("https://scrl-flash-preview.surge.sh/**", route => {
    const u = new URL(route.request().url());
    if (u.pathname === "/builds.json") {
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ version: "9.9.9", builds: [{ id: "nanoh2-minican", board: "nanoh2-minican", can_id: "twai", version: "9.9.9", app: "scrl-nanoh2-minican.bin", app_sha256: sha }] }) });
    }
    if (u.pathname === "/firmware/scrl-nanoh2-minican.bin") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: image.buffer });
    return route.fulfill({ status: 404, body: "" });
  });
}

await scenario("update-image-from-the-flash-site", "mock=h2", {}, async page => {
  await fakeSite(page, BIN);
  await connect(page);
  await tab(page, "tools");
  await page.click("[data-id=tool-boardfw]");
  await page.click("[data-id=bfw-site]");
  await page.waitForFunction(() => /scrl-ble-board 9\.9\.9/.test(document.querySelector("[data-id=bfw-image]").textContent));
  assert.equal(await page.isDisabled("[data-id=bfw-start]"), false, "the image can be sent");
});

await scenario("flash-site-image-with-a-wrong-hash-is-refused", "mock=h2", {}, async page => {
  await fakeSite(page, BIN, "00".repeat(32));
  await connect(page);
  await tab(page, "tools");
  await page.click("[data-id=tool-boardfw]");
  await page.click("[data-id=bfw-site]");
  await page.waitForFunction(() => /does not match the SHA-256/.test(document.querySelector("[data-id=bfw-image]").textContent));
  assert.equal(await page.isDisabled("[data-id=bfw-start]"), true);
});

await scenario("update-and-confirm", "mock=h2", {}, async page => {
  await connect(page);
  await tab(page, "tools");
  await page.click("[data-id=tool-boardfw]");
  assert.equal(await page.isDisabled("[data-id=bfw-start]"), true);
  await page.setInputFiles("[data-id=bfw-file]", HELLO);
  await page.waitForFunction(() => /project name is "hello_world"/.test(document.querySelector("[data-id=bfw-image]").textContent));
  assert.equal(await page.isDisabled("[data-id=bfw-start]"), true, "a wrong image is not sent");
  await page.setInputFiles("[data-id=bfw-file]", BIN);
  await page.waitForFunction(() => /scrl-ble-board 9\.9\.9/.test(document.querySelector("[data-id=bfw-image]").textContent));
  await page.click("[data-id=bfw-start]");
  assert.match(await text(page, ".dlg"), /car must be parked/);
  await dlgOk(page);
  // while the board restarts, a tap on Connect must not start a second link
  await page.waitForFunction(() => /restarts into the new image/.test(document.querySelector("[data-id=bfw-msg]").textContent), null, { timeout: 60000 });
  await tab(page, "status");
  const early = page.locator("[data-id=connect]");
  if (await early.isVisible()) { await early.click(); await toastIs(page, /connects again by itself/); }
  await tab(page, "tools");
  await page.click("[data-id=tool-boardfw]");
  await page.waitForFunction(() => /The new image runs/.test(document.querySelector("[data-id=bfw-msg]").textContent), null, { timeout: 90000 });
  assert.match(await text(page, "[data-id=board-banner]"), /not confirmed/);
  assert.equal(await page.isDisabled("[data-id=bfw-start]"), true, "no second update before the confirm");
  // the warning and its button are on the Car tab too
  await tab(page, "status");
  await page.click("[data-id=warn-pending]");
  await toastIs(page, /confirmed/);
  await tab(page, "me");
  assert.match(await text(page, "[data-page=device]"), /Firmware\s*9\.9\.9/);
});

// Bluefy on iOS delivers no OTA data write without response. An iPhone sends with response to firmware that
// takes it (Info "otaw", 0.4.2). The mock refuses a write with response when "&nootaw" acts as older firmware.
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Bluefy";
await scenario("update-iphone-with-response", "mock=h2&bluefy", { userAgent: IPHONE_UA }, async page => {
  await connect(page);
  await tab(page, "tools");
  await page.click("[data-id=tool-boardfw]");
  await page.setInputFiles("[data-id=bfw-file]", BIN);
  await page.waitForFunction(() => /scrl-ble-board 9\.9\.9/.test(document.querySelector("[data-id=bfw-image]").textContent));
  await page.click("[data-id=bfw-start]");
  await dlgOk(page);
  await page.waitForFunction(() => /The new image runs/.test(document.querySelector("[data-id=bfw-msg]").textContent), null, { timeout: 120000 });
});

await scenario("update-iphone-old-firmware", "mock=h2&nootaw", { userAgent: IPHONE_UA }, async page => {
  await connect(page);
  await tab(page, "tools");
  await page.click("[data-id=tool-boardfw]");
  await page.setInputFiles("[data-id=bfw-file]", BIN);
  await page.waitForFunction(() => /scrl-ble-board 9\.9\.9/.test(document.querySelector("[data-id=bfw-image]").textContent));
  await page.click("[data-id=bfw-start]");
  await page.waitForFunction(() => /cannot start/.test(document.querySelector("[data-id=bfw-msg]").textContent));
  assert.match(await text(page, "[data-id=bfw-msg]"), /0\.4\.2 or newer over USB/);
  assert.equal(await page.locator(".dlg").count(), 0, "no send dialog");
});

await scenario("update-cut-write-steps-down", "mock=h2&cut=200", {}, async page => {
  await connect(page);
  await tab(page, "tools");
  await page.click("[data-id=tool-boardfw]");
  await page.setInputFiles("[data-id=bfw-file]", BIN);
  await page.waitForFunction(() => !document.querySelector("[data-id=bfw-start]").disabled);
  await page.click("[data-id=bfw-start]");
  await dlgOk(page);
  await page.waitForFunction(() => /The update stopped/.test(document.querySelector("[data-id=bfw-msg]").textContent), null, { timeout: 30000 });
  assert.match(await text(page, "[data-id=bfw-msg]"), /cut a write of 240 bytes.*keeps its old image.*now writes 180 bytes/s);
  await page.waitForFunction(() => !document.querySelector("[data-id=bfw-start]").disabled, null, { timeout: 8000 });
  await page.click("[data-id=bfw-start]");
  await dlgOk(page);
  await page.waitForFunction(() => /The new image runs/.test(document.querySelector("[data-id=bfw-msg]").textContent), null, { timeout: 90000 });
});

await scenario("t2can-refuses-other-boards-and-warns-on-can-change", "mock=h2&board=lilygo-t2can&noengine", {}, async page => {
  await connect(page);
  assert.match(await text(page, ".vehicle-name"), /LilyGO T-2CAN/);
  await tab(page, "tools");
  await page.click("[data-id=tool-boardfw]");
  assert.match(await text(page, "[data-page=firmware]"), /LilyGO T-2CAN \(lilygo-t2can, esp32s3, CAN TWAI\)/);
  // An H2 image: wrong chip. A Waveshare image: same chip, other board. Neither is sent.
  await page.setInputFiles("[data-id=bfw-file]", BIN);
  await page.waitForFunction(() => /needs 0x9 \(esp32s3\)/.test(document.querySelector("[data-id=bfw-image]").textContent));
  assert.equal(await page.isDisabled("[data-id=bfw-start]"), true, "an image for another chip is not sent");
  await page.setInputFiles("[data-id=bfw-file]", WAVESHARE);
  await page.waitForFunction(() => /for the board "waveshare-s3-can"/.test(document.querySelector("[data-id=bfw-image]").textContent));
  assert.equal(await page.isDisabled("[data-id=bfw-start]"), true, "an image for another board is not sent");
  // The can1 build for the same board: allowed, with the wiring warning in the page and in the confirm.
  await page.setInputFiles("[data-id=bfw-file]", T2_CAN1);
  await page.waitForFunction(() => /move the Vehicle CAN wires/.test(document.querySelector("[data-id=bfw-image]").textContent));
  assert.equal(await page.isDisabled("[data-id=bfw-start]"), false);
  await page.click("[data-id=bfw-start]");
  assert.match(await text(page, ".dlg"), /lilygo-t2can[\s\S]*MCP2515.*now uses TWAI/);
  await dlgOk(page);
  await page.waitForFunction(() => /The new image runs/.test(document.querySelector("[data-id=bfw-msg]").textContent), null, { timeout: 90000 });
  await tab(page, "status");
  await page.click("[data-id=warn-pending]");
  await toastIs(page, /confirmed/);
  await tab(page, "me");
  assert.match(await text(page, "[data-page=device]"), /CAN controller\s*MCP2515/);
  // Now the board runs can1: the can0 image gets the warning the other way round.
  await tab(page, "tools");
  await page.click("[data-id=tool-boardfw]");
  await page.setInputFiles("[data-id=bfw-file]", T2);
  await page.waitForFunction(() => /TWAI. The board now uses MCP2515/.test(document.querySelector("[data-id=bfw-image]").textContent));
});

await scenario("listen-only-build-locks-active", "mock=h2&board=esp32-generic-twai-sniffer&lo&noengine", {}, async page => {
  await connect(page);
  assert.match(await text(page, ".vehicle-name"), /ESP32 DevKit \(listen only\)/);
  await board(page);
  assert.match(await text(page, "[data-id=board-banner]"), /listen-only build. It never sends/);
  assert.equal(await page.isDisabled("[data-id=board-op]"), true, "Active is locked");
  assert.match(await text(page, "[data-page=board]"), /Listen-only build: never sends/);
  await tab(page, "me");
  assert.match(await text(page, "[data-id=pref-hwType]"), /BLE board: ESP32 DevKit \(listen only\)/);
});

await scenario("pairing-hint-then-connect", "mock=h2&pair", {}, async page => {
  await page.click("[data-id=connect]");
  await toastIs(page, /type the 6 digits from the label/);
  await page.waitForSelector("[data-row=apAssist]", { timeout: 20000 });
});

await scenario("pairing-fails-with-the-reasons", "mock=h2&nopair", {}, async page => {
  await page.click("[data-id=connect]");
  await page.waitForSelector(".dlg", { timeout: 20000 });
  assert.match(await text(page, ".dlg"), /No secure link to the board.*pairing window.*passkey from the label.*remove the board in the Bluetooth settings/s);
  await dlgOk(page);
  assert.equal(await page.isVisible("[data-id=connect]"), true);
});

for (const [bad, re] of [["settings", /Settings data: Settings JSON: bad enabled/], ["log", /Log subscribe: GATT Error: Not supported/]]) {
  await scenario(`connect-step-failure-${bad}`, `mock=h2&bad=${bad}`, {}, async page => {
    // A step after the pairing fails: the dialog names the step, and the app does not stay half connected.
    await page.click("[data-id=connect]");
    await page.waitForSelector(".dlg", { timeout: 20000 });
    assert.match(await text(page, ".dlg"), re);
    assert.match(await text(page, ".dlg"), /Tools > Log and capture/);
    await dlgOk(page);
    assert.equal(await page.isVisible("[data-id=connect]"), true);
    assert.equal(await page.evaluate(async () => (await import("/app/app.js")).S.link.t.connected), false, "the link is closed");
    await tab(page, "tools");
    await page.click("[data-id=tool-log]");
    if (bad === "settings") await page.waitForFunction(() => /board sent \d+ bytes: \{"enabled":1/.test(document.querySelector("#page").textContent));
  });
}

// ---------------------------------------------------------------- groups 2 and 3: a fake navigator.bluetooth
// kind "h2": a board (the mock board transport of the app). kind "tsl6": a TSL6 (the mock module of the app).
function fakeBluetooth(opts) {
  const H2 = n => `e591${n.toString(16).padStart(4, "0")}-51ba-4d0b-8422-5cb9dc778552`;
  const H2_NAMES = { [H2(2)]: "info", [H2(3)]: "status", [H2(4)]: "live", [H2(5)]: "settings", [H2(6)]: "command", [H2(7)]: "log", [H2(8)]: "otaCtrl", [H2(9)]: "otaData" };
  const TSL_SVC = "0000fff0-0000-1000-8000-00805f9b34fb";
  const F = (window.__fake = { requests: [], connects: 0, cancel: !!opts.cancel });
  const view = u8 => { const b = new Uint8Array(u8.length + 5); b.fill(0xEE); b.set(u8, 5); return new DataView(b.buffer, 5, u8.length); };
  const toU8 = v => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  const device = new EventTarget();
  device.name = opts.name;
  const gone = () => { device.gatt.connected = false; device.dispatchEvent(new Event("gattserverdisconnected")); };
  let h2 = null, tsl = null;
  const chrs = {};

  class H2Chr extends EventTarget {
    constructor(uuid) { super(); this.uuid = uuid; this.name = H2_NAMES[uuid]; this.value = null; }
    async readValue() { this.value = view(await h2.read(this.name)); return this.value; }
    async writeValueWithResponse(v) { await h2.write(this.name, toU8(v), false); }
    async writeValueWithoutResponse(v) { await h2.write(this.name, toU8(v), true); }
    async writeValue(v) { await h2.write(this.name, toU8(v), this.name === "otaData"); }
    async startNotifications() { await h2.subscribe(this.name, u8 => { this.value = view(u8); this.dispatchEvent(new Event("characteristicvaluechanged")); }); return this; }
  }
  // The TSL6 has one characteristic for writes and notifications.
  class TslChr extends EventTarget {
    constructor() { super(); this.uuid = "0000fff1-0000-1000-8000-00805f9b34fb"; this.properties = { write: true, notify: true }; this.value = null; }
    async writeValueWithResponse(v) { await tsl.rawWrite(toU8(v)); }
    async startNotifications() { return this; }
  }
  async function board() {
    if (opts.kind === "h2") {
      if (!h2) { const { MockH2Transport } = await import("/app/scrl-mock.js"); h2 = new MockH2Transport(); h2.onDisconnect = gone; F.board = h2; }
      await h2.open();
      return { getPrimaryService: async uuid => {
        if (uuid !== H2(1)) throw new DOMException("no such service", "NotFoundError");
        return { getCharacteristic: async u => {
          if (!H2_NAMES[u]) throw new DOMException("no characteristic", "NotFoundError");
          if (opts.failChr === H2_NAMES[u]) throw new Error("2"); // Bluefy gives only a number
          return (chrs[u] ||= new H2Chr(u));
        } };
      } };
    }
    const { MockLink } = await import("/app/mock.js");
    tsl = new MockLink(); F.board = tsl;
    const chr = new TslChr();
    tsl.receive = bytes => { chr.value = view(bytes); chr.dispatchEvent(new Event("characteristicvaluechanged")); };
    await tsl.open();
    return { getPrimaryService: async uuid => {
      if (uuid !== TSL_SVC) throw new DOMException("no such service", "NotFoundError");
      return { getCharacteristics: async () => [chr] };
    } };
  }
  device.gatt = {
    connected: false,
    async connect() { const server = await board(); device.gatt.connected = true; F.connects++; return server; },
    disconnect() { if (h2) h2.close(); else if (tsl) { tsl.close(); gone(); } },
  };
  Object.defineProperty(navigator, "bluetooth", { configurable: true, value: {
    async requestDevice(o) { F.requests.push(JSON.parse(JSON.stringify(o))); if (F.cancel) throw new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError"); return device; },
  } });
}
const fake = (name, opts, fn) => scenario(name, "x=1", { init: [fakeBluetooth, opts] }, fn);
const BOTH = ["0000fff0-0000-1000-8000-00805f9b34fb", "e5910001-51ba-4d0b-8422-5cb9dc778552"];

await fake("real-connect-path-board", { kind: "h2", name: "SCRL-FAKE" }, async page => {
  assert.equal(await page.evaluate(() => document.body.classList.contains("is-mock")), false, "this run does not use the mock link of the app");
  await connect(page);
  const req = await page.evaluate(() => __fake.requests);
  assert.equal(req.length, 1);
  assert.deepEqual(req[0].optionalServices, BOTH, "the chooser may use both services");
  assert.deepEqual(req[0].filters, [{ services: [BOTH[0]] }, { namePrefix: "TSL" }, { namePrefix: "FFKJ" }, { services: [BOTH[1]] }, { namePrefix: "SCRL-" }]);
  assert.deepEqual(await ids(page, "[data-page=car] [data-row]", "data-row"), ["vehicleType", "apAssist"]);
  // values come as DataViews with a byte offset: the numbers must still be right
  await tab(page, "me");
  assert.match(await text(page, "[data-page=device]"), /Firmware\s*0\.1\.0 \(4d298926\)/);
  // a notification (the Live record) moves the counter on the Board page
  await board(page);
  const a = Number(await kv(page, "sent"));
  await page.waitForFunction(v => Number(document.querySelector("[data-page=board] [data-row=sent] .kv").textContent) > v, a, { timeout: 8000 });
  // the board drops the link
  await page.evaluate(() => __fake.board.drop(0));
  await tab(page, "status");
  await page.waitForSelector("[data-id=connect]");
  // a cancelled chooser keeps the app usable; the next connect works
  await page.evaluate(() => { __fake.cancel = true; });
  await page.click("[data-id=connect]");
  await page.waitForTimeout(500);
  assert.equal(await page.isVisible("[data-id=connect]"), true);
  await page.evaluate(() => { __fake.cancel = false; });
  await connect(page);
  assert.equal(await page.evaluate(() => __fake.connects), 2);
  // the characteristic objects are the same as before: each board log line must still come once
  await tab(page, "settings");
  await page.click("[data-id=set-jj]");
  await page.click('.opt[data-v="2"]');
  // no board command ran on hardware yet: the app says so once per session (the mock runs skip this warning)
  await page.waitForSelector(".dlg");
  assert.match(await text(page, ".dlg"), /not tested with the BLE board on a car yet/);
  await dlgOk(page);
  await toastIs(page, /Saved/);
  await tab(page, "tools");
  await page.click("[data-id=tool-log]");
  await page.waitForFunction(() => /pat=4/.test(document.querySelector("#page").textContent));
  await page.waitForTimeout(300);
  assert.equal(((await text(page, "#page")).match(/SET {2}on=1 mode=0 pat=4/g) || []).length, 1, "no double notification after a reconnect");
});

await fake("gatt-step-failure-names-the-call", { kind: "h2", name: "SCRL-FAKE", failChr: "live" }, async page => {
  await page.click("[data-id=connect]");
  await page.waitForSelector(".dlg", { timeout: 20000 });
  assert.match(await text(page, ".dlg"), /GATT connect: characteristic live: 2/);
  await dlgOk(page);
  assert.equal(await page.isVisible("[data-id=connect]"), true);
});

await fake("real-connect-path-board-show-all-devices", { kind: "h2", name: "" }, async page => {
  // "Show all devices": the device has no name, so the app looks for the board service.
  await page.check("#allDev");
  await connect(page);
  const req = await page.evaluate(() => __fake.requests);
  assert.equal(req[0].acceptAllDevices, true);
  assert.deepEqual(req[0].optionalServices, BOTH);
});

await fake("real-connect-path-tsl6", { kind: "tsl6", name: "TSL6-1234" }, async page => {
  await page.click("[data-id=connect]");
  await page.waitForSelector(".dlg-input", { timeout: 8000 }); // the BLE password prompt of the TSL6
  await page.fill(".dlg-input", "1234");
  await dlgOk(page);
  await page.waitForSelector("[data-row=batteryHeat]", { timeout: 8000 });
  const rows = await ids(page, "[data-page=car] [data-row]", "data-row");
  assert.ok(rows.length > 10 && rows.includes("apAssist") && rows.includes("offESP"), `TSL6 rows: ${rows.length}`);
  assert.equal(await page.isVisible("[data-id=open-gauges]"), true);
  assert.equal(await page.isVisible("[data-id=board-banner]"), false);
  await tab(page, "settings");
  assert.equal(await page.isVisible("[data-id=set-mianSwitch]"), true);
  assert.equal(await page.isVisible("[data-id=set-opmode]"), false);
  assert.ok((await ids(page, "[data-page=settings] [data-id^=set-]", "data-id")).length > 20);
  await tab(page, "tools");
  const tools = await ids(page, "[data-id^=tool-]", "data-id");
  assert.ok(!tools.includes("tool-board") && tools.includes("tool-shortcuts") && tools.includes("tool-firmware"));
  await tab(page, "me");
  assert.equal(await page.isDisabled("[data-id=pref-hwType]"), false);
  assert.match(await text(page, "[data-id=pref-hwType]"), /TSL6 \(type 6\)/);
});

// The mock TSL6 of the app (?mock): the same checks as before the board came, in short.
await scenario("mock-tsl6-unchanged", "mock", {}, async page => {
  await page.click("[data-id=connect]");
  await page.waitForSelector(".dlg-input", { timeout: 8000 });
  await page.fill(".dlg-input", "1234");
  await dlgOk(page);
  await page.waitForSelector("[data-row=batteryHeat]", { timeout: 8000 });
  await tab(page, "settings");
  await page.click("[data-id=set-time]");
  await page.waitForSelector(".opt"); // the sheet waits for the help texts
  assert.ok((await ids(page, ".opt", "data-v")).includes("15"), "the TSL6 menu keeps its own values");
  assert.equal(await page.isVisible(".sheet-help"), true, "the TSL6 keeps its help text");
});

console.log(results.join("\n"));
await browser.close();
server.close();
process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
