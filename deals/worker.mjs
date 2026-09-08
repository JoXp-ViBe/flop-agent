#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// La boucle de travail : lire le tableau tclk-offers en continu, accepter les tâches que nos
// solveurs savent résoudre, ouvrir le salon du deal, attendre le verrou du payeur, livrer une
// ligne, révéler, noter le verdict. Un contrat réel avec une contrepartie réelle, à chaque fois,
// et rien d'autre (README : « true agentic commerce », pas « gm 5000 fois »).
//
// Mesuré le 07/09/2026 : ~100 offres/min sur le tableau, le payeur verrouille le PREMIER
// acceptant dans 95 % des cas, une mauvaise réponse coûte −5 dans le classement blockrewards.
// D'où : long-poll (retour en 0,6 s), décision sans réseau quand l'aperçu suffit, et un solveur
// qui rend null plutôt que de deviner.
//
// Garde-fous : plafonds par heure, par jour et par posteur (le programme ne compte que 20 deals
// par paire posteur→travailleur et par jour) ; jamais plus de MAX_ACTIFS deals en vol ;
// WORKER_DRY_RUN=1 observe et journalise sans rien écrire sur la venue.
//
//   node worker.mjs            la boucle (conteneur)
//   node worker.mjs selftest   filtres et compteurs, sans réseau ni graine
//   node worker.mjs bilan      les compteurs du jour et les derniers deals

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

import { OFFER_ROOM, PaperRail, dealRoom, generateHashLock, makeAccept } from "@flop-labs/tclk";
import { DATA_DIR, signerFromEnv } from "./signing.mjs";
import {
  BASE, journal, log, readSince, postText, post, notes, authenticate, heartbeatLine, noteAtPath, saveDeal,
} from "./venue.mjs";
import { parseSpec, solveMath, planAttest, planProtocol } from "./solvers.mjs";
import { analyserDocs, planDocs, traiterFile as traiterFileDocs, etatDocs } from "./docs.mjs";
import { parseTable, repondreTable, gabaritConnu, noteMatiere } from "./tables.mjs";
import { analyserValidation, jugerValidation, budgetValidation } from "./validation.mjs";

const entier = (nom, defaut) => { const v = Number(process.env[nom]); return Number.isFinite(v) && v >= 0 ? v : defaut; };
export const REGLAGES = {
  dry: /^(1|true|oui)$/i.test(process.env.WORKER_DRY_RUN ?? ""),
  familles: new Set((process.env.WORKER_FAMILIES ?? "math,attest,protocol,docs,tables,validation").split(",").map((s) => s.trim()).filter(Boolean)),
  maxHeure: entier("WORKER_MAX_PER_HOUR", 40),
  maxJour: entier("WORKER_MAX_PER_DAY", 240),
  maxPosteurJour: entier("WORKER_MAX_PER_POSTER_DAY", 20),
  maxActifs: entier("WORKER_MAX_ACTIVE", 6),
  attenteLockMs: entier("WORKER_LOCK_WAIT_S", 360) * 1000,
  attenteVerdictMs: entier("WORKER_VERDICT_WAIT_S", 240) * 1000,
  // cadence : le plafond horaire se lisse sur l'heure au lieu d'être consommé en trois minutes
  // (mesuré le 08/09 : 40 accepts entre 00:30 et 00:33, puis rien jusqu'à 01:00)
  ecartMs: entier("WORKER_MIN_GAP_S", 0) * 1000,
  // le budget de création de salons de la venue est par IP et par heure glissante (mesuré le 08/09 : 328 salons
  // ouverts dans la journée, refus « room-creation budget spent » avec retry-after ≈ 27 min) ; le payeur, même IP,
  // a besoin d'un salon par offre : le worker en laisse quelques-uns
  maxSalonsHeure: entier("WORKER_ROOMS_PER_HOUR", 17),
};
if (!REGLAGES.ecartMs && REGLAGES.maxHeure > 0) REGLAGES.ecartMs = Math.floor(3600_000 / REGLAGES.maxHeure);
const ETAT = join(DATA_DIR, "worker.json");
const SUSPENSIONS = join(DATA_DIR, "suspensions.json");   // { "familles": ["verification", …] } — écrit par le veilleur de santé (hôte) quand une famille échoue trop
let suspCache = { ts: 0, familles: new Set() };

// Salons neufs refusés par la venue (429 room-creation avec Retry-After ≈ 1 h, ou 400 « room limit reached »,
// plafond global) : mesuré le 08/09 09:00-10:15, 9 tâches attest acceptées puis annulées faute de salon
// (l'attestation DOIT être postée dans le salon du deal). Tant que le blocage court, on n'accepte pas d'attest.
export let salonsBloquesJusqua = 0;
export function noterRefusSalon(detail, now = Date.now()) {
  const d = String(detail ?? "");
  let secondes = 0;
  const m = /retry-after (\d+)s/.exec(d);
  if (m && /room/i.test(d)) secondes = Number(m[1]);
  else if (/room limit reached/i.test(d)) secondes = 900;
  if (!secondes) return false;
  const jusqua = now + Math.min(secondes, 4 * 3600) * 1000;
  if (jusqua > salonsBloquesJusqua) { salonsBloquesJusqua = jusqua; journal("salons_bloques", { jusqua: new Date(jusqua).toISOString(), secondes }); }
  return true;
}
/** Reste-t-il de la place dans notre part du budget horaire de salons ? (heure glissante) */
export function peutOuvrirSalon(etat, now = Date.now(), max = REGLAGES.maxSalonsHeure) {
  etat.salonsOuverts = (etat.salonsOuverts ?? []).filter((t) => now - t < 3600_000);
  return etat.salonsOuverts.length < max;
}

export function suspendue(famille) {
  if (Date.now() - suspCache.ts > 60_000) {
    suspCache = { ts: Date.now(), familles: new Set() };
    try { suspCache.familles = new Set(JSON.parse(readFileSync(SUSPENSIONS, "utf8")).familles ?? []); } catch { /* aucun fichier : rien de suspendu */ }
  }
  return suspCache.familles.has(famille);
}

// ----- état persistant : curseur, compteurs, derniers deals ----------------------------------
function etatVierge() {
  return { since: 0, jour: { date: "", accepts: 0, parPosteur: {} }, heure: { cle: "", accepts: 0 },
    stats: { offres: 0, candidats: 0, acceptes: 0, verrouilles: 0, livres: 0, reveles: 0, pass: 0, fail: 0, sans_lock: 0 }, derniers: [] };
}
export function chargerEtat() {
  try { return { ...etatVierge(), ...JSON.parse(readFileSync(ETAT, "utf8")) }; } catch { return etatVierge(); }
}
export function sauverEtat(etat) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ETAT + ".tmp", JSON.stringify(etat));
  renameSync(ETAT + ".tmp", ETAT);
}
export function fenetres(etat, now = Date.now()) {
  const d = new Date(now).toISOString();
  const date = d.slice(0, 10), heure = d.slice(0, 13);
  if (etat.jour.date !== date) etat.jour = { date, accepts: 0, parPosteur: {} };
  if (etat.heure.cle !== heure) etat.heure = { cle: heure, accepts: 0 };
}

// ----- filtre d'une offre : une raison de la laisser, ou null ---------------------------------
export function filtrer(offer, { me, now, acceptesVus, etat, reglages = REGLAGES, actifs = 0 }) {
  if (offer.type !== "offer") return "pas une offre";
  if (offer.from === me) return "notre propre offre";
  if (offer.role !== "payer") return "le posteur n'est pas payeur";
  if (offer.lock !== "hash") return "verrou non hash";
  if (!(offer.rails ?? []).includes("paper")) return "rail paper absent";
  if (!(Number(offer.expiresMs) > now + 3000)) return "offre expirée ou presque";
  if (!(Number(offer.claimByMs) > now + 60000)) return "claimBy trop proche";
  if (typeof offer.job?.context !== "string" || !offer.job.context) return "sans job.context";
  if (acceptesVus.has(offer.id)) return "déjà acceptée par un autre";
  fenetres(etat, now);
  if (etat.heure.accepts >= reglages.maxHeure) return "plafond horaire";
  if (etat.jour.accepts >= reglages.maxJour) return "plafond journalier";
  if ((etat.jour.parPosteur[offer.from] ?? 0) >= reglages.maxPosteurJour) return "plafond posteur";
  if (actifs >= reglages.maxActifs) return "trop de deals en vol";
  if (reglages.ecartMs && etat.dernierAccept && now - etat.dernierAccept < reglages.ecartMs) return "cadence";
  return null;
}

// ----- la spec : aperçu du tableau ou note complète -------------------------------------------
const cacheNotes = new Map();
async function lireSpec(offer) {
  const ctx = offer.job.context.trim();
  let texte = ctx;
  let chemin = ctx.startsWith("/kv/") ? ctx : (parseSpec(ctx)?.fullSpec ?? null);
  if (chemin) {
    if (cacheNotes.has(chemin)) texte = cacheNotes.get(chemin);
    else {
      const note = await noteAtPath(chemin);
      if (note) { texte = note; cacheNotes.set(chemin, note); if (cacheNotes.size > 500) cacheNotes.delete(cacheNotes.keys().next().value); }
      else if (ctx.startsWith("/kv/")) return null;
    }
  }
  return parseSpec(texte);
}

/** Ce qu'on saurait livrer pour cette spec, ou null. Aucun réseau ici sauf pour attest/protocol plus tard. */
export function planifier(spec, signer) {
  if (!spec || suspendue(spec.family)) return null;
  // « From <url>: question » se présente sous des étiquettes variées (extraction, review, protocol…) :
  // c'est la forme de l'ask qui décide, jamais l'étiquette ; jamais pour une tâche de validation
  if (spec.family !== "validation" && REGLAGES.familles.has("docs") && !suspendue("docs") && analyserDocs(spec.ask)) return planDocs(spec);
  if (!REGLAGES.familles.has(spec.family)) return null;
  if (spec.family === "math") { const r = solveMath(spec.ask); return r === null ? null : { genre: "math", reponse: r }; }
  if (spec.family === "attest") { if (Date.now() < salonsBloquesJusqua) return null; return planAttest(spec.ask, "0x", spec.done) ? { genre: "attest" } : null; }
  if (spec.family === "protocol") { const p = planProtocol(spec.ask, { base: BASE, signer }); return p ? { genre: "protocol", executer: p } : null; }
  return null;
}

/** Les tâches de table (inference, census, verification) : la matière est inline ou dans une note. */
export async function planTables(spec) {
  if (!spec || !REGLAGES.familles.has("tables")) return null;
  // « verification » suspendue le 08/09/2026 : 3 réponses sur 3 justes d'après la matière (recomptées
  // indépendamment) mais jugées FAIL par un juge LLM aux motifs incohérents ; −5 chacune. WORKER_VERIFICATION=1 pour rouvrir.
  // « verification » avait 3 FAIL sur 3 le 08/09 : les trois matières faisaient 8 000 caractères — la venue
  // coupe les notes à 8 192, la référence du posteur porte sur l'extrait ENTIER. Rouverte derrière le garde
  // de troncature ci-dessous (WORKER_VERIFICATION=0 pour la refermer) ; le veilleur de santé la suspend si elle échoue.
  const familles = process.env.WORKER_VERIFICATION === "0" ? ["inference", "census"] : ["inference", "census", "verification"];
  if (!familles.includes(spec.family) || suspendue(spec.family) || !gabaritConnu(spec.ask)) return null;
  let texte = spec.material || "";
  const chemin = noteMatiere(spec.ask);
  if (!texte && chemin) texte = (await noteAtPath(chemin)) ?? "";
  // matière tronquée par le plafond de 8 192 caractères d'une note : on ne répond pas sur une table amputée
  // seuil abaissé à 7 000 le 08/09 08:20 : un extrait de 297 seq tenait en 90 lignes (~7 650 car.) et la
  // référence portait sur l'extrait entier (« offers=90 » jugé faux) ; 80 lignes ≈ 7 000 caractères
  if (texte.length >= 7000 || (spec.raw ?? "").length >= 7000) { journal("table_tronquee", { family: spec.family, longueur: texte.length }); return null; }
  const table = parseTable(texte);
  if (!table) return null;
  if (tableTronquee(spec.ask, table)) { journal("table_tronquee", { family: spec.family, longueur: texte.length, dernierSeq: table.rows[table.rows.length - 1]?.seq ?? null }); return null; }
  const reponse = repondreTable(spec.ask, table);
  return reponse === null ? null : { genre: "tables", reponse };
}

/**
 * L'ask annonce « seq A–B » ; la note, coupée à 8 192 caractères par la venue, peut s'arrêter bien avant B
 * (08/09 09:14 : plage de 925 seq, 90 lignes livrées, jugé faux). La longueur seule ne le voit pas quand les
 * lignes sont courtes : on exige que le dernier seq de la table approche la fin annoncée (marge 50 seq).
 */
export function tableTronquee(ask, table, marge = 50) {
  const plage = /seq\s+(\d+)\s*[–-]\s*(\d+)/.exec(ask ?? "");
  if (!plage || !table?.rows?.length) return false;
  const dernier = Number(table.rows[table.rows.length - 1].seq), fin = Number(plage[2]);
  return Number.isFinite(dernier) && Number.isFinite(fin) && dernier < fin - marge;
}

// ----- validation : jugée par l'oracle en arrière-plan, puis acceptée si le verdict a la bonne forme ---
const fileValidation = [];
let validationEnCours = false;
let pauseValidation = 0;   // le pont a dit « plafond » : on attend l'heure suivante
function proposerValidation(offer, spec) {
  if (!REGLAGES.familles.has("validation") || suspendue("validation") || !analyserValidation(spec.ask) || !budgetValidation()) return;
  if (fileValidation.length >= 3 || fileValidation.some((x) => x.offer.id === offer.id)) return;
  fileValidation.push({ offer, spec });
}
async function traiterValidations(signer, etat, acceptesVus) {
  if (validationEnCours || fileValidation.length === 0) return;
  validationEnCours = true;
  const { offer, spec } = fileValidation.shift();
  try {
    if (Number(offer.expiresMs) < Date.now() + 40_000) return;   // l'oracle prend 15 s : trop tard
    if (Date.now() < pauseValidation) return;
    const plan = await jugerValidation(spec);
    journal("validation_jugee", { offer: offer.id, verdict: plan ? plan.reponse.slice(0, 120) : null, tokens: plan?.tokens ?? null });
    if (!plan || acceptesVus.has(offer.id) || Number(offer.expiresMs) < Date.now() + 5_000) return;
    const raison = filtrer(offer, { me: signer.did, now: Date.now(), acceptesVus, etat, actifs: actifs.size });
    if (raison && raison !== "cadence") return;
    etat.stats.candidats += 1;
    await accepter(offer, spec, plan, signer, etat);
  } catch (e) {
    const detail = String(e.message ?? e).slice(0, 200);
    if (/plafond/.test(detail)) { pauseValidation = Math.ceil(Date.now() / 3600_000) * 3600_000 + 45_000; journal("validation_pause", { jusqua: new Date(pauseValidation).toISOString() }); }
    else journal("validation_error", { offer: offer.id, detail });
  } finally {
    validationEnCours = false;
  }
}

// ----- un deal, de l'accept au verdict --------------------------------------------------------
let attentesEnCours = 0;
async function lireSalon(room, since) {
  // au plus 3 requêtes parquées à la fois (la venue en accorde 4 par IP, une est pour le tableau)
  const parquer = attentesEnCours < 3;
  if (parquer) attentesEnCours += 1;
  try {
    const r = await readSince(room, since, parquer ? 3 : 0);
    if (!parquer) await new Promise((res) => setTimeout(res, 1500));
    return r;
  } finally {
    if (parquer) attentesEnCours -= 1;
  }
}

function framesDuSalon(records, contract) {
  const out = [];
  for (const rec of records) {
    const a = authenticate(rec);
    if (a.reason === null && a.frame.contract === contract) out.push({ frame: a.frame, rec });
  }
  return out;
}

async function trouverSeq(room, signer, texte) {
  const r = await readSince(room, 0, 0);
  const mien = r.records.filter((m) => m.from === signer.did && m.text === texte);
  return mien.length ? Number(mien[mien.length - 1].seq) : null;
}

const actifs = new Map();

async function menerDeal(deal, signer, etat) {
  const { contract, room, offer } = deal;
  const fini = (status, extra = {}) => {
    deal.status = status; Object.assign(deal, extra); deal.finishedAt = Date.now();
    saveDeal(contract, deal);
    etat.derniers = [{ contract, family: deal.family, status, verdict: deal.verdict ?? null, ts: new Date().toISOString() }, ...etat.derniers].slice(0, 30);
    actifs.delete(contract);
  };
  try {
    // 1. le salon du deal existe dès notre heartbeat (ou dès le verrou du payeur si notre IP a épuisé ses salons du jour)
    // jamais de réessai ici : quota de salons épuisé = 429 immédiat, et c'est le payeur qui ouvre le salon
    if (!peutOuvrirSalon(etat)) journal("heartbeat_reserve", { contract, ouverts: etat.salonsOuverts.length });
    else {
      try { await postText(signer, room, heartbeatLine(signer.did, contract), { retries: 0 }); etat.salonsOuverts.push(Date.now()); journal("heartbeat", { contract }); }
      catch (e) { const msg = String(e.message ?? e); journal("heartbeat_refuse", { contract, detail: msg.slice(0, 160) }); noterRefusSalon(msg); }
    }

    // 2. la réponse, calculée maintenant : si elle échoue, on se retire proprement (cancel avant tout verrou)
    let reponse = deal.reponse ?? null;
    try {
      if (deal.genre === "protocol") reponse = await deal.executer();
      if (deal.genre === "attest") {
        const plan = planAttest(deal.ask, contract, deal.done);
        const r = await postText(signer, room, plan.line);
        const seq = r.seq ?? await trouverSeq(room, signer, plan.line);
        if (seq === null) throw new Error("seq de la ligne d'attestation introuvable");
        reponse = plan.deliver(seq);
      }
    } catch (e) {
      journal("solve_error", { contract, detail: String(e.message ?? e).slice(0, 200) });
      try { await post(signer, room, { type: "cancel", from: signer.did, contract, reason: "solver unavailable" }); } catch { /* le salon peut ne pas exister */ }
      return fini("cancelled");
    }
    if (typeof reponse !== "string" || !reponse.trim()) { return fini("cancelled"); }
    deal.reponse = reponse;
    saveDeal(contract, deal);

    // 3. attendre le verrou du payeur, dans le salon (référence) ou sur le tableau (variante vue le 07/09)
    const limite = Math.min(Date.now() + REGLAGES.attenteLockMs, Number(offer.claimByMs) - 60000);
    let since = 0, lockRef = null;
    while (Date.now() < limite && lockRef === null) {
      if (deal.boardLock) { lockRef = deal.boardLock; break; }
      const r = await lireSalon(room, since);
      since = r.lastSeq;
      for (const { frame } of framesDuSalon(r.records, contract)) {
        if (frame.type === "lock" && frame.from === offer.from) lockRef = frame.ref ?? "paper:?";
        if (frame.type === "cancel" && frame.from === offer.from) { journal("cancelled_by_payer", { contract }); return fini("cancelled_by_payer"); }
      }
    }
    if (lockRef === null) { etat.stats.sans_lock += 1; journal("sans_lock", { contract, family: deal.family }); return fini("unlocked"); }
    etat.stats.verrouilles += 1; deal.lockRef = lockRef; deal.lockedAt = Date.now();
    journal("lock_vu", { contract, ref: lockRef });

    // 4. livrer une ligne, puis révéler = réclamer — dans un salon qui EXISTE. Mesuré le 08/09 04:00 :
    // le verrou arrive sur le tableau 1 à 4 s après l'accept, le payeur ouvre le salon juste après ;
    // écrire avant lui, c'est créer le salon nous-mêmes, donc 429 quand notre quota du jour est épuisé
    // (6 deals verrouillés perdus). On attend le salon ; s'il ne vient pas, ce posteur travaille tout
    // sur le tableau et on y livre.
    // la venue répond 200 (vide) sur un salon qui n'existe pas : « pas encore créé » se lit à l'absence
    // de tout enregistrement, jamais à un 404
    let salon = room;
    if (deal.boardLock) {
      const fin = Math.min(Date.now() + 30_000, Number(offer.claimByMs) - 30_000);
      const vide = async () => (await readSince(room, 0, 0)).records.length === 0;
      while (Date.now() < fin && (await vide())) await new Promise((r) => setTimeout(r, 3000));
      if (await vide()) { salon = OFFER_ROOM; journal("livraison_tableau", { contract }); }
    }
    await postText(signer, salon, reponse);
    etat.stats.livres += 1; journal("deliver", { contract, family: deal.family, chars: reponse.length, salon });
    await post(signer, salon, { type: "reveal", from: signer.did, contract, secret: deal.preimage });
    etat.stats.reveles += 1; journal("reveal", { contract });
    try { await new PaperRail(notes).claim(lockRef, deal.preimage); } catch (e) { journal("rail_claim_refuse", { contract, detail: String(e.message ?? e).slice(0, 120) }); }
    deal.status = "revealed"; deal.revealedAt = Date.now(); saveDeal(contract, deal);

    // 5. le reçu et le verdict du payeur, s'ils viennent vite
    const limiteVerdict = Date.now() + REGLAGES.attenteVerdictMs;
    let outcome = null, verdict = null;
    while (Date.now() < limiteVerdict && (outcome === null || verdict === null)) {
      const r = await lireSalon(room, since);
      since = r.lastSeq;
      for (const rec of r.records) {
        if (rec.from !== offer.from) continue;
        const a = authenticate(rec);
        if (a.frame && a.frame.type === "receipt" && a.frame.contract === contract) outcome = a.frame.outcome;
        const m = /\b(PASS|FAIL)\b/.exec(rec.text ?? "");
        if (!a.frame && m && /review|verdict|judge/i.test(rec.text ?? "")) verdict = m[1] + " — " + rec.text.slice(0, 200);
      }
      if (deal.boardReceipt) outcome = deal.boardReceipt;
    }
    if (verdict) { if (verdict.startsWith("PASS")) etat.stats.pass += 1; else etat.stats.fail += 1; }
    journal("verdict", { contract, family: deal.family, outcome, verdict: verdict ?? "non vu" });
    return fini(outcome === "claimed" ? "claimed" : "revealed", { outcome, verdict });
  } catch (e) {
    journal("deal_error", { contract, detail: String(e.message ?? e).slice(0, 200) });
    return fini("error");
  }
}

// ----- accepter ------------------------------------------------------------------------------
async function accepter(offer, spec, plan, signer, etat) {
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: signer.did, statement: lock.hash });
  if (REGLAGES.dry) {
    journal("would_accept", { offer: offer.id, family: spec.family, genre: plan.genre, from: offer.from, ask: spec.ask.slice(0, 160), reponse: plan.reponse ?? null });
    log("", `[dry] accepterait ${offer.id.slice(0, 12)}… ${spec.family} · ${spec.ask.slice(0, 80)}`);
    return;
  }
  await post(signer, OFFER_ROOM, accept);
  const contract = accept.contract;
  const deal = {
    role: "payee", offer, accept, preimage: lock.preimage, statement: lock.hash, room: dealRoom(contract), contract,
    family: spec.family, genre: plan.genre, ask: spec.ask, done: spec.done, reponse: plan.reponse ?? null,
    executer: plan.executer, createdAt: Date.now(), status: "accepted",
  };
  saveDeal(contract, { ...deal, executer: undefined });
  etat.jour.accepts += 1; etat.heure.accepts += 1; etat.jour.parPosteur[offer.from] = (etat.jour.parPosteur[offer.from] ?? 0) + 1;
  etat.dernierAccept = Date.now();
  etat.stats.acceptes += 1;
  journal("accept", { contract, offer: offer.id, family: spec.family, genre: plan.genre, from: offer.from, ask: spec.ask.slice(0, 160) });
  log("", `accepté ${contract.slice(0, 14)}… ${spec.family} · ${spec.ask.slice(0, 70)}`);
  actifs.set(contract, deal);
  menerDeal(deal, signer, etat);
}

// ----- la boucle -----------------------------------------------------------------------------
async function boucle() {
  const signer = signerFromEnv();
  const etat = chargerEtat();
  const acceptesVus = new Set();
  const noter = (id) => { acceptesVus.add(id); if (acceptesVus.size > 5000) acceptesVus.delete(acceptesVus.values().next().value); };
  let arret = false;
  process.on("SIGTERM", () => { arret = true; sauverEtat(etat); });
  process.on("SIGINT", () => { arret = true; sauverEtat(etat); });

  if (!etat.since) {
    const r = await readSince(OFFER_ROOM, 0, 0);
    etat.since = r.lastSeq;
    journal("baseline", { since: etat.since, dry: REGLAGES.dry });
  }
  log("", `worker ${REGLAGES.dry ? "(DRY RUN) " : ""}did ${signer.did.slice(0, 20)}… familles ${[...REGLAGES.familles].join(",")} depuis seq ${etat.since}`);

  while (!arret) {
    try {
      const r = await readSince(OFFER_ROOM, etat.since, 10);
      if (r.missed) journal("board_missed", { since: etat.since });
      const now = Date.now();
      const auth = r.records.map(authenticate).filter((a) => a.reason === null);
      for (const { frame } of auth) {
        if (frame.type === "accept") noter(frame.ref);
        if ((frame.type === "lock" || frame.type === "receipt") && actifs.has(frame.contract)) {
          const d = actifs.get(frame.contract);
          if (frame.type === "lock" && frame.from === d.offer.from) d.boardLock = frame.ref ?? "paper:?";
          if (frame.type === "receipt" && frame.from === d.offer.from) d.boardReceipt = frame.outcome;
        }
      }
      for (const { frame } of auth) {
        if (frame.type !== "offer") continue;
        etat.stats.offres += 1;
        const raison = filtrer(frame, { me: signer.did, now, acceptesVus, etat, actifs: actifs.size });
        if (raison) {
          // plafond atteint : on n'accepte pas, mais on APPREND quand même les questions de documents
          // (mesuré le 08/09 : le plafond horaire coupait aussi la file de l'oracle, qui restait vide)
          const ctx = frame.job?.context ?? "";
          if (/^plafond|^trop de deals|^cadence/.test(raison) && REGLAGES.familles.has("docs") && (ctx.startsWith("/kv/") || /From https?:\/\//.test(ctx))) {
            const spec = await lireSpec(frame);
            if (spec && spec.family !== "validation" && analyserDocs(spec.ask)) planDocs(spec);
          }
          continue;
        }
        const spec = await lireSpec(frame);
        if (spec && spec.family === "validation") { proposerValidation(frame, spec); continue; }
        const plan = planifier(spec, signer) ?? await planTables(spec);
        if (!plan) continue;
        etat.stats.candidats += 1;
        if (acceptesVus.has(frame.id)) continue;   // quelqu'un a accepté pendant qu'on lisait la spec
        await accepter(frame, spec, plan, signer, etat);
      }
      etat.since = r.lastSeq;
      etat.docs = etatDocs();
      sauverEtat(etat);
      if (REGLAGES.familles.has("docs")) traiterFileDocs(etat.stats);   // une question d'oracle à la fois, hors du chemin des offres
      traiterValidations(signer, etat, acceptesVus);                       // idem pour les validations
    } catch (e) {
      journal("boucle_error", { detail: String(e.message ?? e).slice(0, 200) });
      log("", `erreur de boucle : ${String(e.message ?? e).slice(0, 120)}`);
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

// ----- self-test (sans réseau) ----------------------------------------------------------------
function selftest() {
  const cas = [];
  const ok = (nom, cond) => cas.push([nom, !!cond]);
  const now = 1_800_000_000_000;
  const base = { type: "offer", from: "did:key:z6MkAutre", role: "payer", lock: "hash", rails: ["paper"], amount: "200", asset: "FLOP",
    claimByMs: now + 2_000_000, refundAfterMs: now + 4_000_000, expiresMs: now + 1_000_000, id: "0xoffre1", job: { proto: "a2a", id: "t", context: "math | [difficulty 1/3] Compute gcd(4, 6) and lcm(4, 6). | reward tier 2/5 | done looks like: one line: gcd=<g> lcm=<l>." } };
  const ctx = () => ({ me: "did:key:z6MkMoi", now, acceptesVus: new Set(), etat: etatVierge(), actifs: 0 });
  ok("offre valable passe", filtrer(base, ctx()) === null);
  ok("notre offre refusée", filtrer({ ...base, from: "did:key:z6MkMoi" }, ctx()) === "notre propre offre");
  ok("offre expirée refusée", filtrer({ ...base, expiresMs: now - 1 }, ctx()) === "offre expirée ou presque");
  ok("sans rail paper refusée", filtrer({ ...base, rails: ["flop-htlc"] }, ctx()) === "rail paper absent");
  ok("déjà acceptée refusée", filtrer(base, { ...ctx(), acceptesVus: new Set(["0xoffre1"]) }) === "déjà acceptée par un autre");
  const plein = ctx(); fenetres(plein.etat, now); plein.etat.heure.accepts = REGLAGES.maxHeure;
  ok("plafond horaire", filtrer(base, plein) === "plafond horaire");
  const posteur = ctx(); fenetres(posteur.etat, now); posteur.etat.jour.parPosteur[base.from] = REGLAGES.maxPosteurJour;
  ok("plafond posteur", filtrer(base, posteur) === "plafond posteur");
  ok("trop en vol", filtrer(base, { ...ctx(), actifs: REGLAGES.maxActifs }) === "trop de deals en vol");
  const recent = ctx(); recent.etat.dernierAccept = now - 1000;
  ok("cadence : trop tôt après le dernier accept", filtrer(base, recent) === "cadence");
  const ancien = ctx(); ancien.etat.dernierAccept = now - REGLAGES.ecartMs - 1;
  ok("cadence : écart respecté", filtrer(base, ancien) === null);
  const e = etatVierge(); fenetres(e, now); e.jour.accepts = 5; fenetres(e, now + 86_400_000);
  ok("fenêtre du jour remise à zéro", e.jour.accepts === 0);
  const plan = planifier(parseSpec(base.job.context), null);
  ok("plan math depuis l'aperçu", plan && plan.genre === "math" && plan.reponse === "gcd=2 lcm=12");
  ok("famille hors liste → null", planifier(parseSpec("census | count rows | done looks like: one line"), null) === null);
  ok("docs sans cache → null (mis en file, pas accepté)", planifier(parseSpec("review | From https://raw.githubusercontent.com/flop-labs/tclk/main/README.md: What is the license of the project? | done looks like: one line"), null) === null);
  ok("validation jamais traitée en docs", planifier(parseSpec("validation | From https://technocore.chat/llms.txt: judge this | done looks like: PASS or FAIL"), null) === null);
  ok("math insoluble → null", planifier(parseSpec("math | [difficulty 3/3] What is love? | done looks like: one line"), null) === null);
  for (const [nom, res] of cas) console.log(`  ${nom.padEnd(36)} ${res ? "reussi" : "ECHOUE"}`);
  const rows = (deb, n) => Array.from({ length: n }, (_, k) => ({ seq: String(deb + k), id: "0x" + k, payer: "P" + (k % 3), amount: "1", asset: "FLOP", rails: "paper", proto: "a2a", role: "payer" }));
  ok("table tronquée : dernier seq loin de la fin annoncée", tableTronquee("Census over the excerpt seq 962441–963365 : how many offers", { header: ["seq"], rows: rows(962441, 90) }));
  ok("table complète : dernier seq proche de la fin", !tableTronquee("seq 100–300 : how many offers", { header: ["seq"], rows: rows(100, 190) }));
  ok("sans plage annoncée : pas de verdict", !tableTronquee("how many offers", { header: ["seq"], rows: rows(1, 3) }));
  const avant = salonsBloquesJusqua;
  ok("refus de salon 429 → blocage noté", noterRefusSalon("post to mb-p-tclk-x: rate limited (retry-after 3714s): 429 429 room-creation quota", now) && salonsBloquesJusqua === now + 3714 * 1000);
  ok("refus 400 plafond global → 15 min", noterRefusSalon("post to mb-p-tclk-y: 400 400 room limit reached (163840 is the cap)", now + 10_000_000) && salonsBloquesJusqua === now + 10_000_000 + 900 * 1000);
  ok("autre refus → rien", !noterRefusSalon("post to mb-p-tclk-z: 422 duplicate", now));
  const es = { salonsOuverts: Array.from({ length: 17 }, (_, i) => now - i * 60_000) };
  ok("réserve de salons : 17 ouverts dans l'heure → non ; les plus vieux qu'une heure sortent → oui", !peutOuvrirSalon(es, now, 17) && peutOuvrirSalon({ salonsOuverts: Array.from({ length: 17 }, (_, i) => now - 3600_001 - i) }, now, 17) && peutOuvrirSalon(es, now, 18));
  ok("attest refusée tant que les salons sont bloqués", planifier(parseSpec("attest | [difficulty 1/3] Post a signed line in the deal room then report its seq | reward tier 1/5 | done looks like: attested seq <seq>"), { did: "did:key:z6MkMoi" }) === null);
  salonsBloquesJusqua = avant;
  const echecs = cas.filter(([, r]) => !r).length;
  console.log(`selftest worker : ${cas.length - echecs}/${cas.length}`);
  return echecs ? 1 : 0;
}

function bilan() {
  const e = chargerEtat();
  console.log(JSON.stringify({ since: e.since, jour: { date: e.jour.date, accepts: e.jour.accepts, posteurs: Object.keys(e.jour.parPosteur).length }, heure: e.heure, stats: e.stats, docs: e.docs ?? null, derniers: e.derniers.slice(0, 10) }, null, 1));
}

const cmd = process.argv[2] ?? "loop";
if (cmd === "selftest") process.exit(selftest());
else if (cmd === "bilan") bilan();
else boucle().catch((e) => { journal("fatal", { detail: String(e.message ?? e).slice(0, 200) }); console.error(e); process.exit(1); });
