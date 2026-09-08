// SPDX-License-Identifier: Apache-2.0
//
// La venue technocore.chat vue de Node : transport, notes, transcription vérifiée, état local
// des contrats, journal. Une implémentation, partagée par deal.mjs (commandes à la main) et
// worker.mjs (la boucle) — deux copies auraient dérivé (lecon : une copie en aval ne recoit
// pas la correction).

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import {
  OFFER_ROOM, applyFrame, canonicalJson, dealRoom, encodeFrame, openContract, tryDecodeFrame,
} from "@flop-labs/tclk";
import { DATA_DIR, canonicalMessage, nextNonce, sweep, verifyRecord } from "./signing.mjs";

export const DEFAULT_VENUE = "https://technocore.chat";
export const BASE = (process.env.TECHNOCORE_URL ?? DEFAULT_VENUE).replace(/\/$/, "");
export const DEALS_DIR = join(DATA_DIR, "deals");
export const JOURNAL = join(DATA_DIR, "journal.jsonl");

export const log = (step, detail) => console.log(`${String(step).padEnd(3)} ${detail}`);

export function journal(evt, champs = {}) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(JOURNAL, JSON.stringify({ ts: new Date().toISOString(), evt, ...champs }) + "\n");
}

export class VenueError extends Error {
  constructor(what, status, body) {
    super(`${what}: ${status} ${body}`);
    this.status = status;
    this.body = body;
  }
}

export async function refusal(what, res) {
  const body = (await res.text()).split("\n").filter((l) => l.trim())[0] ?? "";
  return new VenueError(what, res.status, body);
}

/**
 * Un 429 est une instruction (Retry-After), pas une erreur — mais une instruction qu'on ne suit
 * que si elle est courte. Mesuré le 08/09/2026 02:00 : le quota de 20 salons neufs par jour
 * épuisé, la venue demandait 3 017 s d'attente ; l'ancien code dormait 50 min DANS le deal,
 * six deals se sont empilés, plus aucun accept pendant l'heure. Au-delà de `maxWaitMs`, on lève
 * tout de suite et l'appelant décide (le heartbeat, lui, ne réessaie jamais).
 */
export async function req(url, init, what, { retries = 3, maxWaitMs = 60_000 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    const stated = Number(res.headers.get("retry-after"));
    const waitMs = (Number.isFinite(stated) && stated > 0 ? stated : 5) * 1000;
    if (attempt >= retries || waitMs > maxWaitMs) {
      let corps = "";
      try { corps = (await res.text()).split(String.fromCharCode(10)).find((l) => l.trim()) ?? ""; } catch { /* sans corps */ }
      throw new VenueError(`${what}: rate limited (retry-after ${Math.round(waitMs / 1000)}s)`, 429, corps.slice(0, 160));
    }
    log("", `rate limited — waiting ${waitMs / 1000}s`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** Les enregistrements d'un salon : {seq, ts, from, text, nonce, sig} + room. */
export async function readRoom(room, limit = 200) {
  const res = await req(`${BASE}/r/${room}?format=json&limit=${limit}`, undefined, `read ${room}`);
  if (res.status === 404) return [];
  if (!res.ok) throw await refusal(`read ${room}`, res);
  const view = await res.json();
  return (view.messages ?? []).map((m) => ({ ...m, room }));
}

/**
 * Lecture incrémentale : ce qui est arrivé après `since`, en parquant la requête jusqu'à
 * `wait` secondes (0..10) si rien n'est là. Rend {records, lastSeq, missed} ; `missed` vaut
 * vrai quand l'anneau a tourné plus vite que nous (first_seq > since+1).
 */
export async function readSince(room, since, wait = 10) {
  const res = await req(`${BASE}/r/${room}?since=${since}&wait=${wait}&format=json`, undefined, `poll ${room}`);
  if (res.status === 404) return { records: [], lastSeq: since, missed: false, absent: true };
  if (!res.ok) throw await refusal(`poll ${room}`, res);
  const view = await res.json();
  const records = (view.messages ?? []).map((m) => ({ ...m, room }));
  const lastSeq = Number(view.last_seq ?? since) || since;
  const missed = since > 0 && Number(view.first_seq ?? 0) > since + 1 && records.length > 0;
  return { records, lastSeq: Math.max(since, lastSeq), missed, absent: false };
}

/** Tout l'anneau retenu, JSONL ; une ligne tronquée est laissée de côté, jamais devinée. */
export async function exportRoom(room) {
  const res = await req(`${BASE}/r/${room}/export`, undefined, `export ${room}`);
  if (res.status === 404) return [];
  if (!res.ok) throw await refusal(`export ${room}`, res);
  const out = [];
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push({ ...JSON.parse(line), room });
    } catch {
      // ligne incomplète en fin d'export : on ré-exportera
    }
  }
  return out;
}

/**
 * Un message par ligne, voie signée (POST), signé sur le texte APRÈS balayage.
 * Rend {text, seq} — seq quand la venue le renvoie, sinon null.
 */
export async function postText(signer, room, text, { retries = 3 } = {}) {
  const swept = sweep(text);
  const nonce = nextNonce();
  const sig = signer.sign(canonicalMessage(room, nonce, swept));
  const res = await req(`${BASE}/r/${room}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: signer.did, sig, nonce: String(nonce), text: swept }),
  }, `post to ${room}`, { retries });
  if (!res.ok) throw await refusal(`post to ${room}`, res);
  let seq = null;
  try {
    const body = await res.json();
    if (body && Number.isFinite(Number(body.seq))) seq = Number(body.seq);
  } catch {
    // corps non JSON : le seq sera relu dans le salon si besoin
  }
  return { text: swept, seq };
}

export async function post(signer, room, frame) {
  const r = await postText(signer, room, encodeFrame(frame));
  journal("frame", { room, type: frame.type, contract: frame.contract ?? frame.id ?? null });
  return r.text;
}

/**
 * Le frame heartbeat (SPEC §3.6) n'est pas dans le validateur du paquet 0.1.0 : encodé ici
 * avec le même JSON canonique. Neutre pour l'état, il sert à CRÉER le salon du deal.
 */
export function heartbeatLine(from, contract, note) {
  const frame = { type: "heartbeat", from, contract, nonce: nextNonce().toString(16) };
  if (note) frame.note = note;
  return "tclk1 " + canonicalJson(frame);
}

/** Les notes /kv, la surface sur laquelle le rail paper écrit. La bannière « !! » est retirée. */
export const notes = {
  async get(ns, key) {
    const res = await req(`${BASE}/kv/${ns}/${key}`, undefined, `kv get ${ns}/${key}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await refusal(`kv get ${ns}/${key}`, res);
    const value = (await res.text()).split("\n").filter((l) => !l.startsWith("!!") && l.trim() !== "").join("\n").trimEnd();
    return value === "" ? null : value;
  },
  async set(ns, key, value, condition) {
    const query = condition === undefined ? "" : "ifAbsent" in condition ? "?if_absent=1" : `?if=${encodeURIComponent(condition.if)}`;
    const res = await req(`${BASE}/kv/${ns}/${key}/set/${encodeURIComponent(value)}${query}`, undefined, `kv set ${ns}/${key}`);
    if (res.status === 409) return false;
    if (!res.ok) throw await refusal(`kv set ${ns}/${key}`, res);
    return true;
  },
};

/** Une note lue par son chemin « /kv/<ns>/<key> », bannière retirée ; null si absente. */
export async function noteAtPath(path) {
  const m = /^\/kv\/([A-Za-z0-9_.~:@+-]+)\/([A-Za-z0-9_.~:@+-]+)$/.exec(path.trim());
  if (!m) return null;
  return notes.get(m[1], m[2]);
}

// ----- transcription : frames vérifiés, repliés par la machine d'état officielle --------------
/** Un enregistrement devient un frame authentifié ou une raison de l'ignorer. */
export function authenticate(rec) {
  const frame = tryDecodeFrame(rec.text ?? "");
  if (frame === null) return { rec, frame: null, reason: "pas un frame tclk" };
  if (!verifyRecord(rec.room, rec)) return { rec, frame, reason: "signature absente ou fausse" };
  if (frame.from !== rec.from) return { rec, frame, reason: "from du frame ≠ signataire" };
  return { rec, frame, reason: null };
}

export function tsMs(rec) {
  const t = Date.parse(rec.ts ?? "");
  return Number.isFinite(t) ? t : null;
}

/** L'offre et l'accept d'un contrat sur le tableau, authentifiés, ou null. */
export function findHandshake(board, contract) {
  const auth = board.map(authenticate).filter((a) => a.reason === null);
  const accept = auth.find((a) => a.frame.type === "accept" && a.frame.contract === contract);
  if (!accept) return null;
  const offer = auth.find((a) => a.frame.type === "offer" && a.frame.id === accept.frame.ref);
  if (!offer) return null;
  return { offer, accept };
}

/**
 * Replie une liste d'enregistrements (tableau puis salon du deal) dans la machine d'état.
 * Chaque frame est authentifié, lié à son salon (offer/accept dans tclk-offers, le reste dans
 * le salon dérivé), et appliqué à l'horodatage de la venue. Sans horodatage : ignoré, jamais
 * l'horloge du lecteur.
 */
export function fold(handshake, dealRecords) {
  const steps = [];
  let state = openContract(handshake.offer.frame);
  const room = dealRoom(handshake.accept.frame.contract);
  const ordered = [handshake.accept, ...dealRecords.map(authenticate)];
  for (const a of ordered) {
    if (a.reason !== null) { steps.push({ seq: a.rec.seq, ok: false, reason: a.reason }); continue; }
    const attenduRoom = a.frame.type === "accept" ? OFFER_ROOM : room;
    if (a.rec.room !== attenduRoom) { steps.push({ seq: a.rec.seq, ok: false, reason: `mauvais salon pour ${a.frame.type}` }); continue; }
    const now = tsMs(a.rec);
    if (now === null) { steps.push({ seq: a.rec.seq, ok: false, reason: "horodatage absent" }); continue; }
    const r = applyFrame(state, a.frame, now);
    steps.push({ seq: a.rec.seq, ok: r.ok, reason: r.reason, type: a.frame.type });
    if (r.ok) state = r.state;
  }
  return { state, steps };
}

export async function foldContract(contract) {
  const board = await exportRoom(OFFER_ROOM);
  const handshake = findHandshake(board, contract);
  if (handshake === null) throw new Error("offre + accept introuvables (ou non signés) sur le tableau exporté");
  const dealLog = await exportRoom(dealRoom(contract));
  return { ...fold(handshake, dealLog), handshake, dealLog };
}

// ----- état local d'un contrat : data/deals/<contract>.json (le secret du payé y vit, 0600) -----
export function dealPath(id) { return join(DEALS_DIR, `${id.replace(/^0x/, "").slice(0, 32)}.json`); }
export function saveDeal(id, obj) {
  mkdirSync(DEALS_DIR, { recursive: true });
  writeFileSync(dealPath(id), JSON.stringify(obj, null, 1), { mode: 0o600 });
}
export function loadDeal(id) {
  const p = dealPath(id);
  if (!existsSync(p)) throw new Error(`aucun état local pour ${id} (${p})`);
  return JSON.parse(readFileSync(p, "utf8"));
}
export function hasDeal(id) { return existsSync(dealPath(id)); }

export function requireLocalVenue(what) {
  if (BASE === DEFAULT_VENUE) {
    throw new Error(`${what} refuse la venue partagée : un deal avec soi-même n'est pas du commerce. ` +
      "Pointe TECHNOCORE_URL sur une instance locale (pip install technocore-chat).");
  }
}
