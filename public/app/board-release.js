// The newest firmware release for the connected BLE board (see FW_SITES in lib/scrl.js).
//
// 1. builds.json of each flash site in SC.FW_SITES (live app: the live site only; other hosts: the preview site too).
//    The newest version that has a build for this board and this CAN controller wins. With the same version, the
//    live site wins.
// 2. Only when that version is newer than the board's: the release from the GitHub API. It must be published, and the
//    digest of the app image must match builds.json. The API allows 60 calls per hour per address without a login,
//    so the app asks it only when there is an update to offer.
// A failed lookup is silent: no update is offered, and an image file still works. A lookup runs once per board and
// firmware, and again after 10 minutes. The bus event "release" tells the pages to draw again.
import { S, bus, isH2, log } from "./app.js";
import * as SC from "../lib/scrl.js";

const AGAIN_MS = 10 * 60 * 1000;
const R = { key: "", at: 0, busy: null, rel: null };

const board = () => (isH2() && S.link && S.link.connected ? S.link.board : null);
const keyOf = B => { const t = B && B.info ? SC.boardOf(B.info) : null; return t ? `${t.id}/${t.can}/${B.info.fw || ""}` : ""; };

async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// The newest release for the connected board: {tag, version, site, build, sha, page}, or null. sha (the digest of
// the release asset) is set only when the release is newer than the board.
export const latestRelease = () => { const B = board(), key = keyOf(B); return key && R.key === key ? R.rel : null; };

// The release to offer, or null: newer than the board, checked against GitHub, and no unconfirmed image on the board.
export function boardUpdate() {
  const B = board(), rel = latestRelease();
  if (!B || !B.info || !rel || !rel.sha || (B.flags & SC.FLAG.IMAGE_PENDING)) return null;
  return SC.cmpVersion(rel.version, B.info.fw) > 0 ? rel : null;
}

async function lookup(B) {
  const t = SC.boardOf(B.info);
  let best = null;
  for (const site of SC.FW_SITES) {
    // ?t= gets past any cache right after a release.
    const list = await getJson(`${site}/builds.json?t=${Date.now()}`).catch(() => null);
    const build = list && SC.parseVersion(list.version) ? SC.pickBuild(list, t) : null;
    if (build && (!best || SC.cmpVersion(list.version, best.version) > 0)) best = { tag: SC.releaseTag(list), version: list.version, site, build };
  }
  if (!best) return null;
  const rel = { ...best, sha: null, page: SC.releasePageUrl(best.tag) };
  if (!(SC.cmpVersion(rel.version, B.info.fw) > 0)) return rel;
  const api = await getJson(SC.releaseApiUrl(rel.tag));
  if (!api || api.draft || api.tag_name !== rel.tag) throw new Error(`${rel.tag} is not a published release`);
  const sha = SC.assetSha(api, rel.build.app);
  if (sha !== rel.build.app_sha256) throw new Error(`${rel.build.app}: the flash site does not match the release`);
  rel.sha = sha;
  return rel;
}

// Look up the newest release for the connected board. Cheap to call often: it does nothing while the result is fresh.
export function checkRelease(force = false) {
  const B = board();
  if (!B || !B.info) return Promise.resolve(null);
  const key = keyOf(B);
  if (!key) return Promise.resolve(null);
  if (!force && R.key === key && Date.now() - R.at < AGAIN_MS) return Promise.resolve(R.rel);
  if (R.busy && R.busyKey === key) return R.busy;
  R.busyKey = key;
  R.busy = lookup(B).catch(e => { log(`firmware release: ${e.message}`, "warn"); return null; }).then(rel => {
    if (R.busyKey === key) { R.rel = rel; R.key = key; R.at = Date.now(); R.busy = null; }
    bus.dispatchEvent(new CustomEvent("release", { detail: rel }));
    return rel;
  });
  return R.busy;
}

// The image of a release for the connected board. Checks the SHA-256 against the release asset.
export async function fetchReleaseImage(rel) {
  const r = await fetch(`${rel.site}/firmware/${rel.build.app}?v=${encodeURIComponent(rel.tag)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${rel.build.app}: HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (SC.hex(await SC.sha256(bytes)) !== rel.sha) throw new Error(`${rel.build.app}: the download does not match the SHA-256 of the release.`);
  return bytes;
}
