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
  OFFER_ROOM, PaperRail, applyFrame, dealRoom, lockTerms, makeOffer, openContract,
} from "@flop-labs/tclk";
import { DATA_DIR, signerFromEnv, verifyRecord } from "./signing.mjs";
import {
  BASE, authenticate, journal, log, noteAtPath, notes, post, postText, readSince, requireLocalVenue,
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
export function juger(tache, livraison, salonRecords = [], payee = "", contract = "") {
  if (tache.famille === "attest") {
    const m = /attested seq (\d+)/i.exec(livraison ?? "");
    if (!m) return { pass: false, motif: "delivery does not name a seq" };
    const seq = Number(m[1]);
    const ligne = salonRecords.find((r) => r.from === payee && Number(r.seq) === seq);
    if (!ligne) return { pass: false, motif: `no line with seq ${seq} signed by the payee in the deal room` };
    const attendu = `tclk-attest ${contract}`;
    return String(ligne.text ?? "").trim() === attendu
      ? { pass: true, motif: `seq ${seq} is the payee's signed line tclk-attest <contract> in the deal room` }
      : { pass: false, motif: `seq ${seq} is signed by the payee but does not read tclk-attest <contract>` };
  }
  const ok = normaliser(livraison) === normaliser(tache.reponse);
  return ok ? { pass: true, motif: "exact match against the reference answer (no judge call)" } : { pass: false, motif: "does not match the reference answer" };
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

// ----- le suivi d'un deal accepté ---------------------------------------------------------------------
async function salonExiste(room) { return (await readSince(room, 0, 0)).records.length > 0; }

async function verrouiller(signer, d, accept) {
  let state = applyFrame(openContract(d.offer), accept.frame, Date.now()).state;
  const rail = new PaperRail(notes);
  const ref = await rail.lock(lockTerms(state));
  const frame = { type: "lock", from: signer.did, contract: accept.frame.contract, rail: "paper", ref };
  const room = dealRoom(accept.frame.contract);
  // le payé ouvre le salon par son heartbeat ; on ne crée pas de salon nous-mêmes (quota) : on attend, sinon tableau
  const fin = Date.now() + REGLAGES.attenteLockRoomMs;
  while (Date.now() < fin && !(await salonExiste(room))) await new Promise((r) => setTimeout(r, 2000));
  const salon = (await salonExiste(room)) ? room : OFFER_ROOM;
  await post(signer, salon, frame);
  state = applyFrame(state, frame, Date.now()).state;
  d.contract = accept.frame.contract; d.payee = accept.frame.from; d.room = room; d.ref = ref; d.lockSalon = salon;
  d.state = state; d.etape = "verrouille"; d.since = 0;
  journal("payer_lock", { contract: d.contract, payee: d.payee, salon });
}

async function suivre(signer, etat, id, d) {
  const now = Date.now();
  if (d.etape === "offerte") {
    if (now > d.offer.expiresMs) { journal("payer_expiree", { id }); delete etat.actifs[id]; return; }
    return; // l'accept est détecté dans la boucle du tableau
  }
  // verrouillé : on lit le salon du deal (et le tableau, variante) pour la livraison + le reveal
  const vue = await readSince(d.room, d.since ?? 0, 0);
  d.since = vue.lastSeq;
  // mémoire du salon à chaque passe (le juge attest relit une ligne vue à une passe antérieure)
  d.tousRecords = (d.tousRecords ?? []).concat(vue.records.map((r) => ({ from: r.from, seq: r.seq, text: r.text }))).slice(-200);
  const recs = vue.records.filter((r) => r.from === d.payee);
  for (const r of recs) {
    // la livraison est une ligne signée en clair (pas un frame) ; un heartbeat est un frame inconnu « tclk1 … »
    if (!verifyRecord(d.room, r)) continue;
    const a = authenticate(r);
    if (!a.frame) {
      // la livraison = la DERNIÈRE ligne en clair du payé avant son reveal (mesuré en répétition : pour une
      // attestation, la première ligne est « tclk-attest <contract> », la livraison vient après)
      const txt = String(r.text ?? "");
      if (!d.reveal && !txt.startsWith("tclk1 ") && !txt.startsWith("tclk-attest ")) { d.livraison = txt; d.livraisonSeq = r.seq; }
      continue;
    }
    if (a.reason !== null) continue;
    if (a.frame.type === "reveal" && !d.reveal) {
      const res = applyFrame(d.state, a.frame, Date.parse(r.ts) || Date.now());
      if (res.ok) { d.state = res.state; d.reveal = a.frame.secret; }
      else journal("payer_reveal_refuse", { contract: d.contract, reason: res.reason });
    }
  }
  if (d.livraison && d.reveal) {
    const verdict = juger(d.tache, d.livraison, d.tousRecords, d.payee, d.contract);
    // le rail papier : le payé a normalement déjà réclamé ; on ne réclame que si le registre est encore verrouillé
    const rail = new PaperRail(notes);
    try {
      const rec = await rail.read(d.ref);
      if (rec && rec.status !== "claimed") await rail.claim(d.ref, d.reveal);
    } catch (e) { journal("payer_rail", { contract: d.contract, detail: String(e.message ?? e).slice(0, 120) }); }
    const salon = d.lockSalon;
    await post(signer, salon, { type: "receipt", from: signer.did, contract: d.contract, outcome: "claimed", rail: "paper", ref: d.ref });
    const reviewId = "0x" + randomBytes(8).toString("hex");
    await postText(signer, salon, ligneRevue(reviewId, d.contract, d.payee, verdict));
    etat.stats[verdict.pass ? "pass" : "fail"] += 1;
    journal("payer_verdict", { contract: d.contract, payee: d.payee, pass: verdict.pass, motif: verdict.motif, livraison: String(d.livraison).slice(0, 120), attendu: d.tache.reponse });
    log("", `verdict ${verdict.pass ? "PASS" : "FAIL"} · ${d.contract.slice(0, 12)} · ${String(d.livraison).slice(0, 60)}`);
    delete etat.actifs[id];
    return;
  }
  if (now >= d.offer.refundAfterMs) {
    const rail = new PaperRail(notes);
    try { await rail.refund(d.ref); } catch (e) { journal("payer_rail", { contract: d.contract, detail: String(e.message ?? e).slice(0, 120) }); }
    const salon = d.lockSalon;
    await post(signer, salon, { type: "refund", from: signer.did, contract: d.contract });
    await post(signer, salon, { type: "receipt", from: signer.did, contract: d.contract, outcome: "refunded", rail: "paper", ref: d.ref });
    etat.stats.refund += 1;
    journal("payer_refund", { contract: d.contract, payee: d.payee, livraison: !!d.livraison, reveal: !!d.reveal });
    delete etat.actifs[id];
  }
}

// ----- la boucle --------------------------------------------------------------------------------------
async function boucle() {
  const signer = signerFromEnv();
  const etat = charger();
  if (!etat.since) etat.since = (await readSince(OFFER_ROOM, 0, 0)).lastSeq;
  log("", `payer · ${signer.did.slice(0, 20)}… · ${REGLAGES.dry ? "DRY RUN" : "réel"} · une offre / ${REGLAGES.ecartMs / 60000} min · ${REGLAGES.maxJour}/j · relevé ${REGLAGES.ns || "-"} · salon ${REGLAGES.room || "-"}`);
  for (;;) {
    try {
      const now = Date.now();
      fenetre(etat, now);
      // 1. le tableau : accepts de nos offres
      const vue = await readSince(OFFER_ROOM, etat.since, 3);
      etat.since = vue.lastSeq;
      for (const r of vue.records) {
        const a = authenticate(r);
        if (a.reason !== null || !a.frame || a.frame.type !== "accept") continue;
        const d = etat.actifs[a.frame.ref];
        if (!d || d.etape !== "offerte" || a.frame.from === signer.did) continue;
        if (Date.now() > d.offer.expiresMs) continue;
        try { await verrouiller(signer, d, a); etat.stats.acceptees += 1; journal("payer_accepted", { id: a.frame.ref, contract: a.frame.contract, payee: a.frame.from }); }
        catch (e) { journal("payer_error", { id: a.frame.ref, detail: String(e.message ?? e).slice(0, 160) }); delete etat.actifs[a.frame.ref]; }
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
  for (const [n, r] of cas) console.log(`  ${n.padEnd(70)} ${r ? "reussi" : "ECHOUE"}`);
  const e = cas.filter(([, x]) => !x).length; console.log(`selftest payer : ${cas.length - e}/${cas.length}`); return e ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("payer.mjs")) {
  if (process.argv[2] === "selftest") process.exit(selftest());
  if (process.argv[2] === "rehearse") requireLocalVenue("payer rehearse");
  boucle().catch((e) => { console.error(e); process.exit(1); });
}
