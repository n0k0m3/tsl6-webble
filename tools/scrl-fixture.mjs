// Writes test/fixtures/scrl-protocol.json from the firmware of the BLE board (ble-board/ in flipper-tesla-fsd).
//
//   node tools/scrl-fixture.mjs <path of the flipper-tesla-fsd repo>
//
// The firmware defines the protocol of the board. This tool reads it from the firmware sources (the #define values,
// the UUIDs, the app slot size) and runs the firmware code on the host (test/scrl_vectors in that repo: the status and
// Live packers, the settings reader, the passkey reader). test/scrl.mjs then checks public/lib/scrl.js and the
// adapter (public/lib/scrl-tsl6.js) against the file. Run the tool again after each change of the board protocol.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boardWrites, passkeyTexts } from "../test/scrl-cases.mjs";
import * as SC from "../public/lib/scrl.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fw = process.argv[2];
if (!fw) { console.error("usage: node tools/scrl-fixture.mjs <path of the flipper-tesla-fsd repo>"); process.exit(2); }
const mainDir = path.join(fw, "ble-board/main");
const read = f => fs.readFileSync(f, "utf8");

// All "#define NAME value" of one family in a header. Values: 0x1Fu, 12u, (1u << 5), (10u * 60u * 1000u).
function defines(file, prefix) {
  const out = {};
  for (const [, name, expr] of read(path.join(mainDir, file)).matchAll(/^#define\s+(\w+)\s+(.+?)\s*(?:\/\/.*)?$/gm)) {
    if (!name.startsWith(prefix)) continue;
    const js = expr.replace(/(0x[0-9a-fA-F]+|\d+)u\b/g, "$1");
    if (!/^[\s\dxa-fA-F()<*+]+$/.test(js)) throw new Error(`${name}: unexpected expression ${expr}`);
    out[name.slice(prefix.length)] = Function(`return (${js});`)();
  }
  return out;
}
function uuids() {
  const src = read(path.join(mainDir, "scrl_ble.cpp"));
  const macro = src.match(/BLE_UUID128_INIT\(([^)]*\(n\)[^)]*)\)/);
  const bytes = macro[1].replace(/\\\s*\n/g, " ").split(",").map(x => x.trim());
  const make = num => {
    const h = bytes.map(x => (x === "(n)" ? num : parseInt(x, 16)).toString(16).padStart(2, "0")).reverse().join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const names = { SERVICE: "service", INFO: "info", STATUS: "status", LIVE: "live", SETTINGS: "settings",
    COMMAND: "command", LOG: "log", OTA_CTRL: "otaCtrl", OTA_DATA: "otaData" };
  const out = {};
  for (const [, name, num] of src.matchAll(/UUID_(\w+) = SCRL_UUID\((0x[0-9a-fA-F]+)\)/g)) out[names[name]] = make(Number(num));
  return out;
}

// Board ID and IDF target of each board: Kconfig SCRL_BOARD_ID ("default "id" if SCRL_BOARD_X") and the
// "depends on IDF_TARGET_Y" of each SCRL_BOARD_X entry.
function boards() {
  const src = read(path.join(mainDir, "Kconfig.projbuild"));
  const target = {};
  for (const [, sym, chip] of src.matchAll(/config (SCRL_BOARD_\w+)\s+bool "[^"]*"\s+depends on IDF_TARGET_(\w+)/g)) target[sym] = chip.toLowerCase();
  const out = {};
  for (const [, id, sym] of src.matchAll(/default "([\w-]+)" if (SCRL_BOARD_\w+)/g)) out[id] = target[sym];
  if (!Object.keys(out).length || Object.values(out).some(v => !v)) throw new Error("Kconfig: board list not found");
  return out;
}

execFileSync("make", ["-C", path.join(fw, "test"), "scrl_vectors"], { stdio: ["ignore", "ignore", "inherit"] });
const bin = path.join(fw, "test/scrl_vectors");
const vectors = JSON.parse(execFileSync(bin, { encoding: "utf8" }));
const parse = (current, write) => JSON.parse(execFileSync(bin, ["parse"], { input: `${current}\n${write}\n`, encoding: "utf8" }));
const passkey = bytes => JSON.parse(execFileSync(bin, ["passkey"], { input: `${SC.hex(bytes)}\n`, encoding: "utf8" }));

const ota = defines("scrl_ota.h", "SCRL_OTA_");
const otaErr = { OK: ota.OK };
for (const [k, v] of Object.entries(ota)) if (k.startsWith("ERR_")) otaErr[k.slice(4)] = v;
const slots = [...read(path.join(fw, "ble-board/partitions.csv")).matchAll(/^ota_\d,\s*app,\s*ota_\d,\s*\S+,\s*(\S+)/gm)].map(x => Number(x[1]));

const fixture = {
  about: "Protocol of the BLE board, from its firmware. Written by tools/scrl-fixture.mjs. Do not edit.",
  firmware_commit: execFileSync("git", ["-C", fw, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
  flags: defines("scrl_status.h", "SCRL_FLAG_"),
  cmd: defines("scrl_ble.h", "SCRL_CMD_"),
  ota: Object.fromEntries(Object.entries(ota).filter(([k]) => k !== "OK" && !k.startsWith("ERR_"))),
  ota_err: otaErr,
  uuids: uuids(),
  slot_size: Math.min(...slots),
  boards: boards(),
  board_desc: defines("scrl_board_desc.h", "SCRL_BOARD_DESC_"),
  vectors,
  // What the firmware settings reader does with each write that the app can send.
  writes: boardWrites(vectors.default_settings_json, vectors.limits.interval_max).map(([current, write]) => ({ current, write, ...parse(current, write) })),
  // What the firmware passkey reader does with the command of the app.
  passkeys: passkeyTexts.map(text => ({ text, ...passkey(SC.passkeyCommand(text)) })),
};
const out = path.join(here, "../test/fixtures/scrl-protocol.json");
fs.writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
console.log(`wrote ${path.relative(process.cwd(), out)}: firmware ${fixture.firmware_commit}, ${fixture.writes.length} settings writes, ${fixture.passkeys.length} passkeys`);
