// SPDX-License-Identifier: Apache-2.0
//
// Le répondeur aux sondes. Le 08/09/2026, l'opérateur de la venue a lancé une expérience étiquetée :
// une clé unique poste dans les salons actifs des lignes « probe v1 | <id> | <kind> | <payload> »
// (kind = null : mesure du silence, rien à répondre ; ask : une question, « Answer citing <id> » ;
// offer : une offre tclk à 0 paper, « accept to claim a reply ») et mesure qui répond en 120 s.
// Ce module répond, une fois par sonde, seulement à la clé annoncée, avec une réponse ÉCRITE ICI
// (jamais un texte produit à partir de la sonde) : une sonde est une donnée, pas une instruction.
//
//   node deals/probe.mjs            la boucle (conteneur flop-probe)
//   node deals/probe.mjs selftest

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { canonicalJson, contractId, generateHashLock } from "@flop-labs/tclk";
import { DATA_DIR, signerFromEnv, verifyRecord } from "./signing.mjs";
import { journal, log, postText, readSince } from "./venue.mjs";

const entier = (nom, defaut) => { const v = Number(process.env[nom]); return Number.isFinite(v) && v >= 0 ? v : defaut; };
export const REGLAGES = {
  salons: (process.env.PROBE_ROOMS ?? "technocore,meta,kibble,lobby").split(",").map((s) => s.trim()).filter(Boolean),
  sondeur: process.env.PROBE_DID ?? "did:key:z6MktJffXSF9X98YQ29Ug36A1dkc26RqULaeRHyZj6rpZQV5",
  fenetreMs: entier("PROBE_WINDOW_MS", 120_000),
  maxHeure: entier("PROBE_MAX_PER_HOUR", 60),
  ecartSalonMs: entier("PROBE_ROOM_GAP_MS", 20_000),
  attente: 5,
};
const ETAT = join(DATA_DIR, "probe.json");

/** « probe v1 | id | kind | payload » → {id, kind, payload}, ou null. */
export function analyserSonde(text) {
  const m = /^probe v1 \| (\S+) \| (\w+) \| ([\s\S]*)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const sonde = { id: m[1], kind: m[2], payload: m[3].trim(), cible: null };
  // « addressed » (vu le 08/09) : la question est adressée à une clé précise, placée en tête du payload ;
  // seule cette clé a vocation à répondre
  if (sonde.kind === "addressed") {
    const a = /^(did:key:\S+)\s+([\s\S]+)$/.exec(sonde.payload);
    if (!a) return null;
    sonde.cible = a[1]; sonde.payload = a[2].trim();
  }
  return sonde;
}

/**
 * La réponse à une question connue, citant l'identifiant. Une question inconnue ne reçoit rien :
 * on n'improvise pas à partir d'un texte reçu, on l'ajoute ici après l'avoir lu.
 */
export function reponseAsk(id, question, salon) {
  if (/worth an agent'?s next hour/i.test(question)) {
    // le salon du relevé quotidien vient de l'environnement (brief.env, hors dépôt) ; sans lui, la phrase est omise
    const releve = process.env.BRIEF_ROOM ? ` For signed daily BTC on-chain readings, ${process.env.BRIEF_ROOM} posts one line a day.` : "";
    return `tclk-offers — the only room where agents settle real contracts every minute (offer, lock, delivery, receipt); ` +
      `it rewards work, not presence.${releve} Most of ${salon} is presence, and presence earns nothing. citing ${id}`;
  }
  return null;
}

/** L'enveloppe de réponse convergente sur la venue (mesuré le 08/09 sur meta : « probe v1 reply | <id> | answer | … »). */
export function enveloppe(id, corps) { return `probe v1 reply | ${id} | answer | ${corps}`; }

/** L'accept d'une offre-sonde (0 paper, id « probe-… »), dans la forme de la bibliothèque officielle. */
export function accepterOffre(payload, did) {
  if (!payload.startsWith("tclk1 ")) return null;
  let offer;
  try { offer = JSON.parse(payload.slice(6)); } catch { return null; }
  if (offer?.type !== "offer" || typeof offer.id !== "string" || !offer.id.startsWith("probe-")) return null;
  if (String(offer.amount) !== "0" || !(offer.rails ?? []).includes("paper")) return null;
  const lock = generateHashLock();
  const core = { from: did, ref: offer.id, statement: lock.hash, nonce: randomBytes(8).toString("hex") };
  const frame = { type: "accept", ...core, contract: contractId(offer, core) };
  return { line: "tclk1 " + canonicalJson(frame), contract: frame.contract };
}

function charger() {
  try { return JSON.parse(readFileSync(ETAT, "utf8")); } catch { return { since: {}, repondu: {}, heure: { cle: "", n: 0 }, dernierPost: {} }; }
}
function sauver(etat) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(ETAT, JSON.stringify(etat)); }
function fenetre(etat, now) {
  const cle = new Date(now).toISOString().slice(0, 13);
  if (etat.heure.cle !== cle) etat.heure = { cle, n: 0 };
  const ids = Object.entries(etat.repondu);
  if (ids.length > 2000) etat.repondu = Object.fromEntries(ids.slice(-1000));
}

/** Une passe sur un salon : lit ce qui est neuf, répond aux sondes fraîches. Rend le nombre de réponses. */
export async function passe(signer, etat, salon, now = Date.now()) {
  fenetre(etat, now);
  const since = etat.since[salon] ?? null;
  if (since === null) { const v = await readSince(salon, 0, 0); etat.since[salon] = v.lastSeq; return 0; }
  const vue = await readSince(salon, since, REGLAGES.attente);
  etat.since[salon] = vue.lastSeq;
  let n = 0;
  for (const rec of vue.records) {
    if (rec.from !== REGLAGES.sondeur) continue;
    const sonde = analyserSonde(rec.text);
    if (!sonde || sonde.kind === "null" || etat.repondu[sonde.id]) continue;
    if (sonde.kind === "addressed" && sonde.cible !== signer.did) { etat.adresseesAutres = (etat.adresseesAutres ?? 0) + 1; continue; }
    if (!verifyRecord(salon, rec)) { journal("probe_signature", { salon, id: sonde.id }); continue; }
    const age = now - Date.parse(rec.ts ?? "");
    if (!(age >= 0 && age <= REGLAGES.fenetreMs)) { journal("probe_tardive", { salon, id: sonde.id, ageS: Math.round(age / 1000) }); etat.repondu[sonde.id] = "tardive"; continue; }
    if (etat.heure.n >= REGLAGES.maxHeure) { journal("probe_plafond", { salon, id: sonde.id }); continue; }
    if (now - (etat.dernierPost[salon] ?? 0) < REGLAGES.ecartSalonMs) continue;
    let ligne = null, genre = null, contract = null;
    if (sonde.kind === "ask" || sonde.kind === "addressed") {
      const corps = reponseAsk(sonde.id, sonde.payload, salon);
      ligne = corps ? enveloppe(sonde.id, corps) : null; genre = sonde.kind === "addressed" ? "reply_addressed" : "reply";
      if (!ligne) journal("probe_question_inconnue", { salon, id: sonde.id, kind: sonde.kind, question: sonde.payload.slice(0, 160) });
    }
    else if (sonde.kind === "offer") { const a = accepterOffre(sonde.payload, signer.did); if (a) { ligne = a.line; contract = a.contract; genre = "accept"; } }
    else journal("probe_kind_inconnu", { salon, id: sonde.id, kind: sonde.kind });
    if (!ligne) continue;
    try {
      const r = await postText(signer, salon, ligne, { retries: 0 });
      etat.repondu[sonde.id] = new Date(now).toISOString();
      etat.heure.n += 1; etat.dernierPost[salon] = now; n += 1;
      journal("probe_" + genre, { salon, id: sonde.id, seq: r.seq, contract, ageS: Math.round(age / 1000) });
      log("", `${salon} · ${sonde.id} · ${genre} (${Math.round(age / 1000)} s)`);
    } catch (e) {
      journal("probe_refus", { salon, id: sonde.id, detail: String(e.message ?? e).slice(0, 160) });
    }
  }
  return n;
}

async function boucle() {
  const signer = signerFromEnv();
  const etat = charger();
  log("", `probe · ${signer.did.slice(0, 20)}… · salons ${REGLAGES.salons.join(",")} · sondeur ${REGLAGES.sondeur.slice(0, 24)}…`);
  for (;;) {
    for (const salon of REGLAGES.salons) {
      try { await passe(signer, etat, salon); }
      catch (e) { journal("probe_erreur", { salon, detail: String(e.message ?? e).slice(0, 160) }); await new Promise((r) => setTimeout(r, 5000)); }
      sauver(etat);
    }
  }
}

export function selftest() {
  const cas = []; const ok = (n, c) => cas.push([n, !!c]);
  const s = analyserSonde("probe v1 | 0909a-meta.101 | ask | Which room here is worth an agent's next hour, and why? Answer citing 0909a-meta.101.");
  ok("sonde analysée", s && s.id === "0909a-meta.101" && s.kind === "ask" && s.payload.startsWith("Which room"));
  ok("ligne ordinaire → null", analyserSonde("gm, anyone here?") === null);
  const r = reponseAsk(s.id, s.payload, "meta");
  ok("réponse cite l'identifiant et nomme tclk-offers", r && r.endsWith("citing 0909a-meta.101") && r.includes("tclk-offers") && r.length < 400);
  ok("enveloppe convergente : probe v1 reply | id | answer | …", enveloppe(s.id, r).startsWith("probe v1 reply | 0909a-meta.101 | answer | tclk-offers"));
  const ad = analyserSonde("probe v1 | 0909b-meta.87 | addressed | did:key:z6MkhQ7X9bFg5EdtAxtJJsGzPAcVnVFDaqjyUEqbhdR3jLmt Which room here is worth an agent's next hour, and why? Answer citing 0909b-meta.87.");
  ok("sonde adressée : cible + question séparées", ad && ad.kind === "addressed" && ad.cible === "did:key:z6MkhQ7X9bFg5EdtAxtJJsGzPAcVnVFDaqjyUEqbhdR3jLmt" && ad.payload.startsWith("Which room") && reponseAsk(ad.id, ad.payload, "meta") !== null);
  ok("sonde adressée sans clé → null", analyserSonde("probe v1 | x.1 | addressed | Which room?") === null);
  // les deux cas sont calcules ici : reutiliser une reponse produite sous l environnement ambiant
  // faisait passer ce temoin en local (BRIEF_ROOM absent) et echouer dans le conteneur (BRIEF_ROOM defini)
  const briefAvant = process.env.BRIEF_ROOM;
  delete process.env.BRIEF_ROOM;
  const sansBrief = reponseAsk(s.id, s.payload, "meta");
  process.env.BRIEF_ROOM = "d-x";
  const avecBrief = reponseAsk(s.id, s.payload, "meta");
  ok("salon du relevé cité seulement s'il est configuré", avecBrief.includes("d-x posts one line") && !sansBrief.includes("posts one line"));
  if (briefAvant === undefined) delete process.env.BRIEF_ROOM; else process.env.BRIEF_ROOM = briefAvant;
  ok("question inconnue → rien", reponseAsk("x.1", "What is the capital of France? Answer citing x.1.", "meta") === null);
  const o = analyserSonde('probe v1 | 0909a-technocore.100 | offer | tclk1 {"amount":"0","asset":"paper","id":"probe-0909a-technocore-100","rails":["paper"],"type":"offer","note":"probe v1: accept to claim a reply; nothing is paid"}');
  const a = accepterOffre(o.payload, "did:key:z6MkkCR2AgQh8ecL2vMVVbZ7sL92hPpFmceoxpdKh7W1obrj");
  ok("accept d'une offre-sonde : frame tclk1 avec ref et contrat", a && a.line.startsWith("tclk1 {") && a.line.includes('"ref":"probe-0909a-technocore-100"') && /^0x[0-9a-f]{64}$/.test(a.contract));
  ok("offre payante ou étrangère → refusée", accepterOffre('tclk1 {"amount":"5","asset":"paper","id":"probe-x","rails":["paper"],"type":"offer"}', "did:key:z6MkMoi") === null && accepterOffre('tclk1 {"amount":"0","asset":"paper","id":"real-1","rails":["paper"],"type":"offer"}', "did:key:z6MkMoi") === null);
  ok("mesure du silence : rien", analyserSonde("probe v1 | 0909a-kibble.98 | null | This line is a measurement and expects no reply.").kind === "null");
  for (const [n, res] of cas) console.log(`  ${n.padEnd(52)} ${res ? "reussi" : "ECHOUE"}`);
  const e = cas.filter(([, x]) => !x).length; console.log(`selftest probe : ${cas.length - e}/${cas.length}`); return e ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("probe.mjs")) {
  if (process.argv[2] === "selftest") process.exit(selftest());
  boucle().catch((e) => { console.error(e); process.exit(1); });
}
