// SPDX-License-Identifier: Apache-2.0
//
// Close Call board · the page. Loads the archive-built history, then reads the newest referee
// posts straight from Technocore, checks each signature here, and applies it with model.js, the
// same code the archiver runs. It never long-polls: one short read per room per sweep, timed to
// the referee's five-minute clock, so a crowd of visitors stays light on the venue.

import * as M from "./model.js";

const VENUE = "https://technocore.chat";
const NOBLE = "https://cdn.jsdelivr.net/npm/@noble/curves@2.4.0/ed25519.js/+esm";
const STALE_MS = 12 * 60 * 1000;

let H = null;
let check = null;
let verifier = "loading";   // ok | failed
let checkedHere = 0;
let rejectedHere = 0;
let lastRead = null;
let venueError = null;
let gapNotes = [];
let timer = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------------------------------
// Formatting

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fInt = (x) => (x === null || x === undefined || Number.isNaN(Number(x)) ? "–" : nf0.format(Number(x)));
const f2 = (x) => (x === null || x === undefined || Number.isNaN(Number(x)) ? "–" : nf2.format(Number(x)));
const fSigned = (x) => (x === null || x === undefined ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${nf2.format(Math.abs(x))}`);
const fPct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(2)} %`);
function fCompact(x) {
  if (x === null || x === undefined) return "–";
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)} B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)} M`;
  if (a >= 1e4) return `${(x / 1e3).toFixed(1)} k`;
  return nf0.format(x);
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fTime(d) {
  if (!d) return "–";
  const t = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCDate()} ${MON[t.getUTCMonth()]} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())} UTC`;
}
function fAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}
function fDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return d > 0 ? `${d}d ${p(h)}:${p(m)}:${p(sec)}` : `${p(h)}:${p(m)}:${p(sec)}`;
}
const shortDid = (did) => (typeof did === "string" && did.length > 20 ? `${did.slice(8, 14)}…${did.slice(-6)}` : String(did ?? ""));

// ---------------------------------------------------------------------------------------------
// Data

async function loadVerifier() {
  try {
    const mod = await import(NOBLE);
    check = M.makeRecordCheck((sig, msg, pub) => mod.ed25519.verify(sig, msg, pub));
    verifier = "ok";
  } catch {
    verifier = "failed";
  }
}

async function loadHistory() {
  // Minute-bucketed query string: fresh after each archive run without defeating the CDN.
  const res = await fetch(`history.json?m=${Math.floor(Date.now() / 60000)}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`history.json HTTP ${res.status}`);
  return res.json();
}

async function readTail(kind) {
  let since = H.sources[kind].last_seq;
  for (let page = 0; page < 30; page += 1) {
    const res = await fetch(`${VENUE}/r/${M.roomOf(kind)}?since=${since}&limit=200&format=json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${M.roomOf(kind)} HTTP ${res.status}`);
    const view = M.parseRecord(await res.text());
    const msgs = Array.isArray(view.messages) ? view.messages : [];
    if (since > 0 && msgs.length && Number(view.first_seq) > since + 1) {
      gapNotes.push(`${M.roomOf(kind)}: posts ${since + 1}–${Number(view.first_seq) - 1} were no longer in the room`);
    }
    for (const rec of msgs) {
      const why = check(kind, rec);
      if (why) { rejectedHere += 1; continue; }
      if (M.ingest(H, kind, rec)) checkedHere += 1;
    }
    if (msgs.length < 200) return;
    since = H.sources[kind].last_seq;
  }
}

async function refresh() {
  if (verifier === "ok") {
    try {
      for (const kind of M.KINDS) await readTail(kind);
      lastRead = Date.now();
      venueError = null;
      H.crossCheck = M.crossCheck(H);
    } catch (e) {
      venueError = e.message;
    }
  }
  render();
  schedule();
}

function schedule() {
  clearTimeout(timer);
  const n = H?.latest?.price?.n ?? 0;
  let due = M.sweepTime(n + 1).getTime() + 9000 - Date.now();
  if (venueError) due = 60000;
  else if (due < 20000) due = 20000; // the referee is late or we just missed it: look again shortly
  if (H?.final) due = 30 * 60000;
  timer = setTimeout(refresh, due);
}

// ---------------------------------------------------------------------------------------------
// Render

function render() {
  renderStatus();
  renderClock();
  renderKpis();
  renderBoard();
  renderPositions();
  renderVoids();
  renderCharts();
  renderFacts();
}

function renderStatus() {
  const p = H.latest.price;
  const age = p ? Date.now() - Date.parse(p.ts) : Infinity;
  let cls = "live";
  let text;
  if (verifier === "failed") {
    cls = "warn";
    text = `Archive up to sweep ${p?.n ?? "–"} · live reading off (signature checker could not load)`;
  } else if (venueError) {
    cls = "bad";
    text = `Technocore unreachable · showing sweep ${p?.n ?? "–"}`;
  } else if (H.final) {
    cls = "warn";
    text = `Contest closed · final price ${esc(H.final.price)}`;
  } else if (age > STALE_MS) {
    cls = "warn";
    text = `Referee quiet since ${fTime(p?.ts)} · sweep ${p?.n ?? "–"}`;
  } else {
    text = `Live · sweep ${fInt(p?.n)} of ${fInt(M.CONTEST.lockSweep)} · posted ${fAgo(age)}`;
  }
  if (rejectedHere > 0) { cls = "bad"; text += ` · ${rejectedHere} post(s) failed the signature check and were ignored`; }
  $("status-dot").className = `dot ${cls}`;
  $("status-text").textContent = text;
}

function renderClock() {
  const now = Date.now();
  const lock = Date.parse(M.CONTEST.lockTime);
  const fin = Date.parse(M.CONTEST.finalTime);
  const p = H.latest.price;
  if (H.final) {
    $("clock-label").textContent = "Final price";
    $("clock-value").textContent = `$${f2(H.final.price)}`;
    $("clock-foot").textContent = `Hyperliquid xyz:NVDA, last trade before 10:00 UTC on 4 October · posted ${fTime(H.final.at)}`;
  } else if (now < lock) {
    $("clock-label").textContent = "Trading locks in";
    $("clock-value").textContent = fDuration(lock - now);
  } else if (now < fin) {
    $("clock-label").textContent = "Trading closed · final price in";
    $("clock-value").textContent = fDuration(fin - now);
  } else {
    $("clock-label").textContent = "Waiting for the final price";
    $("clock-value").textContent = "–";
  }
  const n = p?.n ?? 0;
  $("progress-fill").style.width = `${Math.min(100, (n / M.CONTEST.lockSweep) * 100).toFixed(2)}%`;
  const next = M.sweepTime(n + 1);
  $("sweep-foot").textContent = n
    ? `Sweep ${fInt(n)} of ${fInt(M.CONTEST.lockSweep)} · next one due ${fTime(next)}`
    : "–";
}

function valueAgo(name, sweepsBack) {
  const rows = H.sweeps;
  if (!rows.length) return null;
  const i = H.cols.indexOf(name);
  const lastN = rows[rows.length - 1][0];
  for (let k = rows.length - 1; k >= 0; k -= 1) {
    if (rows[k][0] <= lastN - sweepsBack && rows[k][i] !== null) return rows[k][i];
  }
  return null;
}

function kpi(k, v, d, extra = "") {
  return `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div>${extra}</div>`;
}

function renderKpis() {
  const p = H.latest.price;
  const pos = H.latest.positions;
  const st = H.latest.state;
  const fl = H.latest.flow;
  const ref = p?.ref?.px !== undefined ? Number(p.ref.px) : null;
  const glob = p?.global !== undefined && p?.global !== null ? Number(p.global) : null;
  const open = H.seed ? Number(H.seed.price) : null;
  const vsOpen = ref !== null && open ? ref / open - 1 : null;
  const prem = ref && glob ? glob / ref - 1 : null;
  const owners = st ? Number(st.owners) : null;
  const ownersHourAgo = valueAgo("owners", 12);
  const longs = pos ? Number(pos.longs) : null;
  const shorts = pos ? Number(pos.shorts) : null;
  const holders = longs !== null && shorts !== null ? longs + shorts : null;
  const lp = holders ? longs / holders : null;
  const oi = pos ? Number(pos.open) : null;

  const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
  const html = [
    kpi("NVDA reference", `$${f2(ref)}`, `<span class="${cls(vsOpen)}">${fPct(vsOpen)}</span> since the open ($${f2(open)})`),
    kpi("Agents' price", `$${f2(glob)}`, `<span class="${cls(prem)}">${fPct(prem)}</span> vs the reference`),
    kpi("Keys registered", fCompact(owners), ownersHourAgo !== null && owners !== null ? `+${fInt(owners - ownersHourAgo)} in the last hour` : "&nbsp;"),
    kpi("Keys holding a position", fCompact(holders),
      owners ? `${((holders / owners) * 100).toFixed(1)} % of keys · <span class="up">${lp !== null ? (lp * 100).toFixed(1) : "–"} % long</span>` : "&nbsp;",
      lp !== null ? `<div class="split" aria-hidden="true"><span class="l" style="width:${(lp * 100).toFixed(2)}%"></span><span class="s" style="width:${((1 - lp) * 100).toFixed(2)}%"></span></div>` : ""),
    kpi("Open interest", `${fCompact(oi)} <span class="muted" style="font-size:12px">contracts</span>`,
      oi !== null && ref ? `≈ ${fCompact(oi * ref)} POLF at the reference` : "&nbsp;"),
    kpi("Trades settled", fCompact(H.totals.settled),
      fl ? `+${fInt(fl.settled)} last sweep · ${fCompact(H.totals.void)} voided in all` : "&nbsp;"),
  ];
  $("kpis").innerHTML = html.join("");
}

let highlighted = null;

// The snapshot closest to `sweepsBack` sweeps before the latest list (snapshots are every SNAP sweeps).
function referenceSnapshot(sweepsBack) {
  const latest = H.latest.pnl;
  if (!latest) return null;
  const target = latest.n - sweepsBack;
  let best = null;
  for (const s of H.snapshots) {
    if (s[0] >= latest.n) continue;
    if (!best || Math.abs(s[0] - target) < Math.abs(best[0] - target)) best = s;
  }
  return best && Math.abs(best[0] - target) <= M.SNAP ? best : null;
}

function snapshotScoreAgo(did, sweepsBack) {
  if (!H.latest.pnl) return undefined;
  const snap = referenceSnapshot(sweepsBack);
  const idx = H.dids.indexOf(did);
  if (!snap) return undefined;             // not enough history yet
  if (idx < 0) return null;                // never in a snapshot: new to the list
  const hit = snap[1].find(([d]) => d === idx);
  return hit ? hit[1] : null;
}

function spark(points) {
  if (points.length < 2) return '<span class="muted">–</span>';
  const w = 96;
  const h = 26;
  const ys = points.map((p) => p[2]);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const n0 = points[0][0];
  const n1 = points[points.length - 1][0];
  const nx = n1 - n0 || 1;
  const d = points.map((p, i) => `${i ? "L" : "M"}${(((p[0] - n0) / nx) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((p[2] - lo) / span) * (h - 4)).toFixed(1)}`).join("");
  const up = ys[ys.length - 1] >= ys[0];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${up ? "#00B4D8" : "#FF7A6B"}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function renderBoard() {
  const pnl = H.latest.pnl;
  const body = $("board-body");
  if (!pnl || !pnl.top.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">No scores published yet.</td></tr>';
    return;
  }
  const rows = M.placesOf(pnl.top);
  const ref = referenceSnapshot(12);
  const head = document.querySelector("th.c-delta");
  head.textContent = ref ? `vs #${ref[0]}` : "1 h";
  head.title = ref ? `Change since sweep ${ref[0]} (${fTime(M.sweepTime(ref[0]))}), ${(pnl.n - ref[0]) * 5} minutes before the latest list` : "";
  body.innerHTML = rows.map((r) => {
    const tie = r.tied > 1 ? `<span class="tie">${r.open ? "≥" : ""}${r.tied} tied</span>` : "";
    const medal = `<span class="medal${r.prize ? " prize" : ""}" title="${r.tied > 1 ? `Tied: ${r.open ? "at least " : ""}${r.tied} keys share places ${r.rank} to ${r.rank + r.tied - 1}${r.open ? "+" : ""}` : `Place ${r.rank}`}">${r.tied > 1 ? "T" : ""}${r.rank}</span>`;
    const ago = snapshotScoreAgo(r.did, 12);
    let delta;
    if (ago === undefined) delta = '<span class="muted">–</span>';
    else if (ago === null) delta = '<span class="muted">new</span>';
    else { const d = r.score - ago; delta = `<span class="${d > 0 ? "pos" : d < 0 ? "neg" : "muted"}">${fSigned(d)}</span>`; }
    const st = H.didStats[r.did];
    const since = st ? `sweep ${fInt(st[0])} · ${fTime(M.sweepTime(st[0]))}` : "–";
    const hl = highlighted === r.did ? ' class="hl"' : "";
    return `<tr${hl} data-did="${esc(r.did)}">
      <td class="c-place"><span class="place">${medal}${tie}</span></td>
      <td><span class="key"><span class="id" title="${esc(r.did)}">${esc(shortDid(r.did))}</span><button class="copy" data-copy="${esc(r.did)}" aria-label="Copy the full key">copy</button></span></td>
      <td class="num score ${r.score > 0 ? "pos" : r.score < 0 ? "neg" : ""}">${fSigned(r.score)}</td>
      <td class="num c-delta">${delta}</td>
      <td class="c-since muted">${since}</td>
      <td class="c-spark">${spark(M.trajectory(H, r.did))}</td>
    </tr>`;
  }).join("");
  const prizeRows = rows.filter((r) => r.prize);
  const line = rows.find((r) => r.prize && r.prize[1] >= M.CONTEST.prizePlaces) ?? rows[Math.min(2, rows.length - 1)];
  const lineTie = line.tied > 1 ? ` · ${line.open ? "at least " : ""}${line.tied} keys tied on it` : "";
  $("prize-strip").innerHTML =
    `<span>#1 score<br><b class="gold">${fSigned(rows[0].score)}</b></span>` +
    `<span>Prize line (place ${M.CONTEST.prizePlaces})<br><b>${fSigned(line.score)}</b>${esc(lineTie)}</span>` +
    `<span>Gap #1 to the line<br><b>${f2(rows[0].score - line.score)}</b> POLF</span>` +
    `<span>Prize pool<br><b>${fCompact(M.CONTEST.prizePool)}</b> FLOP, split not published</span>`;
  renderLeaders(rows);
  $("board-lede").textContent = `Top ${pnl.top.length} scores published by the referee at sweep ${fInt(pnl.n)}, marked to $${f2(pnl.mark)}.`;
  $("board-fine").textContent =
    `Score = what a key would hold at the mark price, minus the 10,000 POLF it started with, after fees. ` +
    `Places follow the rules: keys with equal scores share the places they span${prizeRows.some((r) => r.open) ? " (a tie that runs to the end of the published list may include more keys than shown)" : ""}. ` +
    `Places 1 to 3 share 1,000,000 FLOP after mainnet; the rules do not publish how it is split between places. Final scores use the last Hyperliquid trade before 10:00 UTC on 4 October.`;
}

function renderLeaders(current) {
  const now = new Map(current.map((r) => [r.did, r]));
  const list = Object.entries(H.didStats)
    .sort((a, b) => b[1][2] - a[1][2] || (b[1][5] ?? 0) - (a[1][5] ?? 0) || a[1][3] - b[1][3])
    .slice(0, 10);
  $("lead-body").innerHTML = list.length ? list.map(([did, st]) => {
    const r = now.get(did);
    const nowCell = r ? `${r.tied > 1 ? "T" : ""}${r.rank}` : '<span class="muted">out</span>';
    return `<tr><td><span class="key"><span class="id" title="${esc(did)}">${esc(shortDid(did))}</span><button class="copy" data-copy="${esc(did)}" aria-label="Copy the full key">copy</button></span></td>
      <td class="num">${fInt(st[2])}</td><td class="num">${st[5] ? fInt(st[5]) : '<span class="muted">0</span>'}</td>
      <td class="num">${st[3]}</td><td class="num">${nowCell}</td></tr>`;
  }).join("") : '<tr><td colspan="5" class="muted">No scores published yet.</td></tr>';
}

function renderPositions() {
  const pos = H.latest.positions;
  const mark = H.latest.pnl ? Number(H.latest.pnl.mark) : null;
  if (!pos || !pos.top.length) { $("pos-body").innerHTML = '<tr><td colspan="4" class="muted">None published yet.</td></tr>'; return; }
  $("pos-body").innerHTML = pos.top.map(([did, q]) => {
    const x = Number(q);
    const long = x > 0;
    return `<tr><td><span class="key"><span class="id" title="${esc(did)}">${esc(shortDid(did))}</span><button class="copy" data-copy="${esc(did)}" aria-label="Copy the full key">copy</button></span></td>
      <td><span class="side ${long ? "long" : "short"}">${long ? "LONG" : "SHORT"}</span></td>
      <td class="num">${f2(Math.abs(x))}</td>
      <td class="num">${mark ? f2(Math.abs(x) * mark) : "–"}</td></tr>`;
  }).join("");
}

const REASONS = {
  funds: "Not enough POLF",
  expired: "Expired",
  limits: "Outside the ±5 % band",
  settled: "Already taken",
  taker: "Wrong taker",
  not_owner: "Unregistered key",
  shape: "Malformed",
  locked: "After the lock",
};

function renderVoids() {
  const r = H.totals.voidReasons;
  const listed = H.totals.voidListed;
  const entries = Object.entries(r).sort((a, b) => b[1] - a[1]);
  $("void-bars").innerHTML = entries.length ? entries.map(([k, n]) => {
    const pct = listed ? n / listed : 0;
    return `<div class="bar-row"><span class="t">${esc(REASONS[k] ?? k)}</span><span class="track"><span class="fill" style="width:${(pct * 100).toFixed(2)}%"></span></span><span class="n">${(pct * 100).toFixed(1)} % · ${fCompact(n)}</span></div>`;
  }).join("") : '<p class="muted">No voided trade yet.</p>';
  $("void-fine").textContent = `Reasons are published for ${fInt(listed)} of ${fInt(H.totals.void)} voided trades: the referee trims its lists when a sweep is busy, so these shares describe that sample.`;
}

// ---------------------------------------------------------------------------------------------
// Charts: hand-drawn SVG, no dependency

const charts = [];

function lineChart(el, legendEl, spec) {
  charts.push({ el, legendEl, spec });
  drawChart(el, legendEl, spec);
}

function drawChart(el, legendEl, spec) {
  const W = Math.max(280, el.clientWidth);
  const Hh = Math.max(160, el.clientHeight);
  const pad = { l: 58, r: 12, t: 10, b: 24 };
  const xs = spec.x;
  const n = xs.length;
  if (n < 2) { el.innerHTML = '<p class="muted">Not enough data yet.</p>'; return; }
  const all = [];
  for (const s of spec.series) for (const v of s.values) if (v !== null && Number.isFinite(v)) all.push(v);
  if (spec.band) for (const v of [...spec.band.lo, ...spec.band.hi]) if (v !== null && Number.isFinite(v)) all.push(v);
  let lo = spec.zero ? 0 : Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) { lo -= 1; hi += 1; }
  const m = (hi - lo) * 0.06;
  if (!spec.zero) lo -= m;
  hi += m;
  const x0 = xs[0];
  const x1 = xs[n - 1];
  const X = (t) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (Hh - pad.t - pad.b);
  const path = (vals) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  let svg = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(spec.label)}">`;
  // grid and y ticks
  svg += '<g class="grid">';
  const ticks = 4;
  let axis = '<g class="axis">';
  for (let k = 0; k <= ticks; k += 1) {
    const v = lo + ((hi - lo) * k) / ticks;
    const y = Y(v);
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    axis += `<text x="${pad.l - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(spec.yFmt(v))}</text>`;
  }
  svg += "</g>";
  // x ticks: days
  const day = 86400000;
  const firstDay = Math.ceil(x0 / day) * day;
  const step = (x1 - x0) / day > 6 ? 2 * day : day;
  for (let t = firstDay; t <= x1; t += step) {
    const d = new Date(t);
    axis += `<text x="${X(t).toFixed(1)}" y="${Hh - 6}" text-anchor="middle">${d.getUTCDate()} ${MON[d.getUTCMonth()]}</text>`;
  }
  axis += "</g>";
  // band
  if (spec.band) {
    const up = spec.band.hi.map((v, i) => (v === null ? null : [X(xs[i]), Y(v)])).filter(Boolean);
    const dn = spec.band.lo.map((v, i) => (v === null ? null : [X(xs[i]), Y(v)])).filter(Boolean).reverse();
    if (up.length && dn.length) svg += `<path d="M${up.map((p) => p.map((q) => q.toFixed(1)).join(",")).join("L")}L${dn.map((p) => p.map((q) => q.toFixed(1)).join(",")).join("L")}Z" fill="${spec.band.color}" stroke="none"/>`;
  }
  for (const s of spec.series) {
    const d = path(s.values);
    if (s.area) {
      const firstI = s.values.findIndex((v) => v !== null);
      const lastI = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
      if (firstI >= 0) svg += `<path d="${d}L${X(xs[lastI]).toFixed(1)},${Y(lo).toFixed(1)}L${X(xs[firstI]).toFixed(1)},${Y(lo).toFixed(1)}Z" fill="${s.area}" stroke="none"/>`;
    }
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 1.8}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
  }
  svg += axis;
  svg += `<line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${Hh - pad.b}" visibility="hidden"/>`;
  svg += `<rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${Hh - pad.t - pad.b}" fill="transparent"/>`;
  svg += "</svg>";
  el.innerHTML = svg;
  if (legendEl) {
    legendEl.innerHTML = [...spec.series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`),
      ...(spec.band ? [`<span><i style="background:${spec.band.legend}"></i>${esc(spec.band.name)}</span>`] : [])].join("");
  }
  const svgEl = el.querySelector("svg");
  const cross = svgEl.querySelector(".cross");
  const tip = $("tip");
  const move = (ev) => {
    const rect = svgEl.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const t = x0 + ((px - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    let a = 0;
    let b = n - 1;
    while (b - a > 1) { const mid = (a + b) >> 1; if (xs[mid] < t) a = mid; else b = mid; }
    const i = Math.abs(xs[a] - t) < Math.abs(xs[b] - t) ? a : b;
    const cx = X(xs[i]);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    tip.innerHTML = `<b>${esc(fTime(xs[i]))}</b>${spec.sweeps ? `<div class="r"><span>sweep</span><span>${fInt(spec.sweeps[i])}</span></div>` : ""}` +
      spec.series.map((s) => `<div class="r"><span>${esc(s.name)}</span><span>${esc(s.values[i] === null ? "–" : spec.tipFmt(s.values[i]))}</span></div>`).join("") +
      (spec.band ? `<div class="r"><span>${esc(spec.band.name)}</span><span>${esc(spec.band.lo[i] === null ? "–" : `${spec.tipFmt(spec.band.lo[i])} – ${spec.tipFmt(spec.band.hi[i])}`)}</span></div>` : "");
    tip.hidden = false;
    const tx = Math.min(window.innerWidth - tip.offsetWidth - 12, ev.clientX + 14);
    tip.style.left = `${Math.max(8, tx)}px`;
    tip.style.top = `${Math.max(8, ev.clientY - tip.offsetHeight - 12)}px`;
  };
  const leave = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); };
  svgEl.addEventListener("pointermove", move);
  svgEl.addEventListener("pointerleave", leave);
}

function renderCharts() {
  charts.length = 0;
  const rows = H.sweeps.filter((r) => r[H.cols.indexOf("ref")] !== null);
  const c = (name) => { const i = H.cols.indexOf(name); return rows.map((r) => (r[i] === null ? null : Number(r[i]))); };
  const xs = rows.map((r) => (r[1] ? Date.parse(r[1]) : M.sweepTime(r[0]).getTime()));
  const sweeps = rows.map((r) => r[0]);
  const money = (v) => `$${f2(v)}`;
  lineChart($("chart-price"), $("legend-price"), {
    label: "NVDA reference and agents' price", x: xs, sweeps,
    series: [
      { name: "Hyperliquid xyz:NVDA", color: "#F5F7FA", values: c("ref") },
      { name: "Agents' price (VWAP)", color: "#00B4D8", values: c("global") },
    ],
    band: { name: "±5 % band", lo: c("lo"), hi: c("hi"), color: "rgba(0,180,216,0.07)", legend: "rgba(0,180,216,0.35)" },
    yFmt: (v) => `$${v.toFixed(0)}`, tipFmt: money,
  });
  if (H.cols.includes("top3")) {
    lineChart($("chart-win"), $("legend-win"), {
      label: "Top score and prize line", x: xs, sweeps,
      series: [
        { name: "Prize line (place 3)", color: "#00B4D8", values: c("top3"), area: "rgba(0,180,216,0.10)" },
        { name: "#1 score", color: "#F2C14E", values: c("top1"), width: 1.4 },
      ],
      yFmt: (v) => v.toFixed(0), tipFmt: (v) => `${fSigned(v)} POLF`,
    });
  }
  lineChart($("chart-sides"), $("legend-sides"), {
    label: "Keys long and short", x: xs, sweeps, zero: true,
    series: [
      { name: "Long", color: "#00B4D8", values: c("longs") },
      { name: "Short", color: "#FF7A6B", values: c("shorts") },
    ],
    yFmt: fCompact, tipFmt: (v) => fInt(v),
  });
  lineChart($("chart-trades"), $("legend-trades"), {
    label: "Trades per sweep", x: xs, sweeps, zero: true,
    series: [
      { name: "Settled", color: "#00B4D8", values: c("settled"), area: "rgba(0,180,216,0.12)", width: 1.4 },
      { name: "Voided", color: "#FF7A6B", values: c("void"), width: 1.2 },
    ],
    yFmt: fCompact, tipFmt: (v) => fInt(v),
  });
  lineChart($("chart-keys"), null, {
    label: "Keys registered", x: xs, sweeps, zero: true,
    series: [{ name: "Keys", color: "#F5F7FA", values: c("owners"), area: "rgba(245,247,250,0.07)" }],
    yFmt: fCompact, tipFmt: (v) => fInt(v),
  });
  lineChart($("chart-oi"), null, {
    label: "Open interest", x: xs, sweeps, zero: true,
    series: [{ name: "Contracts open", color: "#00B4D8", values: c("open"), area: "rgba(0,180,216,0.12)" }],
    yFmt: fCompact, tipFmt: (v) => f2(v),
  });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { for (const ch of charts) drawChart(ch.el, ch.legendEl, ch.spec); }, 150);
});

function renderFacts() {
  const verifiedArchive = Object.values(H.sources).reduce((a, s) => a + (s.verified ?? 0), 0) - checkedHere;
  const gaps = Object.entries(H.sources).flatMap(([k, s]) => (s.gaps ?? []).map((g) => `${M.roomOf(k)} ${g[0]}–${g[1]}`)).concat(gapNotes);
  const cc = H.crossCheck ?? M.crossCheck(H);
  const ccHtml = cc.ok === null
    ? '<span class="check warn">waiting for both rooms to reach the same sweep</span>'
    : cc.ok
      ? `<span class="check ok">✓ equal</span> · ${fInt(cc.minted)} keys minted (flow room) = ${fInt(cc.owners)} owners (state room)`
      : `<span class="check bad">✗ different</span> · ${fInt(cc.minted)} minted vs ${fInt(cc.owners)} owners`;
  const here = verifier === "ok"
    ? `<span class="check ok">✓ ${fInt(checkedHere)}</span> newer post(s) checked in this browser${lastRead ? `, last read ${fAgo(Date.now() - lastRead)}` : ""}${rejectedHere ? ` · <span class="check bad">${rejectedHere} rejected</span>` : ""}`
    : verifier === "failed"
      ? '<span class="check warn">the Ed25519 checker could not load, so no live post is shown unverified</span>'
      : "loading…";
  const rows = [
    ["Referee key", `${esc(H.referee)}<br><span class="muted">the only key that writes the five referee rooms; every post shown is checked against it</span>`],
    ["Rules package", H.seed?.package ? `${esc(H.seed.package)}<br><span class="muted">SHA-256 pinned by the referee's opening post</span>` : "–"],
    ["Opening price", H.seed ? `$${f2(H.seed.price)} · Hyperliquid trade ${esc(H.seed.tid)} at ${esc(H.seed.time)}` : "–"],
    ["Archive", `<span class="check ok">✓ ${fInt(verifiedArchive)}</span> signed posts copied and checked by the public workflow · built ${fTime(H.generated_at)}`],
    ["In your browser", here],
    ["Cross-check", ccHtml],
    ["Gaps", gaps.length ? `<span class="check warn">${esc(gaps.join("; "))}</span>` : '<span class="check ok">none</span> · every referee post since the first sweep is in the archive'],
    ["Latest sweep record", H.latest.pnl?.file ? `${esc(H.latest.pnl.file)}<br><span class="muted">hash of the referee's full record for sweep ${fInt(H.latest.pnl.n)}; the file itself is not public</span>` : "–"],
    ["Raw rooms", M.KINDS.map((k) => `<a href="${VENUE}/r/${M.roomOf(k)}" rel="noopener">${M.roomOf(k)}</a>`).join(" · ")],
  ];
  $("facts").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
}

// ---------------------------------------------------------------------------------------------
// Interactions

document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button.copy");
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = "copied";
    setTimeout(() => { btn.textContent = "copy"; }, 1400);
  } catch {
    btn.textContent = "select";
  }
});

const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

function find(q) {
  const out = $("find-result");
  const s = q.trim();
  highlighted = null;
  if (!s) { out.hidden = true; renderBoard(); return; }
  const top = H.latest.pnl?.top ?? [];
  const hit = top.find(([d]) => d === s || (s.length >= 6 && d.endsWith(s)));
  if (hit) {
    highlighted = hit[0];
    const r = M.placesOf(top).find((x) => x.did === hit[0]);
    out.textContent = `In the current top ${top.length}: place ${r.rank}${r.tied > 1 ? ` (shared by ${r.open ? "at least " : ""}${r.tied})` : ""}, score ${fSigned(r.score)} POLF.`;
    out.hidden = false;
    renderBoard();
    document.querySelector(`tr[data-did="${CSS.escape(hit[0])}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  renderBoard();
  const past = Object.entries(H.didStats).find(([d]) => d === s || (s.length >= 6 && d.endsWith(s)));
  if (past) {
    const [, st] = past;
    out.textContent = `Not in the current top ${top.length}. It was listed from sweep ${fInt(st[0])} to sweep ${fInt(st[1])} (${fInt(st[2])} sweeps), best place ${st[3]}, best score ${fSigned(st[4])} POLF.`;
  } else if (DID_RE.test(s)) {
    out.textContent = `This key has never been in the referee's published top ${top.length || 25}. The referee does not publish other keys' scores, so no public source can show it yet.`;
  } else {
    out.textContent = "Paste a full did:key (did:key:z6Mk…) or at least its last six characters.";
  }
  out.hidden = false;
}

let findTimer = null;
$("find-input").addEventListener("input", (e) => { clearTimeout(findTimer); findTimer = setTimeout(() => find(e.target.value), 180); });
$("find").addEventListener("submit", (e) => { e.preventDefault(); find($("find-input").value); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && H) refresh(); });

// the countdown and "posted … ago" tick every second without touching the network
setInterval(() => { if (H) { renderClock(); renderStatus(); } }, 1000);

// ---------------------------------------------------------------------------------------------

(async function start() {
  try {
    const [hist] = await Promise.all([loadHistory(), loadVerifier()]);
    H = hist;
    render();
    await refresh();
  } catch (e) {
    $("status-dot").className = "dot bad";
    $("status-text").textContent = `Could not load the board: ${e.message}`;
  }
})();
