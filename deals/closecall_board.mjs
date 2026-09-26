// SPDX-License-Identifier: Apache-2.0
//
// Close Call board — the archiver. Runs on GitHub's public runners (.github/workflows/closecall.yml).
//
// What it does, every run:
//   1. exports the referee's five rooms (d-close1-price, -flow, -positions, -pnl, -state);
//   2. checks every NEW line: written by the pinned referee key, signed over <room>|<nonce>|<text>;
//   3. appends those lines, byte for byte, to docs/close-call/archive/<kind>/<block>.jsonl;
//   4. rebuilds docs/close-call/history.json from the whole archive with docs/close-call/model.js,
//      the same code the page runs.
//
// Why an archive at all: a technocore room is a ring of about 10 MiB. The flow room grows by about
// 5 KB a sweep and would start forgetting its first sweeps before the contest ends. Anything the
// board shows about the past has to come from a copy made while the ring still held it.
//
// It refuses to publish rather than publish something wrong: one bad signature, a room whose
// generation changed, or a sequence number going backwards stops the run with exit code 1 and
// nothing is written. A gap (the ring moved past lines we never copied) is recorded, not hidden.
//
//   node deals/closecall_board.mjs            archive + rebuild
//   node deals/closecall_board.mjs selftest   the checks, offline

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync, renameSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOSSIER = process.env.CLOSECALL_DIR ?? join(RACINE, "docs", "close-call");
const ARCHIVE = join(DOSSIER, "archive");
const META = join(ARCHIVE, "meta.json");
const HISTOIRE = join(DOSSIER, "history.json");
const BASE = (process.env.TECHNOCORE_URL ?? "https://technocore.chat").replace(/\/$/, "");
const BLOC = 500;

const model = await import(pathToFileURL(join(RACINE, "docs", "close-call", "model.js")).href);
const { KINDS, roomOf, parseRecord, makeRecordCheck, emptyHistory, ingest, crossCheck } = model;

const verify = (sig, msg, pub) => ed25519.verify(sig, msg, pub);
export const check = makeRecordCheck(verify);

// ---------------------------------------------------------------------------------------------
// The archive on disk

function blocFile(kind, seq) {
  const start = Math.floor((seq - 1) / BLOC) * BLOC + 1;
  return join(ARCHIVE, kind, `${String(start).padStart(7, "0")}.jsonl`);
}

function readMeta() {
  if (!existsSync(META)) return Object.fromEntries(KINDS.map((k) => [k, { generation: null, last_seq: 0, gaps: [] }]));
  return JSON.parse(readFileSync(META, "utf8"));
}

/** Every archived line of one room, in order, as the raw text that was signed. */
function archivedLines(kind) {
  const dir = join(ARCHIVE, kind);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) if (line.trim()) out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The venue

async function exportRoom(kind, tries = 4) {
  const url = `${BASE}/r/${roomOf(kind)}/export`;
  for (let i = 0; ; i += 1) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "closecall-board (+https://github.com/JoXp-ViBe/flop-agent)" } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      const generation = res.headers.get("x-room-generation");
      const lines = (await res.text()).split("\n").filter((l) => l.trim());
      return { generation, lines };
    } catch (e) {
      if (e.fatal || i + 1 >= tries) throw new Error(`export ${roomOf(kind)}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
  }
}

/**
 * Decide which exported lines are new and whether they may be archived. Pure: returns
 * {fresh: [lines], gap: [from, to] | null} or throws with the reason publishing must stop.
 */
export function planAppend(kind, meta, generation, lines) {
  if (meta.generation !== null && generation !== null && String(generation) !== String(meta.generation)) {
    throw new Error(`${roomOf(kind)}: room generation changed ${meta.generation} -> ${generation}, the room was reset`);
  }
  const fresh = [];
  let prev = meta.last_seq;
  let gap = null;
  for (const line of lines) {
    let rec;
    try {
      rec = parseRecord(line);
    } catch {
      continue; // an export can end on a partial line; the next run copies it whole
    }
    if (typeof rec.seq !== "number") throw new Error(`${roomOf(kind)}: line without a sequence number`);
    if (rec.seq <= meta.last_seq) continue;
    if (rec.seq <= prev) throw new Error(`${roomOf(kind)}: sequence went backwards at ${rec.seq}`);
    const why = check(kind, rec);
    if (why) throw new Error(`${roomOf(kind)} seq ${rec.seq}: ${why}`);
    if (rec.seq !== prev + 1 && gap === null) gap = [prev + 1, rec.seq - 1];
    fresh.push(line);
    prev = rec.seq;
  }
  return { fresh, gap };
}

// ---------------------------------------------------------------------------------------------
// Build

export function buildHistory(linesByKind, meta) {
  const h = emptyHistory();
  for (const kind of KINDS) {
    for (const line of linesByKind[kind]) {
      const rec = parseRecord(line);
      const why = check(kind, rec);
      if (why) throw new Error(`archive ${roomOf(kind)} seq ${rec.seq}: ${why}`);
      ingest(h, kind, rec);
    }
    h.sources[kind].gaps = meta[kind].gaps ?? [];
    h.sources[kind].generation = meta[kind].generation ?? null;
  }
  // Interleave by sweep is not needed: each room's lines are applied in order and rows are keyed
  // by sweep number, so the result does not depend on which room is read first.
  h.crossCheck = crossCheck(h);
  return h;
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", text);
  renameSync(path + ".tmp", path);
}

async function run() {
  const meta = readMeta();
  const plans = {};
  // Plan everything before writing anything: one refusal and the archive stays untouched.
  for (const kind of KINDS) {
    const { generation, lines } = await exportRoom(kind);
    plans[kind] = { generation, ...planAppend(kind, meta[kind], generation, lines) };
  }
  const linesByKind = {};
  for (const kind of KINDS) {
    const { fresh, gap, generation } = plans[kind];
    for (const line of fresh) {
      const seq = parseRecord(line).seq;
      mkdirSync(join(ARCHIVE, kind), { recursive: true });
      appendFileSync(blocFile(kind, seq), line + "\n");
    }
    if (fresh.length) meta[kind].last_seq = parseRecord(fresh[fresh.length - 1]).seq;
    if (gap) meta[kind].gaps = [...(meta[kind].gaps ?? []), gap];
    if (generation !== null) meta[kind].generation = String(generation);
    linesByKind[kind] = archivedLines(kind);
    console.log(`${roomOf(kind)}: +${fresh.length} verified, ${linesByKind[kind].length} archived${gap ? `, GAP ${gap[0]}-${gap[1]}` : ""}`);
  }
  const h = buildHistory(linesByKind, meta);
  h.generated_at = new Date().toISOString();
  if (h.crossCheck.ok === false) {
    throw new Error(`cross-check failed: ${h.crossCheck.minted} keys minted (flow) vs ${h.crossCheck.owners} owners (state)`);
  }
  writeAtomic(META, JSON.stringify(meta, null, 1) + "\n");
  writeAtomic(HISTOIRE, JSON.stringify(h) + "\n");
  console.log(`history: ${h.sweeps.length} sweeps, last ${h.latest.price?.n}, owners ${h.latest.state?.owners}, cross-check ${h.crossCheck.ok}`);
}

// ---------------------------------------------------------------------------------------------
// Self-test: every guard is shown failing once on purpose, then passing.

export function selftest() {
  const cases = [];
  const t = (name, fn) => {
    try {
      fn();
      cases.push([name, null]);
    } catch (e) {
      cases.push([name, e.message]);
    }
  };
  const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

  // A real referee line (d-close1-state, seq 1, 2026-09-25), copied from the export.
  const REAL = '{"seq":1,"ts":"2026-09-25T12:05:23.454993Z","from":"did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte","text":"{\\"file\\":\\"b71f2587d5a0963037232439985a1d939fd5e0766a968fe7117ecd8b20a29da4\\",\\"n\\":1,\\"owners\\":0,\\"rooms\\":1,\\"root\\":\\"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\\",\\"t\\":\\"state\\"}","nonce":1790337923405,"sig":"bLifr_x6jryoZEsOBBzSpphAdj59-h1SVMiiMD2GeYCw010K4rj8U6pmffIlYKhT64XE2HfZDc27E60pGRwdCw"}';
  const rec = parseRecord(REAL);

  t("a real referee line verifies", () => eq(check("state", rec), null, "check"));
  t("the same line in another room fails", () => eq(check("pnl", rec), "bad signature", "room"));
  t("one changed character in the text fails", () => eq(check("state", { ...rec, text: rec.text.replace('"owners":0', '"owners":9') }), "bad signature", "text"));
  t("another author is refused", () => eq(check("state", { ...rec, from: "did:key:z6MkkCR2AgQh8ecL2vMVVbZ7sL92hPpFmceoxpdKh7W1obrj" }), "not the referee", "from"));
  t("a line without seq is refused", () => eq(check("state", { ...rec, seq: undefined }), "no sequence number", "seq"));
  t("a 19-digit nonce keeps every digit", () => {
    const r = parseRecord('{"seq":2,"nonce":1790338014786439311,"text":"x"}');
    eq(r.nonce, "1790338014786439311", "nonce");
  });

  t("planAppend takes new verified lines", () => {
    const p = planAppend("state", { generation: "1", last_seq: 0, gaps: [] }, "1", [REAL]);
    eq([p.fresh.length, p.gap], [1, null], "plan");
  });
  t("planAppend skips what is already archived", () => {
    const p = planAppend("state", { generation: "1", last_seq: 1, gaps: [] }, "1", [REAL]);
    eq(p.fresh.length, 0, "plan");
  });
  t("planAppend records a gap instead of hiding it", () => {
    const later = REAL.replace('{"seq":1,', '{"seq":5,');
    // seq is outside the signed text, so the signature still holds: the gap is what is tested
    const p = planAppend("state", { generation: "1", last_seq: 2, gaps: [] }, "1", [later]);
    eq(p.gap, [3, 4], "gap");
  });
  t("planAppend refuses a reset room", () => {
    let msg = null;
    try { planAppend("state", { generation: "1", last_seq: 0, gaps: [] }, "2", [REAL]); } catch (e) { msg = e.message; }
    if (!msg || !msg.includes("generation changed")) throw new Error("reset not refused");
  });
  t("planAppend refuses a forged line", () => {
    let msg = null;
    const forged = REAL.replace('\\"owners\\":0', '\\"owners\\":7');
    try { planAppend("state", { generation: "1", last_seq: 0, gaps: [] }, "1", [forged]); } catch (e) { msg = e.message; }
    if (!msg || !msg.includes("bad signature")) throw new Error(`forgery not refused (${msg})`);
  });

  t("places follow the official fold: ties share the places they span", () => {
    const top = [["a", "105.74"], ["b", "97.92"], ["c", "97.92"], ["d", "97.92"], ["e", "50.00"]];
    const p = model.placesOf(top);
    eq(p.map((x) => [x.rank, x.tied, x.prize]), [[1, 1, [1, 1]], [2, 3, [2, 3]], [2, 3, [2, 3]], [2, 3, [2, 3]], [5, 1, null]], "places");
  });
  t("a tie reaching the end of the published list is marked open", () => {
    const p = model.placesOf([["a", "9.00"], ["b", "5.00"], ["c", "5.00"]]);
    eq([p[0].open, p[2].open], [false, true], "open");
  });
  t("ingest is idempotent", () => {
    const h = emptyHistory();
    ingest(h, "state", rec);
    const again = ingest(h, "state", rec);
    eq([again, h.sources.state.verified, h.sweeps.length], [false, 1, 1], "idempotent");
  });

  const failed = cases.filter(([, e]) => e);
  for (const [name, e] of cases) console.log(`${e ? "FAIL" : "ok  "} ${name}${e ? ` — ${e}` : ""}`);
  console.log(`selftest closecall_board : ${cases.length - failed.length}/${cases.length}`);
  return failed.length ? 1 : 0;
}

// Compared as real paths: the same file can be reached under two names (a mapped drive, a
// symlink, drive-letter case), and a failed comparison would make every command a silent no-op
// that exits 0. Measured on the maintainer's machine: argv said D:\..., import.meta.url said K:\...
const reel = (p) => { try { return realpathSync.native(p).toLowerCase(); } catch { return resolve(p).toLowerCase(); } };
const lance = Boolean(process.argv[1]) && reel(fileURLToPath(import.meta.url)) === reel(process.argv[1]);
if (lance) {
  const cmd = process.argv[2];
  if (cmd === "selftest") process.exit(selftest());
  run().catch((e) => {
    console.error(`REFUSED: ${e.message}`);
    process.exit(1);
  });
}
