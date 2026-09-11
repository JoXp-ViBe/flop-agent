#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Contrats tclk/1 pour flop-agent, sur la bibliothèque officielle @flop-labs/tclk (0.1.0).
//
// Ce que Hayes récompense (02/09/2026) : « true agentic commerce using this feature ». Un
// contrat compte s'il est réel : deux clés distinctes, un accord, un verrou, une révélation,
// lisibles par n'importe qui sur le tableau public. Ce fichier ne fabrique donc PAS de deals
// avec soi-même sur la venue partagée : `rehearse` (les deux rôles à la suite) refuse de
// tourner ailleurs que sur une instance locale.
//
// Le paquet npm 0.1.0 ne publie pas encore les aides de transcription du dépôt (fold, export) :
// elles sont réécrites dans venue.mjs sur la même règle : un frame n'avance l'état que s'il est signé par
// le did qu'il porte, dans le bon salon, à l'horodatage de la venue.
//
// Commandes (TECHNOCORE_URL, FLOP_SEED, FLOP_DATA) :
//   node deal.mjs selftest                         frames, id de contrat, machine d'état, sans réseau
//   node deal.mjs board [n]                        les n derniers frames du tableau tclk-offers, vérifiés
//   node deal.mjs offer <amount> <asset> <rails> "<job>"   poster une offre (rôle payeur)
//   node deal.mjs accept <offerId>                 accepter une offre du tableau (rôle payé), mint le secret
//   node deal.mjs lock <contract>                  (payeur) verrouiller sur le rail paper + frame lock
//   node deal.mjs deliver <contract> "<texte>"     (payé) livrer le travail : un message signé dans le salon du deal
//   node deal.mjs reveal <contract>                (payé) révéler le secret = réclamer
//   node deal.mjs refund <contract>                (payeur) rembourser après refundAfterMs
//   node deal.mjs status <contract>                replier la transcription : état vérifié
//   node deal.mjs rehearse                         un deal complet contre une instance LOCALE
//
// Le rail « paper » ne tient RIEN : asset PAPER, aucune valeur ne bouge, aucune ne le peut.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  OFFER_ROOM, PaperRail, applyFrame, dealRoom, encodeFrame, generateHashLock, lockTerms, makeAccept,
  makeOffer, openContract, paperNote, stateNote, stateNoteValue, tryDecodeFrame, contractId,
} from "@flop-labs/tclk";
import { canonicalMessage, nextNonce, signerFromEnv, signerFromSeed, sweep, verifyRecord } from "./signing.mjs";
import {
  BASE, VenueError, log, journal, exportRoom, readRoom, postText, post, notes, authenticate, findHandshake,
  fold, foldContract, saveDeal, loadDeal, requireLocalVenue,
} from "./venue.mjs";

// ----- commandes -----
async function cmdBoard(n = 40) {
  const records = await readRoom(OFFER_ROOM, Math.min(Number(n) || 40, 200));
  let shown = 0;
  for (const rec of records) {
    const a = authenticate(rec);
    if (a.frame === null) continue;
    const f = a.frame;
    const id = (f.id ?? f.contract ?? "").slice(0, 14);
    const who = (rec.from ?? "").slice(8, 24);
    let extra = "";
    if (f.type === "offer") {
      const job = typeof f.job?.context === "string" ? f.job.context.slice(0, 70) : (f.job?.id ?? "");
      extra = `${f.amount} ${f.asset} rails=${(f.rails ?? []).join(",")} expire=${new Date(f.expiresMs ?? 0).toISOString().slice(11, 16)}Z | ${job}`;
    }
    console.log(`${rec.seq}\t${(rec.ts ?? "").slice(11, 19)}\t${a.reason === null ? "signé" : "IGNORÉ:" + a.reason}\t${f.type.padEnd(7)}\t${id}…\t${who}…\t${extra}`);
    shown += 1;
  }
  console.log(`${shown} frame(s) tclk sur ${records.length} message(s) lus dans /r/${OFFER_ROOM}`);
}

async function cmdOffer(amount, asset, rails, job) {
  const signer = signerFromEnv();
  const now = Date.now();
  const taskId = `job-${randomBytes(4).toString("hex")}`;
  const offer = makeOffer({
    from: signer.did, role: "payer", lock: "hash", amount: String(amount), asset, rails: rails.split(","),
    claimByMs: now + 6 * 3_600_000, refundAfterMs: now + 12 * 3_600_000, expiresMs: now + 24 * 3_600_000,
    job: { proto: "a2a", id: taskId, context: job },
  });
  await post(signer, OFFER_ROOM, offer);
  saveDeal(offer.id, { role: "payer", offer, createdAt: now });
  log(1, `offre postée dans /r/${OFFER_ROOM}, id ${offer.id}`);
}

async function findOffer(offerId) {
  const board = await exportRoom(OFFER_ROOM);
  for (const rec of board) {
    const a = authenticate(rec);
    if (a.frame && a.frame.type === "offer" && a.frame.id === offerId) {
      if (a.reason !== null) throw new Error(`l'offre existe mais est ignorée : ${a.reason}`);
      return a.frame;
    }
  }
  throw new Error(`offre ${offerId} introuvable sur le tableau exporté`);
}

async function cmdAccept(offerId) {
  const signer = signerFromEnv();
  const offer = await findOffer(offerId);
  if (offer.from === signer.did) throw new Error("c'est notre propre offre : on ne l'accepte pas soi-même");
  if ((offer.expiresMs ?? 0) < Date.now()) throw new Error("offre expirée");
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: signer.did, statement: lock.hash });
  await post(signer, OFFER_ROOM, accept);
  const room = dealRoom(accept.contract);
  const sn = stateNote(accept.contract);
  await notes.set(sn.ns, sn.key, stateNoteValue("accepted"), { ifAbsent: true });
  saveDeal(accept.contract, { role: "payee", offer, accept, preimage: lock.preimage, statement: lock.hash, room, createdAt: Date.now() });
  log(2, `acceptée : contrat ${accept.contract}`);
  log("", `salon du deal /r/${room} · note d'état /kv/${sn.ns}/${sn.key}`);
  log("", `travail : ${typeof offer.job?.context === "string" ? offer.job.context.slice(0, 200) : JSON.stringify(offer.job ?? {})}`);
  log("", "le secret est dans data/deals (0600). Suite : attendre le lock du payeur, VÉRIFIER le rail, `deliver`, puis `reveal`.");
}

async function cmdLock(contract) {
  const signer = signerFromEnv();
  const { state } = await foldContract(contract);
  if (state.status !== "accepted") throw new Error(`état ${state.status}, attendu accepted`);
  if (state.offer.from !== signer.did) throw new Error("nous ne sommes pas le payeur de ce contrat");
  const rail = new PaperRail(notes);
  const ref = await rail.lock(lockTerms(state));
  await post(signer, dealRoom(contract), { type: "lock", from: signer.did, contract, rail: "paper", ref });
  const sn = stateNote(contract);
  await notes.set(sn.ns, sn.key, stateNoteValue("locked", ref), { if: stateNoteValue("accepted") });
  const pn = paperNote(contract);
  log(3, `lock posté, rail record /kv/${pn.ns}/${pn.key}`);
}

/** La livraison n'est pas un frame : un message signé, en clair, dans le salon du deal. */
async function cmdDeliver(contract, texte) {
  const signer = signerFromEnv();
  if (!texte) throw new Error("deliver <contract> \"<texte>\"");
  const swept = await postText(signer, dealRoom(contract), texte);
  journal("deliver", { contract, chars: swept.length });
  log("", `livré dans /r/${dealRoom(contract)} (${swept.length} caractères)`);
}

async function cmdReveal(contract) {
  const signer = signerFromEnv();
  const local = loadDeal(contract);
  if (local.role !== "payee" || !local.preimage) throw new Error("pas le payé de ce contrat, ou secret absent");
  const { state } = await foldContract(contract);
  if (state.status !== "locked") throw new Error(`état ${state.status}, attendu locked`);
  if (state.rail !== "paper") throw new Error(`rail ${state.rail} : seul paper est vérifiable ici`);
  const rail = new PaperRail(notes);
  const ref = state.railRef;
  if (!(await rail.verifyLock(lockTerms(state), ref))) throw new Error("le rail ne tient pas le verrou annoncé : on ne révèle pas");
  await post(signer, dealRoom(contract), { type: "reveal", from: signer.did, contract, secret: local.preimage });
  await rail.claim(ref, local.preimage);
  const sn = stateNote(contract);
  await notes.set(sn.ns, sn.key, stateNoteValue("claimed", ref), { if: stateNoteValue("locked", ref) });
  log(4, "secret révélé = réclamé ; rail record → claimed");
}

async function cmdRefund(contract) {
  const signer = signerFromEnv();
  const { state } = await foldContract(contract);
  if (state.status !== "locked") throw new Error(`état ${state.status}, attendu locked`);
  if (state.offer.from !== signer.did) throw new Error("nous ne sommes pas le payeur");
  if (Date.now() < (state.offer.refundAfterMs ?? Infinity)) throw new Error("refundAfterMs pas encore atteint");
  const rail = new PaperRail(notes);
  await rail.refund(state.railRef);
  await post(signer, dealRoom(contract), { type: "refund", from: signer.did, contract });
  log(5, "remboursé sur le rail, frame refund posté");
}

async function cmdStatus(contract) {
  const { state, steps, dealLog } = await foldContract(contract);
  const applied = steps.filter((s) => s.ok).length;
  console.log(`contrat ${contract}`);
  console.log(`payeur ${state.offer.from} → payé ${state.payeeDid ?? "?"} · ${state.offer.amount} ${state.offer.asset}`);
  console.log(`frames appliqués ${applied}, ignorés ${steps.length - applied} · état vérifié : ${state.status}`);
  for (const s of steps) if (!s.ok) console.log(`  ignoré seq ${s.seq} : ${s.reason ?? "?"}`);
  const livraisons = dealLog.filter((r) => !(r.text ?? "").startsWith("tclk1 ") && verifyRecord(r.room, r));
  for (const r of livraisons) console.log(`  message signé ${(r.from ?? "").slice(8, 24)}… : ${(r.text ?? "").slice(0, 120)}`);
}

/** Les deux rôles à la suite, contre une instance locale seulement. Reprise de examples/live-deal.mjs. */
async function cmdRehearse() {
  requireLocalVenue("rehearse");
  const payer = signerFromSeed(randomBytes(32));
  const payee = signerFromSeed(randomBytes(32));
  const rail = new PaperRail(notes);
  const now = Date.now();
  const offer = makeOffer({ from: payer.did, role: "payer", lock: "hash", amount: "1", asset: "PAPER", rails: ["paper"],
    claimByMs: now + 1_800_000, refundAfterMs: now + 3_600_000, expiresMs: now + 600_000 });
  await post(payer, OFFER_ROOM, offer);
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: payee.did, statement: lock.hash });
  await post(payee, OFFER_ROOM, accept);
  const room = dealRoom(accept.contract);
  let view = applyFrame(openContract(offer), accept, Date.now()).state;
  const ref = await rail.lock(lockTerms(view));
  const lockFrame = { type: "lock", from: payer.did, contract: accept.contract, rail: "paper", ref };
  await post(payer, room, lockFrame);
  view = applyFrame(view, lockFrame, Date.now()).state;
  if (!(await rail.verifyLock(lockTerms(view), ref))) throw new Error("rail ne tient pas le verrou");
  await post(payee, room, { type: "reveal", from: payee.did, contract: accept.contract, secret: lock.preimage });
  await rail.claim(ref, lock.preimage);
  const { state } = await foldContract(accept.contract);
  console.log(`répétition : état final ${state.status} (attendu claimed)`);
}

/** Sans réseau : signatures = vecteurs officiels, frames, id de contrat, machine d'état, fold, nonces. */
function cmdSelftest() {
  // la graine de TEST des vecteurs officiels : 64 fois « 1 » en hex, soit 32 octets 0x11
  const payer = signerFromSeed(new Uint8Array(32).fill(0x11));
  const payee = signerFromSeed(new Uint8Array(32).fill(0x22));
  const oks = [];
  oks.push(["did = vecteur officiel", payer.did === "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S"]);
  const sigOff = payer.sign(canonicalMessage("lobby", "1700000000000", sweep("hello  world")));
  oks.push(["say = vecteur officiel", sigOff === "mZWG1pXWqK_yrnnqGbx-rzoLF-OvQDR1mEqz2oy_IluQwu4VEvnZteiTWFEt4SDiYhyimaP7aeYpFPogEl3eCA"]);
  oks.push(["verifyRecord vrai", verifyRecord("lobby", { from: payer.did, nonce: 1700000000000, sig: sigOff, text: "hello  world" })]);
  oks.push(["verifyRecord faux (autre salon)", !verifyRecord("lobbx", { from: payer.did, nonce: 1700000000000, sig: sigOff, text: "hello  world" })]);
  oks.push(["verifyRecord faux (autre did)", !verifyRecord("lobby", { from: payee.did, nonce: 1700000000000, sig: sigOff, text: "hello  world" })]);
  const now = Date.now();
  const offer = makeOffer({ from: payer.did, role: "payer", lock: "hash", amount: "1", asset: "PAPER", rails: ["paper"],
    claimByMs: now + 1_800_000, refundAfterMs: now + 3_600_000, expiresMs: now + 600_000 });
  const line = encodeFrame(offer);
  oks.push(["frame offer encodé ≤ 4096 ASCII", line.length <= 4096 && /^[\x20-\x7e]+$/.test(line)]);
  oks.push(["frame se décode", tryDecodeFrame(line) !== null]);
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: payee.did, statement: lock.hash });
  // l'id de contrat est calculé par la bibliothèque officielle ; on vérifie le lien et la forme,
  // et que deux accepts de la même offre (nonces différents) ne donnent pas le même contrat
  const accept2 = makeAccept(offer, { from: payee.did, statement: generateHashLock().hash });
  oks.push(["accept lié à l'offre, contrat dérivé unique", accept.ref === offer.id && /^0x[0-9a-f]{64}$/.test(accept.contract)
    && accept2.contract !== accept.contract && typeof contractId === "function"]);
  // une transcription signée, repliée par le même chemin que la production
  const mk = (signer, room, frame, seq, t) => {
    const text = sweep(encodeFrame(frame));
    const nonce = 1700000000000 + seq;
    return { room, seq, ts: new Date(t).toISOString(), from: signer.did, text, nonce, sig: signer.sign(canonicalMessage(room, nonce, text)) };
  };
  const room = dealRoom(accept.contract);
  const board = [mk(payer, OFFER_ROOM, offer, 1, now + 1), mk(payee, OFFER_ROOM, accept, 2, now + 2)];
  const hs = findHandshake(board, accept.contract);
  oks.push(["handshake trouvé sur le tableau", hs !== null]);
  const lockFrame = { type: "lock", from: payer.did, contract: accept.contract, rail: "paper", ref: "paper:test" };
  const bon = fold(hs, [mk(payer, room, lockFrame, 3, now + 3)]);
  oks.push(["accept + lock → locked", bon.state.status === "locked" && bon.state.railRef === "paper:test"]);
  const usurpe = { ...mk(payee, room, lockFrame, 4, now + 4), from: payer.did };   // signé par le payé, prétend venir du payeur
  const faux = fold(hs, [usurpe]);
  oks.push(["lock usurpé ignoré", faux.state.status === "accepted" && faux.steps.some((s) => /signature/.test(s.reason ?? ""))]);
  const horsTour = fold(hs, [mk(payee, room, { type: "reveal", from: payee.did, contract: accept.contract, secret: lock.preimage }, 5, now + 5)]);
  oks.push(["reveal avant lock refusé sans lever", horsTour.state.status === "accepted"]);
  const mauvaisSalon = fold(hs, [mk(payer, OFFER_ROOM, lockFrame, 6, now + 6)]);
  oks.push(["lock dans le mauvais salon ignoré", mauvaisSalon.state.status === "accepted"]);
  const complet = fold(hs, [mk(payer, room, lockFrame, 7, now + 7),
    mk(payee, room, { type: "reveal", from: payee.did, contract: accept.contract, secret: lock.preimage }, 8, now + 8)]);
  oks.push(["lock + reveal → claimed, secret exposé", complet.state.status === "claimed" && complet.state.secret === lock.preimage]);
  const n1 = nextNonce(); const n2 = nextNonce();
  oks.push(["nonces croissants persistés", n2 > n1]);
  for (const [nom, ok] of oks) console.log(`  ${nom.padEnd(42)} ${ok ? "reussi" : "ECHOUE"}`);
  const echecs = oks.filter(([, ok]) => !ok).length;
  console.log(`selftest deals : ${oks.length - echecs}/${oks.length}`);
  return echecs ? 1 : 0;
}

const [cmd, ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case "selftest": process.exit(cmdSelftest());
    case "board": await cmdBoard(args[0]); break;
    case "offer": await cmdOffer(args[0], args[1] ?? "PAPER", args[2] ?? "paper", args[3] ?? "unspecified job"); break;
    case "accept": await cmdAccept(args[0]); break;
    case "lock": await cmdLock(args[0]); break;
    case "deliver": await cmdDeliver(args[0], args.slice(1).join(" ")); break;
    case "reveal": await cmdReveal(args[0]); break;
    case "refund": await cmdRefund(args[0]); break;
    case "status": await cmdStatus(args[0]); break;
    case "rehearse": await cmdRehearse(); break;
    default:
      console.error(readFileSync(new URL(import.meta.url)).toString().split("\n").filter((l) => l.startsWith("//")).slice(15, 28).map((l) => l.slice(3)).join("\n"));
      process.exit(2);
  }
} catch (e) {
  journal("erreur", { cmd, detail: String(e.message ?? e).slice(0, 300) });
  console.error(e instanceof VenueError ? `la venue a refusé : ${e.message}` : e);
  process.exit(1);
}
