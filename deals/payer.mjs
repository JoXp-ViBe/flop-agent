// SPDX-License-Identifier: Apache-2.0
//
// L'autre côté du commerce : nous comme PAYEUR. Hayes (02/09/2026) récompense « true agentic commerce » ;
// jouer les deux côtés est le seul angle que le worker ne montre pas. Ce module poste des offres tclk/1
// sur le tableau (rail paper, sans valeur), verrouille dès qu'un agent accepte, juge la livraison contre
// une réponse connue d'avance (jamais un juge de langage), et pose le reçu et la revue dans la forme que
// les workers du programme blockrewards savent lire.
//
// Les tâches sont UTILES à l'opérateur : elles font vérifier par un tiers, en conditions réelles, que le
// relevé quotidien (note /kv/<ns>/latest) et le salon possédé sont lisibles par un autre agent.
//
//   node deals/payer.mjs               la boucle (conteneur flop-payer)
//   node deals/payer.mjs selftest
//   PAYER_DRY_RUN=1                    prépare les offres sans rien poster

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  OFFER_ROOM, PaperRail, applyFrame, dealRoom, generateHashLock, lockTerms, makeAccept, makeOffer, openContract,
} from "@flop-labs/tclk";
import { DATA_DIR, signerFromEnv, verifyRecord } from "./signing.mjs";
import {
  BASE, authenticate, exportRoom, journal, log, noteAtPath, notes, post, postText, readSince, requireLocalVenue,
} from "./venue.mjs";

const entier = (nom, defaut) => { const v = Number(process.env[nom]); return Number.isFinite(v) && v >= 0 ? v : defaut; };
export const REGLAGES = {
  dry: process.env.PAYER_DRY_RUN === "1",
  ecartMs: entier("PAYER_INTERVAL_MS", 600_000),      // une offre toutes les 10 min
  maxJour: entier("PAYER_MAX_PER_DAY", 60),
  maxActifs: entier("PAYER_MAX_ACTIVE", 2),
  amount: process.env.PAYER_AMOUNT ?? "200",
  asset: process.env.PAYER_ASSET ?? "FLOP",
  ns: process.env.BRIEF_NS ?? "",                       // l'espace de notes du relevé (brief.env)
  room: process.env.BRIEF_ROOM ?? "",                   // le salon possédé du relevé
  // fenêtres (surchargées en répétition pour exercer le remboursement en une minute)
  expiresMs: entier("PAYER_EXPIRES_MS", 20 * 60_000), claimByMs: entier("PAYER_CLAIMBY_MS", 30 * 60_000), refundAfterMs: entier("PAYER_REFUND_MS", 45 * 60_000),
  attenteLockRoomMs: 20_000, sondeMs: 3_000,
  // le choix du payé : on laisse les accepts arriver quelques secondes, puis on verrouille le plus fiable
  fenetreAcceptsMs: entier("PAYER_ACCEPT_WINDOW_MS", 8_000), maxAccepts: 6,
  passeportUrl: process.env.PAYER_PASSPORT_URL ?? "https://flop-market.pages.dev/board/blockrewards/did/",
  passeportTtlMs: 6 * 3_600_000,
};
const ETAT = join(DATA_DIR, "payer.json");
const PROTOCOLE = "deliver as one signed message in the deal room, then reveal (tclk/1)";

// ----- les tâches : chacune porte sa réponse attendue, calculée par nous au moment de l'offre ---------
/** Lit le relevé et rend {ask, done, reponse} ou null si la note n'est pas lisible (on ne pose pas une question sans réponse). */
export function tacheReleve(noteTexte, ns) {
  let j; try { j = JSON.parse(noteTexte); } catch { return null; }
  const date = j?.reading_date, n = j?.readings && typeof j.readings === "object" ? Object.keys(j.readings).length : 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || n < 5) return null;
  return {
    famille: "protocol",
    ask: `Read the note /kv/${ns}/latest on technocore.chat (a JSON document of daily BTC on-chain readings). Report the value of the field reading_date and the number of keys inside readings.`,
    done: "one line: reading_date=<YYYY-MM-DD> readings=<n>",
    reponse: `reading_date=${date} readings=${n}`,
  };
}

/** Le salon possédé : combien de lignes signées par la clé de l'opérateur porte-t-il aujourd'hui ? */
export function tacheSalon(records, room, did, date) {
  const n = records.filter((r) => r.from === did && String(r.ts ?? "").startsWith(date)).length;
  if (n < 1) return null;
  return {
    famille: "protocol",
    ask: `Read https://technocore.chat/r/${room}?format=json&limit=50 and count the messages posted on ${date} (UTC) by ${did}. Report that count.`,
    done: "one line: count=<n>",
    reponse: `count=${n}`,
  };
}

/** La formulation canonique du tableau (celle que les solveurs, dont le nôtre, savent lire). */
export function tacheAttest() {
  return {
    famille: "attest",
    ask: "Attestation: in the derived deal room, write the single line `tclk-attest <contract id>` through the signed lane with your accepting key, then deliver one line: `attested seq <seq>`.",
    done: "one line: attested seq <seq>",
    reponse: null, // vérifiée dans le salon : la ligne du payé portant ce seq est exactement « tclk-attest <contract> »
  };
}

export function specTexte(t) {
  return `${t.famille} | [difficulty 1/3] ${t.ask} | reward tier 1/5 | done looks like: ${t.done} | ${PROTOCOLE}`;
}

/** Le jugement : exact après normalisation légère (espaces, casse, guillemets) — jamais un modèle. */
export function normaliser(s) {
  return String(s ?? "").replace(/^[\s"'`]+|[\s"'`.]+$/g, "").replace(/\s+/g, " ").toLowerCase();
}
export function juger(tache, livraison, salonRecords = [], payee = "", contract = "", salonLivraison = null) {
  if (tache.famille === "attest") {
    const m = /attested seq (\d+)/i.exec(livraison ?? "");
    if (!m) return { pass: false, motif: "delivery does not name a seq" };
    const seq = Number(m[1]);
    // les seq sont propres à chaque salon : la ligne attestée vit là où la livraison a été faite
    const candidats = salonRecords.filter((r) => r.from === payee && Number(r.seq) === seq);
    const ligne = candidats.find((r) => !salonLivraison || !r.room || r.room === salonLivraison) ?? candidats[0];
    if (!ligne) return { pass: false, motif: `no line with seq ${seq} signed by the payee in the deal room` };
    const attendu = `tclk-attest ${contract}`;
    return String(ligne.text ?? "").trim() === attendu
      ? { pass: true, motif: `seq ${seq} is the payee's signed line tclk-attest <contract> in the deal room` }
      : { pass: false, motif: `seq ${seq} is signed by the payee but does not read tclk-attest <contract>` };
  }
  // mesuré le 08/09 19:05 : un worker honnête (173 passes) a livré son raisonnement en trois lignes PUIS la ligne
  // « count=3 » exacte ; le juge strict l'a recalé. Le format « done looks like » reste la référence, mais une
  // réponse juste portée par la dernière ligne, ou présente comme phrase entière, est une réponse juste.
  if (normaliser(livraison) === normaliser(tache.reponse)) return { pass: true, motif: "exact match against the reference answer (no judge call)" };
  const derniere = lignes(livraison).at(-1);
  if (derniere !== undefined && normaliser(derniere) === normaliser(tache.reponse)) return { pass: true, motif: "last line matches the reference answer (no judge call)" };
  if (contientReponse(livraison, tache.reponse)) return { pass: true, motif: "contains the reference answer as a whole phrase (no judge call)" };
  return { pass: false, motif: "does not match the reference answer" };
}

/** Les lignes d'une livraison : la venue aplatit les retours à la ligne, certains agents écrivent « ⏎ ». */
export function lignes(s) {
  return String(s ?? "").split(/\s*⏎\s*|\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** La réponse attendue figure-t-elle comme phrase entière (bornée) dans la livraison ? « count=3 » ne matche pas « count=30 ». */
export function contientReponse(txt, reponse) {
  const t = normaliser(txt), r = normaliser(reponse);
  if (!r) return false;
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[\\s\"'`(\\[{])" + esc + "($|[\\s\"'`.,;:)\\]}])").test(t);
}

export function ligneRevue(reviewId, contract, payee, verdict) {
  return `review ${reviewId} contract ${contract.slice(0, 18)} payee ${payee.slice(-8)} ${verdict.pass ? "PASS 1" : "FAIL 0"} — ${verdict.motif}`;
}

// ----- état ----------------------------------------------------------------------------------------
function charger() {
  try { return JSON.parse(readFileSync(ETAT, "utf8")); } catch { return { jour: { date: "", n: 0 }, actifs: {}, derniereOffre: 0, since: 0, stats: { offres: 0, acceptees: 0, pass: 0, fail: 0, refund: 0 } }; }
}
function sauver(etat) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(ETAT, JSON.stringify(etat)); }
function fenetre(etat, now) {
  const d = new Date(now).toISOString().slice(0, 10);
  if (etat.jour.date !== d) etat.jour = { date: d, n: 0 };
}

// ----- une offre ------------------------------------------------------------------------------------
async function choisirTache(signer, etat) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const tour = (etat.stats.offres ?? 0) % 3;
  if (tour === 0 && REGLAGES.ns) {
    const note = await noteAtPath(`/kv/${REGLAGES.ns}/latest`);
    const t = note ? tacheReleve(note, REGLAGES.ns) : null;
    if (t) return t;
  }
  if (tour === 1 && REGLAGES.room) {
    const v = await readSince(REGLAGES.room, 0, 0);
    const t = tacheSalon(v.records, REGLAGES.room, signer.did, date);
    if (t) return t;
  }
  return tacheAttest();
}

export function construireOffre(signer, tache, now = Date.now()) {
  return makeOffer({
    from: signer.did, role: "payer", lock: "hash", amount: REGLAGES.amount, asset: REGLAGES.asset, rails: ["paper"],
    claimByMs: now + REGLAGES.claimByMs, refundAfterMs: now + REGLAGES.refundAfterMs, expiresMs: now + REGLAGES.expiresMs,
    job: { proto: "a2a", id: "t" + randomBytes(6).toString("hex"), context: specTexte(tache) },
  });
}

async function poster(signer, etat) {
  const tache = await choisirTache(signer, etat);
  const offer = construireOffre(signer, tache);
  if (REGLAGES.dry) { log("", `[dry] offre ${offer.id.slice(0, 12)} · ${tache.famille} · ${tache.reponse ?? "attest"}`); return; }
  await post(signer, OFFER_ROOM, offer);
  etat.actifs[offer.id] = { offer, tache, posteeMs: Date.now(), etape: "offerte" };
  etat.jour.n += 1; etat.derniereOffre = Date.now(); etat.stats.offres += 1;
  journal("payer_offer", { id: offer.id, famille: tache.famille, reponse: tache.reponse });
  log("", `offre ${offer.id.slice(0, 12)} · ${tache.famille}`);
}

// ----- le choix du payé ------------------------------------------------------------------------------
// Mesuré le 08/09/2026 : les trois premiers accepteurs de nos offres étaient des « snipers » (accept en
// quelques secondes, reveal ou réclamation du rail, aucune livraison). Verrouiller le premier accept livre
// donc l'offre au plus rapide, pas au plus fiable. On laisse les accepts arriver quelques secondes, puis on
// choisit : d'abord notre propre expérience du payé (un sniper vu chez nous est écarté tant qu'il y a un
// autre candidat), ensuite le passeport communautaire blockrewards (passes / fails publics, une donnée
// tierce lue en HTTP, jamais une instruction), enfin l'ordre d'arrivée.

/** Notre expérience d'un payé : verdicts que nous lui avons rendus. */
export function noterExperience(etat, did, pass) {
  etat.reputation = etat.reputation ?? {};
  const r = etat.reputation[did] ?? { ownPass: 0, ownFail: 0 };
  r[pass ? "ownPass" : "ownFail"] = (r[pass ? "ownPass" : "ownFail"] ?? 0) + 1;
  r.vuLe = Date.now();
  etat.reputation[did] = r;
  const cles = Object.keys(etat.reputation);
  if (cles.length > 500) for (const k of cles.sort((x, y) => (etat.reputation[x].vuLe ?? 0) - (etat.reputation[y].vuLe ?? 0)).slice(0, 100)) delete etat.reputation[k];
}

/** « passes 3 · claimed 0 · fails 0 · … · last 2026-09-07 03:38 UTC » → {passes, fails, claimed, last} ou null. */
export function lirePasseportTexte(html) {
  const texte = String(html ?? "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const n = (nom) => { const m = new RegExp(`\\b${nom}\\s+(\\d+)`).exec(texte); return m ? Number(m[1]) : null; };
  const passes = n("passes"), fails = n("fails"), claimed = n("claimed");
  if (passes === null && fails === null) return null;
  const last = /\blast\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(texte);
  return { passes: passes ?? 0, fails: fails ?? 0, claimed: claimed ?? 0, last: last ? last[1] : null };
}

/** Le passeport communautaire d'un DID (12 derniers caractères), mis en cache 6 h ; absent → inconnu. */
/**
 * Le passeport communautaire n'est PAS lisible en HTTP simple, mesure le 09/09/2026 : le site est une
 * application a rendu client qui sert son index (123 745 octets, identique au bit pres) pour TOUT chemin
 * sous /board/blockrewards/did/ — y compris pour un DID qu'il liste lui-meme, et y compris pour des noms
 * de fichiers inventes. Notre lecture rendait donc toujours la meme chose, {passes:0, fails:1}, extraite du
 * texte generique : la meme valeur pour un agent a 658 reussites que pour un DID qui n'a jamais travaille.
 * Un temoin qui rend la meme chose sur le cas positif et le cas negatif ne discrimine rien.
 *
 * On ne lit donc plus rien : le classement se fait sur NOTRE experience du paye, puis l'ordre d'arrivee.
 * `lirePasseportTexte` est conservee et testee — elle est correcte, il lui manque une source. Rebrancher
 * ici le jour ou le programme expose une donnee lisible par un agent (API, JSON, ligne signee sur la place).
 */
async function lirePasseport(etat, did) {
  etat.reputation = etat.reputation ?? {};
  const r = etat.reputation[did] ?? { ownPass: 0, ownFail: 0 };
  r.vuLe = Date.now();
  etat.reputation[did] = r;
  return r;
}

/**
 * Le candidat à verrouiller. Ordre : jamais un payé qui nous a déjà sniffé si un autre existe ; puis celui
 * que nous avons vu livrer ; puis le passeport s'il est un jour lisible (cf. lirePasseport) ; puis l'ordre d'arrivée.
 */
export function choisirPayee(accepts, reputation) {
  const info = (c) => reputation[c.frame.from] ?? {};
  const score = (c) => {
    const r = info(c);
    return (r.ownPass ?? 0) * 100 - (r.ownFail ?? 0) * 1000 + (r.passes ?? 0) - 2 * (r.fails ?? 0);
  };
  const classes = accepts.map((c, i) => ({ c, i, s: score(c) })).sort((x, y) => y.s - x.s || x.i - y.i);
  const best = classes[0];
  const r = info(best.c);
  const ecartes = classes.filter((x) => (info(x.c).ownFail ?? 0) > 0 && x !== best).length;
  let motif = (r.ownFail ?? 0) > 0 ? "only sniper seen by us" : (r.ownPass ?? 0) > 0 ? "delivered to us before" : (r.passes ?? 0) > 0 ? `passport passes ${r.passes} fails ${r.fails ?? 0}` : "first accepter, no record";
  if (ecartes) motif += `; ${ecartes} seen sniping, skipped`;
  // le classement complet, pour le journal : ordre d'arrivée, score, 8 derniers caractères du DID
  const classement = classes.map((x) => ({ did: x.c.frame.from.slice(-8), i: x.i, score: x.s }));
  return { frame: best.c.frame, motif, score: best.s, classement };
}

/** Une offre est prête à verrouiller : des accepts, et la fenêtre est close (ou assez de candidats). */
export function pretAVerrouiller(d, now) {
  if (d.etape !== "offerte" || !(d.accepts ?? []).length) return false;
  if (now > d.offer.expiresMs) return false;
  return now - d.premierAccept >= REGLAGES.fenetreAcceptsMs || d.accepts.length >= REGLAGES.maxAccepts;
}

// ----- le verrou -------------------------------------------------------------------------------------
async function salonExiste(room) { return (await readSince(room, 0, 0)).records.length > 0; }

async function verrouiller(signer, d, accept) {
  let state = applyFrame(openContract(d.offer), accept.frame, Date.now()).state;
  const rail = new PaperRail(notes);
  const ref = await rail.lock(lockTerms(state));
  const frame = { type: "lock", from: signer.did, contract: accept.frame.contract, rail: "paper", ref };
  const room = dealRoom(accept.frame.contract);
  // le payé ouvre parfois le salon par son heartbeat : on lui laisse quelques secondes
  const fin = Date.now() + REGLAGES.attenteLockRoomMs;
  while (Date.now() < fin && !(await salonExiste(room))) await new Promise((r) => setTimeout(r, 2000));
  let salon = room, salonCree = false;
  if (await salonExiste(room)) {
    await post(signer, room, frame);
  } else {
    // la convention mesurée chez les payeurs du programme : verrou sur le tableau, puis le PAYEUR ouvre le salon,
    // et les workers honnêtes livrent là. Ne pas l'ouvrir, c'est ne récolter que des snipers (mesuré le 08/09
    // 16:00 : un worker à 124 passes verrouillé sur le tableau n'a jamais livré). Coût : un salon neuf par deal
    // sur le quota du jour de notre IP ; refus de la venue → tableau seulement.
    await post(signer, OFFER_ROOM, frame);
    try { await post(signer, room, frame); salonCree = true; }
    catch (e) { salon = OFFER_ROOM; journal("payer_salon_refuse", { contract: accept.frame.contract, detail: String(e.message ?? e).slice(0, 120) }); }
  }
  state = applyFrame(state, frame, Date.now()).state;
  d.contract = accept.frame.contract; d.payee = accept.frame.from; d.room = room; d.ref = ref; d.lockSalon = salon;
  d.state = state; d.etape = "verrouille"; d.since = 0; d.lockAt = Date.now();
  journal("payer_lock", { contract: d.contract, payee: d.payee, salon, salonCree });
}

// ----- ce que le payé écrit, dans son salon ou sur le tableau ----------------------------------------
// Mesuré le 08/09/2026 en production : les payés n'ouvrent presque jamais de salon (plafond global de
// salons de la venue) ; ils livrent et révèlent sur le tableau, ou réclament le rail sans rien poster.
// Le suivi lit donc les deux endroits, et le rattrapage relit l'anneau d'export du tableau au démarrage.

/** Mémoire du deal : un record par (salon, seq), bornée. Rend false si déjà vu. */
function retenir(d, r) {
  d.tousRecords = d.tousRecords ?? [];
  if (d.tousRecords.some((x) => x.room === r.room && Number(x.seq) === Number(r.seq))) return false;
  d.tousRecords = d.tousRecords.concat([{ from: r.from, seq: r.seq, text: r.text, room: r.room }]).slice(-200);
  return true;
}

/**
 * Absorbe un record du payé (signature déjà vérifiée par l'appelant, `a` = authenticate(r)).
 * Une ligne en clair est une livraison candidate ; un frame reveal valide révèle. Sur le tableau le payé
 * sert aussi d'autres payeurs : une ligne égale à la réponse attendue prime ; sinon la DERNIÈRE ligne en
 * clair avant le reveal (mesuré en répétition : pour une attestation, la première ligne est
 * « tclk-attest <contract> », la livraison vient après). Rend "livraison", "reveal" ou null.
 */
export function absorber(d, r, a) {
  if (r.from !== d.payee || !retenir(d, r)) return null;
  if (!a.frame) {
    const txt = String(r.text ?? "");
    if (d.reveal || txt.startsWith("tclk1 ") || txt.startsWith("tclk-attest ")) return null;
    const exact = d.tache.reponse != null && (normaliser(txt) === normaliser(d.tache.reponse) || contientReponse(txt, d.tache.reponse));
    if (!exact && d.livraisonExacte) return null;
    d.livraison = txt; d.livraisonSeq = r.seq; d.livraisonSalon = r.room; d.livraisonExacte = exact;
    return "livraison";
  }
  if (a.reason !== null || a.frame.type !== "reveal" || a.frame.contract !== d.contract || d.reveal) return null;
  const res = applyFrame(d.state, a.frame, Date.parse(r.ts ?? "") || Date.now());
  if (!res.ok) { journal("payer_reveal_refuse", { contract: d.contract, reason: res.reason }); return null; }
  d.state = res.state; d.reveal = a.frame.secret; d.revealSalon = r.room;
  return "reveal";
}

/** Un record du tableau concerne-t-il ce deal ? (le payé, depuis le verrou, marge 10 s) */
export function pertinent(d, r) {
  if (r.from !== d.payee) return false;
  const ts = Date.parse(r.ts ?? "");
  return !(Number.isFinite(ts) && d.lockAt && ts < d.lockAt - 10_000);
}

/** L'issue d'un deal verrouillé à l'instant now. */
export function decision(d, now) {
  if (d.livraison && d.reveal) return "juger";
  if (d.reveal && now >= d.offer.claimByMs) return "reveal_sans_livraison";
  if (now >= d.offer.refundAfterMs) return "refund";
  return "attendre";
}

async function absorberSalon(d, salon, records) {
  for (const r of records) {
    if (r.from !== d.payee || !verifyRecord(salon, r)) continue;
    const rec = { ...r, room: salon };
    const quoi = absorber(d, rec, authenticate(rec));
    if (quoi) journal("payer_" + quoi, { contract: d.contract, salon, seq: r.seq });
  }
}

/** Le reçu (la vérité du rail : claimed) puis la revue lisible par les workers ; le deal est clos. */
async function conclure(signer, etat, id, d, verdict) {
  // le rail papier : le payé a normalement déjà réclamé ; on ne réclame que si le registre est encore verrouillé
  const rail = new PaperRail(notes);
  try {
    const rec = await rail.read(d.ref);
    if (rec && rec.status !== "claimed" && d.reveal) await rail.claim(d.ref, d.reveal);
  } catch (e) { journal("payer_rail", { contract: d.contract, detail: String(e.message ?? e).slice(0, 120) }); }
  const salon = d.lockSalon;
  await post(signer, salon, { type: "receipt", from: signer.did, contract: d.contract, outcome: "claimed", rail: "paper", ref: d.ref });
  const reviewId = "0x" + randomBytes(8).toString("hex");
  await postText(signer, salon, ligneRevue(reviewId, d.contract, d.payee, verdict));
  etat.stats[verdict.pass ? "pass" : "fail"] += 1;
  noterExperience(etat, d.payee, verdict.pass);
  journal("payer_verdict", { contract: d.contract, payee: d.payee, pass: verdict.pass, motif: verdict.motif, livraison: d.livraison == null ? null : String(d.livraison).slice(0, 120), salon: d.livraisonSalon ?? d.revealSalon ?? null, attendu: d.tache.reponse });
  log("", `verdict ${verdict.pass ? "PASS" : "FAIL"} · ${d.contract.slice(0, 12)} · ${String(d.livraison ?? "(no delivery)").slice(0, 60)}`);
  delete etat.actifs[id];
}

// ----- le suivi d'un deal accepté ---------------------------------------------------------------------
async function suivre(signer, etat, id, d) {
  const now = Date.now();
  if (d.etape === "offerte") {
    if (now > d.offer.expiresMs) { journal("payer_expiree", { id }); delete etat.actifs[id]; return; }
    return; // l'accept est détecté dans la boucle du tableau
  }
  // verrouillé : le salon du deal ici, le tableau dans la boucle → livraison + reveal
  const vue = await readSince(d.room, d.since ?? 0, 0);
  d.since = vue.lastSeq;
  await absorberSalon(d, d.room, vue.records);
  switch (decision(d, now)) {
    case "juger":
      return conclure(signer, etat, id, d, juger(d.tache, d.livraison, d.tousRecords, d.payee, d.contract, d.livraisonSalon));
    case "reveal_sans_livraison":
      return conclure(signer, etat, id, d, { pass: false, motif: "reveal seen but no delivery line, in the deal room or on the board" });
    case "refund": {
      const rail = new PaperRail(notes);
      let rec = null;
      try { rec = await rail.read(d.ref); } catch (e) { journal("payer_rail", { contract: d.contract, detail: String(e.message ?? e).slice(0, 120) }); }
      if (rec && rec.status === "claimed") {
        // réclamé sur le rail sans reveal vu ni livraison : le reçu dit la vérité du rail, la revue dit FAIL
        d.reveal = d.reveal ?? rec.secret ?? null;
        return conclure(signer, etat, id, d, { pass: false, motif: "paper claimed by the payee without a delivery line" });
      }
      try { await rail.refund(d.ref); } catch (e) { journal("payer_rail", { contract: d.contract, detail: String(e.message ?? e).slice(0, 120) }); }
      const salon = d.lockSalon;
      await post(signer, salon, { type: "refund", from: signer.did, contract: d.contract });
      await post(signer, salon, { type: "receipt", from: signer.did, contract: d.contract, outcome: "refunded", rail: "paper", ref: d.ref });
      etat.stats.refund += 1;
      journal("payer_refund", { contract: d.contract, payee: d.payee, livraison: !!d.livraison, reveal: !!d.reveal });
      delete etat.actifs[id];
      return;
    }
    default:
      return;
  }
}

/** Au démarrage : ce que les payés des deals verrouillés ont écrit sur le tableau pendant notre absence (anneau d'export, ~30 min). */
async function rattraper(etat) {
  const actifs = Object.values(etat.actifs).filter((d) => d.etape === "verrouille");
  if (!actifs.length) return;
  let ring;
  try { ring = await exportRoom(OFFER_ROOM); }
  catch (e) { journal("payer_rattrapage_refuse", { detail: String(e.message ?? e).slice(0, 120) }); return; }
  let n = 0;
  for (const d of actifs) {
    const avant = (d.livraison ? 1 : 0) + (d.reveal ? 1 : 0);
    await absorberSalon(d, OFFER_ROOM, ring.filter((r) => pertinent(d, r)));
    n += (d.livraison ? 1 : 0) + (d.reveal ? 1 : 0) - avant;
  }
  journal("payer_rattrapage", { deals: actifs.length, ring: ring.length, absorbes: n });
}

// ----- la boucle --------------------------------------------------------------------------------------
async function boucle() {
  const signer = signerFromEnv();
  const etat = charger();
  if (!etat.since) etat.since = (await readSince(OFFER_ROOM, 0, 0)).lastSeq;
  log("", `payer · ${signer.did.slice(0, 20)}… · ${REGLAGES.dry ? "DRY RUN" : "réel"} · une offre / ${REGLAGES.ecartMs / 60000} min · ${REGLAGES.maxJour}/j · relevé ${REGLAGES.ns || "-"} · salon ${REGLAGES.room || "-"}`);
  try { await rattraper(etat); } catch (e) { journal("payer_rattrapage_refuse", { detail: String(e.message ?? e).slice(0, 160) }); }
  for (;;) {
    try {
      const now = Date.now();
      fenetre(etat, now);
      // 1. le tableau : ce que nos payés y écrivent, puis les accepts de nos offres
      const vue = await readSince(OFFER_ROOM, etat.since, 3);
      etat.since = vue.lastSeq;
      const verrouilles = Object.values(etat.actifs).filter((d) => d.etape === "verrouille");
      for (const d of verrouilles) await absorberSalon(d, OFFER_ROOM, vue.records);
      for (const r of vue.records) {
        const a = authenticate(r);
        if (!a.frame || a.frame.type !== "accept") continue;
        const d = etat.actifs[a.frame.ref];
        if (!d || a.frame.from === signer.did) continue;
        // un accept de NOTRE offre qui ne passe pas la vérification laisse une trace (mesuré le 09/09 : un payé
        // a écrit quatre accepts jamais verrouillés sans qu'on sache pourquoi)
        if (a.reason !== null) { journal("payer_accept_invalide", { id: a.frame.ref, payee: r.from ?? null, from: a.frame.from, reason: a.reason, seq: r.seq }); continue; }
        if (d.etape !== "offerte") { journal("payer_accept_ignore", { id: a.frame.ref, payee: a.frame.from, motif: "already " + d.etape }); continue; }
        if (Date.now() > d.offer.expiresMs) { journal("payer_accept_ignore", { id: a.frame.ref, payee: a.frame.from, motif: "offer expired" }); continue; }
        d.accepts = d.accepts ?? [];
        if (d.accepts.some((x) => x.frame.from === a.frame.from)) continue;
        d.accepts.push({ frame: a.frame, at: Date.now() });
        d.premierAccept = d.premierAccept ?? Date.now();
        journal("payer_accept_vu", { id: a.frame.ref, payee: a.frame.from, candidats: d.accepts.length });
      }
      // 1bis. fin de fenêtre : on verrouille le candidat le plus fiable (notre expérience, puis le passeport communautaire)
      for (const [id, d] of Object.entries(etat.actifs)) {
        if (!pretAVerrouiller(d, Date.now())) continue;
        for (const c of d.accepts) await lirePasseport(etat, c.frame.from);
        const choix = choisirPayee(d.accepts, etat.reputation ?? {});
        journal("payer_lock_choix", { id, candidats: d.accepts.length, payee: choix.frame.from, motif: choix.motif, classement: choix.classement });
        try { await verrouiller(signer, d, { frame: choix.frame }); etat.stats.acceptees += 1; journal("payer_accepted", { id, contract: choix.frame.contract, payee: choix.frame.from }); }
        catch (e) { journal("payer_error", { id, detail: String(e.message ?? e).slice(0, 160) }); delete etat.actifs[id]; }
      }
      // 2. les deals en cours
      for (const [id, d] of Object.entries(etat.actifs)) {
        try { await suivre(signer, etat, id, d); }
        catch (e) { journal("payer_error", { id, detail: String(e.message ?? e).slice(0, 160) }); }
      }
      // 3. une nouvelle offre quand la cadence et les plafonds le permettent
      const actifs = Object.keys(etat.actifs).length;
      if (now - etat.derniereOffre >= REGLAGES.ecartMs && etat.jour.n < REGLAGES.maxJour && actifs < REGLAGES.maxActifs) {
        await poster(signer, etat);
      }
      sauver(etat);
    } catch (e) {
      journal("payer_boucle_error", { detail: String(e.message ?? e).slice(0, 160) });
      await new Promise((r) => setTimeout(r, 5000));
    }
    await new Promise((r) => setTimeout(r, REGLAGES.sondeMs));
  }
}

export function selftest() {
  const cas = []; const ok = (n, c) => cas.push([n, !!c]);
  const note = JSON.stringify({ v: 1, reading_date: "2026-09-08", readings: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {} } });
  const t = tacheReleve(note, "onchain-brief");
  ok("tâche relevé : réponse calculée", t && t.reponse === "reading_date=2026-09-08 readings=6" && t.ask.includes("/kv/onchain-brief/latest"));
  ok("tâche relevé : note illisible → null", tacheReleve("!! pas du json", "x") === null && tacheReleve(JSON.stringify({ reading_date: "2026-09-08", readings: { a: 1 } }), "x") === null);
  const recs = [{ from: "did:key:z6MkMoi", ts: "2026-09-08T08:53:06Z", seq: 1 }, { from: "did:key:z6MkMoi", ts: "2026-09-08T08:53:07Z", seq: 2 }, { from: "did:key:z6MkAutre", ts: "2026-09-08T09:00:00Z", seq: 3 }, { from: "did:key:z6MkMoi", ts: "2026-09-07T08:53:07Z", seq: 0 }];
  const s = tacheSalon(recs, "d-x", "did:key:z6MkMoi", "2026-09-08");
  ok("tâche salon : compte du jour, notre clé seulement", s && s.reponse === "count=2");
  ok("jugement exact, tolérant à la casse et aux guillemets", juger(t, ' "Reading_date=2026-09-08 readings=6" ').pass && !juger(t, "reading_date=2026-09-08 readings=7").pass);
  const tc = { famille: "protocol", reponse: "count=3" };
  const reel = "1. seq=1 from did:key:z6MkA, ts 2026-09-08T08:53:06Z ⏎ 2. seq=2 from did:key:z6MkA ⏎ 3. seq=3 ⏎ All 3 messages are dated 2026-09-08 (UTC); \"count\": 3 confirms the total. ⏎ count=3";
  ok("jugement : la dernière ligne juste passe (cas réel du 08/09 19:05)", juger(tc, reel).pass && juger(tc, reel).motif.startsWith("last line"));
  ok("jugement : la réponse comme phrase entière passe, pas un préfixe", juger(tc, 'Result: "count=3".').pass && !juger(tc, "count=30").pass && !juger(tc, "the count is 3").pass && !juger(tc, "count=3x").pass);
  ok("jugement : readings=20 ne matche pas readings=200", !juger({ famille: "protocol", reponse: "reading_date=2026-09-08 readings=20" }, "reading_date=2026-09-08 readings=200").pass);
  const at = tacheAttest();
  const C = "0x" + "a".repeat(64);
  ok("jugement attest : la ligne du payé au seq livré doit être tclk-attest <contract>", juger(at, "attested seq 5", [{ from: "did:key:z6MkP", seq: 5, text: "tclk-attest " + C }], "did:key:z6MkP", C).pass && !juger(at, "attested seq 5", [{ from: "did:key:z6MkP", seq: 5, text: "hello" }], "did:key:z6MkP", C).pass && !juger(at, "attested seq 6", [{ from: "did:key:z6MkP", seq: 5, text: "tclk-attest " + C }], "did:key:z6MkP", C).pass);
  ok("ask attest = formulation canonique lisible par les solveurs", at.ask.includes("`tclk-attest <contract id>`") && at.ask.includes("`attested seq <seq>`"));
  const spec = specTexte(t);
  ok("spec au format du programme", spec.startsWith("protocol | [difficulty 1/3] ") && spec.includes("| reward tier 1/5 | done looks like: one line: reading_date=") && spec.endsWith(PROTOCOLE));
  const signer = { did: "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S" };
  const offer = construireOffre(signer, t, 1_800_000_000_000);
  ok("offre valide pour la bibliothèque (claimBy < refundAfter, rail paper, job a2a)", offer.type === "offer" && offer.claimByMs < offer.refundAfterMs && offer.rails.includes("paper") && offer.job.context === spec && offer.id.startsWith("0x"));
  const rev = ligneRevue("0xabc", "0x" + "1".repeat(64), "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S", { pass: true, motif: "exact match" });
  ok("ligne de revue lisible par les workers (review … PASS 1 — …)", /^review 0xabc contract 0x1{16} payee z1xB22S PASS 1 — exact match$/.test(rev) || /^review 0xabc contract 0x1{16} payee [A-Za-z0-9]{8} PASS 1 — exact match$/.test(rev));
  // absorber : livraison et reveal, dans le salon ou sur le tableau, avec un vrai état de contrat
  const lock = generateHashLock();
  const payee = "did:key:z6MkkCR2AgQh8ecL2vMVVbZ7sL92hPpFmceoxpdKh7W1obrj";
  const acc = makeAccept(offer, { from: payee, statement: lock.hash });
  let st = applyFrame(openContract(offer), acc, 1_800_000_000_000).state;
  st = applyFrame(st, { type: "lock", from: signer.did, contract: acc.contract, rail: "paper", ref: acc.contract }, 1_800_000_000_001).state;
  const d = { payee, contract: acc.contract, state: st, offer, lockAt: 1_800_000_000_001, tache: { famille: "protocol", reponse: "count=3" } };
  const clair = { frame: null, reason: "pas un frame tclk" };
  ok("absorber : une ligne en clair du payé = livraison candidate", absorber(d, { from: payee, seq: 1, text: "hello", room: "tclk-offers" }, clair) === "livraison" && d.livraison === "hello");
  ok("absorber : la ligne égale à la réponse attendue prime, et tient", absorber(d, { from: payee, seq: 2, text: " Count=3 ", room: "tclk-offers" }, clair) === "livraison" && absorber(d, { from: payee, seq: 3, text: "other", room: "tclk-offers" }, clair) === null && d.livraison === " Count=3 ");
  ok("absorber : un autre signataire est ignoré", absorber(d, { from: "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S", seq: 4, text: "count=3", room: "tclk-offers" }, clair) === null);
  ok("absorber : tclk-attest n'est pas une livraison mais reste en mémoire", absorber(d, { from: payee, seq: 5, text: "tclk-attest " + acc.contract, room: "tclk-offers" }, clair) === null && d.tousRecords.some((r) => r.seq === 5));
  ok("absorber : un doublon (salon, seq) est ignoré", absorber(d, { from: payee, seq: 5, text: "tclk-attest " + acc.contract, room: "tclk-offers" }, clair) === null && d.tousRecords.filter((r) => r.seq === 5).length === 1);
  const ts = new Date(1_800_000_010_000).toISOString();
  const faux = { frame: { type: "reveal", from: payee, contract: acc.contract, secret: "0x" + "0".repeat(64) }, reason: null };
  ok("absorber : un reveal au mauvais secret est refusé", absorber(d, { from: payee, seq: 6, text: "tclk1 x", room: "tclk-offers", ts }, faux) === null && !d.reveal);
  const vrai = { frame: { type: "reveal", from: payee, contract: acc.contract, secret: lock.preimage }, reason: null };
  ok("absorber : le reveal au bon secret révèle (état officiel)", absorber(d, { from: payee, seq: 7, text: "tclk1 y", room: "tclk-offers", ts }, vrai) === "reveal" && d.reveal === lock.preimage);
  ok("absorber : après le reveal, plus de livraison", absorber(d, { from: payee, seq: 8, text: "late", room: "tclk-offers" }, clair) === null && d.livraison === " Count=3 ");
  ok("decision : livraison + reveal → juger", decision(d, 0) === "juger");
  const o2 = { claimByMs: 100, refundAfterMs: 200 };
  ok("decision : reveal seul → attendre puis reveal_sans_livraison à claimBy", decision({ reveal: "s", offer: o2 }, 50) === "attendre" && decision({ reveal: "s", offer: o2 }, 100) === "reveal_sans_livraison");
  ok("decision : rien → attendre puis refund à refundAfter", decision({ offer: o2 }, 150) === "attendre" && decision({ offer: o2 }, 200) === "refund");
  ok("pertinent : le payé depuis le verrou (marge 10 s), pas avant, pas un autre", pertinent(d, { from: payee, ts: new Date(1_800_000_000_001 - 5_000).toISOString() }) && !pertinent(d, { from: payee, ts: new Date(1_800_000_000_001 - 60_000).toISOString() }) && !pertinent(d, { from: "did:key:z6MkAutre", ts }));
  ok("juger attest : la ligne attestée est cherchée dans le salon de la livraison", juger(at, "attested seq 5", [{ from: payee, seq: 5, text: "autre", room: "mb-p-x" }, { from: payee, seq: 5, text: "tclk-attest " + C, room: "tclk-offers" }], payee, C, "tclk-offers").pass && !juger(at, "attested seq 5", [{ from: payee, seq: 5, text: "autre", room: "mb-p-x" }, { from: payee, seq: 5, text: "tclk-attest " + C, room: "tclk-offers" }], payee, C, "mb-p-x").pass);
  // le choix du payé
  const A = { frame: { from: "did:key:z6MkA1" } }, B = { frame: { from: "did:key:z6MkB2" } }, Cc = { frame: { from: "did:key:z6MkC3" } };
  ok("choix : sans mémoire, l'ordre d'arrivée", choisirPayee([A, B], {}).frame.from === "did:key:z6MkA1" && choisirPayee([A, B], {}).motif === "first accepter, no record");
  ok("choix : un sniper vu chez nous est écarté s'il y a un autre candidat, et le journal le dit", choisirPayee([A, B], { "did:key:z6MkA1": { ownFail: 1 } }).frame.from === "did:key:z6MkB2" && choisirPayee([A, B], { "did:key:z6MkA1": { ownFail: 1 } }).motif === "first accepter, no record; 1 seen sniping, skipped" && choisirPayee([A, B], { "did:key:z6MkA1": { ownFail: 1 } }).classement.length === 2);
  ok("choix : un sniper seul est quand même verrouillé (revue FAIL = information)", choisirPayee([A], { "did:key:z6MkA1": { ownFail: 1 } }).motif === "only sniper seen by us");
  ok("choix : celui qui nous a déjà livré passe devant le passeport", choisirPayee([A, B], { "did:key:z6MkA1": { passes: 40 }, "did:key:z6MkB2": { ownPass: 1 } }).frame.from === "did:key:z6MkB2");
  ok("choix : à expérience égale, le passeport (passes − 2·fails)", choisirPayee([A, B, Cc], { "did:key:z6MkA1": { passes: 3, fails: 0 }, "did:key:z6MkB2": { passes: 10, fails: 4 }, "did:key:z6MkC3": { passes: 5, fails: 0 } }).frame.from === "did:key:z6MkC3");
  const pp = lirePasseportTexte('<html><body><h1>Passport</h1><p>rank 231 · score 16 · passes 3 · claimed 0 · fails 1 · validations 0/0 · distinct posters 3 · first 2026-09-07 01:40 · last 2026-09-07 03:38 UTC</p></body></html>');
  ok("passeport : passes / fails / claimed / last lus dans la page", pp && pp.passes === 3 && pp.fails === 1 && pp.claimed === 0 && pp.last === "2026-09-07 03:38");
  ok("passeport : page sans compteurs → null", lirePasseportTexte("<html>Not found</html>") === null);
  const e2 = { reputation: {} }; noterExperience(e2, "did:key:z6MkA1", false); noterExperience(e2, "did:key:z6MkA1", true); noterExperience(e2, "did:key:z6MkA1", true);
  ok("expérience : nos verdicts comptés par payé", e2.reputation["did:key:z6MkA1"].ownFail === 1 && e2.reputation["did:key:z6MkA1"].ownPass === 2);
  const dd = { etape: "offerte", offer: { expiresMs: 10_000_000 }, accepts: [A], premierAccept: 1_000 };
  ok("fenêtre : pas avant 8 s, oui après, oui dès 6 candidats, jamais après expiration", !pretAVerrouiller(dd, 5_000) && pretAVerrouiller(dd, 9_100) && pretAVerrouiller({ ...dd, accepts: [A, B, Cc, A, B, Cc] }, 1_500) && !pretAVerrouiller({ ...dd, offer: { expiresMs: 2_000 } }, 9_100));
  for (const [n, r] of cas) console.log(`  ${n.padEnd(70)} ${r ? "reussi" : "ECHOUE"}`);
  const e = cas.filter(([, x]) => !x).length; console.log(`selftest payer : ${cas.length - e}/${cas.length}`); return e ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("payer.mjs")) {
  if (process.argv[2] === "selftest") process.exit(selftest());
  if (process.argv[2] === "rehearse") requireLocalVenue("payer rehearse");
  boucle().catch((e) => { console.error(e); process.exit(1); });
}
