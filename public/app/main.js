// Entry point. Loads every page module; a page that fails to load does not stop the app.
import { start, log } from "./app.js";

const PAGES = ["status", "settings", "tools", "me", "password", "log", "firmware",
  "shortcuts", "blebtn", "backup", "battery", "rgb", "gauge", "gaugemenu", "debug", "blehost", "board", "boardfw"];
const MOCKS = ["tables", "rgb", "live", "gauge"];

const query = new URLSearchParams(location.search);
const mock = query.has("mock");
const mockH2 = query.get("mock") === "h2"; // ?mock=h2: a mock H2 board instead of the mock TSL6 module
const loads = PAGES.map(p => import(`./pages/${p}.js`).catch(e => log(`page ${p} did not load: ${e.message}`, "bad")));
let MockLink = null, MockH2Transport = null;
if (mockH2) {
  ({ MockH2Transport } = await import("./scrl-mock.js"));
} else if (mock) {
  ({ MockLink } = await import("./mock.js"));
  await Promise.all(MOCKS.map(m => import(`./mock/${m}.js`).catch(e => log(`mock ${m} did not load: ${e.message}`, "warn"))));
}
await Promise.all(loads);
start({ mock, MockLink, MockH2Transport });
