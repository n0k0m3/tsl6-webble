// The settings writes and the passkeys that the app can send to the BLE board. tools/scrl-fixture.mjs runs each one
// through the firmware code and stores the answer. test/scrl.mjs builds the same list and checks the answers.
import { H2_TIME, H2_GAP, H2_FEATURES, h2Order, h2SetBoardSettings } from "../public/lib/h2-menus.js";
import { h2SettingChange, H2_DEFAULTS } from "../public/lib/scrl-tsl6.js";
import { LIMITS } from "../public/lib/scrl.js";

// [settings on the board (JSON), write (JSON)] pairs.
export function boardWrites(defaultsJson) {
  // The menus follow the board: a board with ported features gets their writes too.
  h2SetBoardSettings(JSON.parse(defaultsJson));
  const active = JSON.stringify({ ...JSON.parse(defaultsJson), enabled: true, op_mode: 1, mode: 1, pattern: 2, delay_ms: 1234, gap_ms: 137, interval_ms: 3333 });
  const out = [];
  for (const current of [defaultsJson, active]) {
    // Settings tab: each menu value of each field.
    for (const [v] of H2_TIME) out.push([current, JSON.stringify(h2SettingChange("time", v))]);
    for (const [v] of H2_GAP) out.push([current, JSON.stringify(h2SettingChange("jg", v))]);
    for (const [v] of h2Order()) out.push([current, JSON.stringify(h2SettingChange("jj", v))]);
    for (const [id, max] of H2_FEATURES) {
      if (!(id in JSON.parse(defaultsJson))) continue;
      for (let v = 0; v <= max; v++) out.push([current, JSON.stringify(h2SettingChange(id, v))]);
    }
    // Car tab: AP assist on and off.
    out.push([current, '{"enabled":true}'], [current, '{"enabled":false}']);
    // Board page: op mode, and the limits of the exact times.
    out.push([current, '{"op_mode":1}'], [current, '{"op_mode":0}']);
    for (const key of ["delay_ms", "gap_ms", "interval_ms"]) for (const v of LIMITS[key]) out.push([current, JSON.stringify({ [key]: v })]);
    // Tools: restore defaults (the link sends only the keys that differ; this is the largest write).
    out.push([current, JSON.stringify(H2_DEFAULTS)]);
  }
  return out;
}

export const passkeyTexts = ["123456", "000042", "000000", "999999"];
