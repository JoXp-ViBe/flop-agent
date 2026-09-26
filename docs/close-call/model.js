// SPDX-License-Identifier: Apache-2.0
//
// Close Call board — the one place where every number on the page is computed.
//
// The archiver (deals/closecall_board.mjs, run on GitHub's public runners) and the page itself
// (docs/close-call/app.js, in each visitor's browser) both import THIS file. There is no second
// implementation that could drift: a figure the page shows live is computed by the same code that
// built the history it was loaded from.
//
// Pure functions only. No network, no clock, no dependency. Signature verification is injected
// (the Ed25519 routine comes from @noble/curves in Node and from the same package on a CDN in the
// browser), so this file can be tested offline and read in one sitting.

export const REFEREE = "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte";
export const KINDS = ["price", "flow", "positions", "pnl", "state"];
export const roomOf = (kind) => `d-close1-${kind}`;

// From contest.json of flop-labs/technocore-close-call-challenge. Only facts the rules publish.
export const CONTEST = Object.freeze({
  id: "close-1",
  openTime: "2026-09-25T12:00:00Z",
  firstSweep: "2026-09-25T12:05:00Z",
  sweepSeconds: 300,
  lockSweep: 2556,
  lockTime: "2026-10-04T09:00:00Z",
  finalTime: "2026-10-04T10:00:00Z",
  mint: 10000,
  prizePool: 1000000,
  prizePlaces: 3,
  limitWindow: 0.05,
  feeRate: 0.01,
});

// One row per sweep. Column order is part of history.json's format (version 1).
export const COLS = ["n", "t", "ref", "global", "lo", "hi", "mark", "owners", "rooms",
  "open", "longs", "shorts", "settled", "void", "mints", "top1"];
const C = Object.fromEntries(COLS.map((c, i) => [c, i]));

// A snapshot of the published top list is kept every SNAP sweeps (30 minutes), plus the latest.
export const SNAP = 6;

// ---------------------------------------------------------------------------------------------
// Reading a record exactly as it was signed

/**
 * The venue signs the envelope nonce as TEXT but serves it as a JSON NUMBER. Past 2^53 a plain
 * JSON.parse rounds it and a perfectly valid signature fails. Quote it before parsing. The pattern
 * only reaches the envelope: inside `text` the quotes are escaped.
 */
export function protectNonce(json) {
  return String(json ?? "").replace(/(^|[{,])(\s*)"nonce"(\s*):(\s*)(-?\d+)(\s*)([,}])/g,
    (_, a, e1, e2, e3, digits, e4, b) => `${a}${e1}"nonce"${e2}:${e3}"${digits}"${e4}${b}`);
}

export function parseRecord(line) {
  return JSON.parse(protectNonce(line));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const d = B58.indexOf(ch);
    if (d < 0) throw new Error("not base58");
    n = n * 58n + BigInt(d);
  }
  const bytes = [];
  while (n > 0n) { bytes.push(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === "1") bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}

export function base64urlDecode(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "===".slice((b64.length + 3) % 4);
  const bin = typeof atob === "function" ? atob(pad) : Buffer.from(pad, "base64").toString("binary");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function publicKeyOfDid(did) {
  if (typeof did !== "string" || !did.startsWith("did:key:z")) return null;
  try {
    const raw = base58decode(did.slice("did:key:z".length));
    if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) return null;
    return raw.slice(2);
  } catch {
    return null;
  }
}

/**
 * Build the check that every archived or displayed record must pass: written by the pinned
 * referee key, carrying a sequence number, and signed over `<room>|<nonce>|<text>`.
 * `verify(signature, message, publicKey)` is Ed25519 from @noble/curves.
 */
export function makeRecordCheck(verify) {
  const pub = publicKeyOfDid(REFEREE);
  const enc = new TextEncoder();
  return function check(kind, rec) {
    if (!rec || rec.from !== REFEREE) return "not the referee";
    if (typeof rec.seq !== "number" || !Number.isInteger(rec.seq) || rec.seq < 1) return "no sequence number";
    if (typeof rec.text !== "string" || rec.sig === undefined || rec.nonce === undefined) return "incomplete record";
    let ok = false;
    try {
      ok = verify(base64urlDecode(rec.sig), enc.encode(`${roomOf(kind)}|${rec.nonce}|${rec.text}`), pub);
    } catch {
      ok = false;
    }
    return ok ? null : "bad signature";
  };
}

// ---------------------------------------------------------------------------------------------
// The history: an empty one, and how one referee post changes it

export function emptyHistory() {
  return {
    format: 1,
    contest: CONTEST,
    referee: REFEREE,
    cols: COLS,
    seed: null,          // {price, time, tid, package, rooms}
    final: null,         // {price, time, tid} once the referee posts it
    sources: Object.fromEntries(KINDS.map((k) => [k, { last_seq: 0, verified: 0 }])),
    sweeps: [],          // rows in COLS order, sorted by n
    totals: { settled: 0, void: 0, mints: 0, voidListed: 0, voidReasons: {} },
    latest: { pnl: null, positions: null, price: null, state: null, flow: null },
    dids: [],            // index for snapshots
    snapshots: [],       // [n, [[didIndex, score], ...]]
    didStats: {},        // did -> [firstN, lastN, sweepsInTop, bestRank, bestScore]
  };
}

const num = (s) => (s === undefined || s === null || s === "" ? null : Number(s));

function rowFor(h, n) {
  const rows = h.sweeps;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][C.n] < n) lo = mid + 1; else hi = mid;
  }
  if (lo < rows.length && rows[lo][C.n] === n) return rows[lo];
  const row = new Array(COLS.length).fill(null);
  row[C.n] = n;
  rows.splice(lo, 0, row);
  return row;
}

function didIndex(h, did) {
  let i = h.dids.indexOf(did);
  if (i < 0) { h.dids.push(did); i = h.dids.length - 1; }
  return i;
}

/**
 * Apply one VERIFIED referee record. Idempotent: a record at or below the last sequence number
 * seen for its room changes nothing, so the page can re-read an overlapping tail safely.
 * Returns true when the record was new.
 */
export function ingest(h, kind, rec) {
  const src = h.sources[kind];
  if (rec.seq <= src.last_seq) return false;
  src.last_seq = rec.seq;
  src.verified += 1;
  const m = JSON.parse(rec.text);

  if (kind === "price") {
    if (m.t === "seed") {
      h.seed = { price: m.price, time: m.trade?.time ?? null, tid: m.trade?.tid ?? null,
        package: m.package ?? null, rooms: m.rooms ?? [] };
      return true;
    }
    if (m.t === "final") {
      h.final = { price: m.price, time: m.trade?.time ?? null, tid: m.trade?.tid ?? null, at: rec.ts };
      return true;
    }
    if (m.t !== "price") return true;
    const r = rowFor(h, m.n);
    r[C.t] = rec.ts;
    r[C.ref] = num(m.ref?.px);
    r[C.global] = num(m.global);
    r[C.lo] = num(m.limits?.[0]);
    r[C.hi] = num(m.limits?.[1]);
    h.latest.price = { n: m.n, for: m.for ?? null, ts: rec.ts, ref: m.ref ?? null, global: m.global ?? null,
      limits: m.limits ?? null, age_s: m.age_s ?? null, file: m.file ?? null };
    return true;
  }

  if (kind === "flow") {
    if (m.t !== "flow") return true;
    const om = m.omitted ?? {};
    const settled = (m.settled?.length ?? 0) + (om.settled ?? 0);
    const voided = (m.void?.length ?? 0) + (om.void ?? 0);
    const mints = (m.mints?.length ?? 0) + (om.mints ?? 0);
    const r = rowFor(h, m.n);
    r[C.settled] = settled;
    r[C.void] = voided;
    r[C.mints] = mints;
    h.totals.settled += settled;
    h.totals.void += voided;
    h.totals.mints += mints;
    for (const v of m.void ?? []) {
      const reason = Array.isArray(v) ? v[1] : null;
      if (typeof reason !== "string") continue;
      h.totals.voidListed += 1;
      h.totals.voidReasons[reason] = (h.totals.voidReasons[reason] ?? 0) + 1;
    }
    h.latest.flow = { n: m.n, ts: rec.ts, settled, void: voided, mints,
      newRooms: m.rooms ?? [], missed: m.missed ?? [], file: m.file ?? null };
    return true;
  }

  if (kind === "positions") {
    if (m.t !== "positions") return true;
    const r = rowFor(h, m.n);
    r[C.open] = num(m.open);
    r[C.longs] = num(m.longs);
    r[C.shorts] = num(m.shorts);
    h.latest.positions = { n: m.n, ts: rec.ts, open: m.open, longs: m.longs, shorts: m.shorts,
      top: m.top ?? [], file: m.file ?? null };
    return true;
  }

  if (kind === "pnl") {
    if (m.t !== "pnl") return true;
    const top = Array.isArray(m.top) ? m.top : [];
    const r = rowFor(h, m.n);
    r[C.mark] = num(m.mark);
    r[C.top1] = top.length ? num(top[0][1]) : null;
    h.latest.pnl = { n: m.n, ts: rec.ts, mark: m.mark, top, file: m.file ?? null };
    top.forEach(([did, score], i) => {
      const s = Number(score);
      const st = h.didStats[did] ?? [m.n, m.n, 0, i + 1, s];
      st[1] = m.n;
      st[2] += 1;
      if (i + 1 < st[3]) st[3] = i + 1;
      if (s > st[4]) st[4] = s;
      h.didStats[did] = st;
    });
    if (m.n % SNAP === 0) h.snapshots.push([m.n, top.map(([did, score]) => [didIndex(h, did), Number(score)])]);
    return true;
  }

  if (kind === "state") {
    if (m.t !== "state") return true;
    const r = rowFor(h, m.n);
    r[C.owners] = num(m.owners);
    r[C.rooms] = num(m.rooms);
    h.latest.state = { n: m.n, ts: rec.ts, owners: m.owners, rooms: m.rooms, root: m.root ?? null, file: m.file ?? null };
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// What the page derives, all from the history

/**
 * Places the way the official fold assigns them: owners with the same score share the places
 * their group spans (close_call_fold.py, Fold.final). Only the published top list is known, so a
 * group that runs to the end of the list may continue past it: `open` says the count is a minimum.
 */
export function placesOf(top, places = CONTEST.prizePlaces) {
  const out = [];
  let place = 0;
  let i = 0;
  while (i < top.length) {
    let j = i;
    while (j + 1 < top.length && top[j + 1][1] === top[i][1]) j += 1;
    const size = j - i + 1;
    const first = place + 1;
    const last = place + size;
    const open = j === top.length - 1;
    for (let k = i; k <= j; k += 1) {
      out.push({ did: top[k][0], score: Number(top[k][1]), rank: first,
        tied: size, open, prize: first <= places ? [first, Math.min(last, places)] : null });
    }
    place += size;
    i = j + 1;
  }
  return out;
}

/** The one cross-check two independent referee rooms allow: keys minted (flow) = owners (state). */
export function crossCheck(h) {
  const owners = h.latest.state?.owners ?? null;
  if (owners === null || h.latest.state?.n !== h.latest.flow?.n) return { ok: null, owners, minted: h.totals.mints };
  return { ok: owners === h.totals.mints, owners, minted: h.totals.mints };
}

/** Score history of one key from the snapshots and the latest list; [n, rank, score] points. */
export function trajectory(h, did) {
  const idx = h.dids.indexOf(did);
  const pts = [];
  if (idx >= 0) {
    for (const [n, list] of h.snapshots) {
      const pos = list.findIndex(([d]) => d === idx);
      if (pos >= 0) pts.push([n, pos + 1, list[pos][1]]);
    }
  }
  const latest = h.latest.pnl;
  if (latest) {
    const pos = latest.top.findIndex(([d]) => d === did);
    if (pos >= 0 && (!pts.length || pts[pts.length - 1][0] !== latest.n)) pts.push([latest.n, pos + 1, Number(latest.top[pos][1])]);
  }
  return pts;
}

/** When sweep n is due by the rules' clock (the first at firstSweep, then every sweepSeconds). */
export function sweepTime(n) {
  return new Date(Date.parse(CONTEST.firstSweep) + (n - 1) * CONTEST.sweepSeconds * 1000);
}

export function col(h, name) {
  const i = C[name];
  return h.sweeps.map((r) => r[i]);
}
