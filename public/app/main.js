// Entry point. Loads every page module; a page that fails to load does not stop the app.
import { start, log } from "./app.js";

const PAGES = ["status", "connect", "settings", "me", "password", "log",
  "shortcuts", "blebtn", "backup", "battery", "rgb", "gauge", "gaugemenu", "debug", "blehost"];
const MOCKS = ["tables", "rgb", "live", "gauge"];

const mock = new URLSearchParams(location.search).has("mock");
const loads = PAGES.map(p => import(`./pages/${p}.js`).catch(e => log(`page ${p} did not load: ${e.message}`, "bad")));
let MockLink = null;
if (mock) {
  ({ MockLink } = await import("./mock.js"));
  await Promise.all(MOCKS.map(m => import(`./mock/${m}.js`).catch(e => log(`mock ${m} did not load: ${e.message}`, "warn"))));
}
await Promise.all(loads);
start({ mock, MockLink });
