// SPDX-License-Identifier: Apache-2.0
//
// Répétition, venue LOCALE seulement : un payé qui n'ouvre jamais de salon et fait tout sur le tableau,
// comme la plupart des payés observés le 08/09/2026 (le plafond global de salons de la venue laisse la
// plupart des deals sans salon). Quatre conduites, chacune avec l'issue que le payeur doit produire :
//   honest    accepte, attend le verrou sur le tableau, poste « tclk-attest <contract> » puis
//             « attested seq <seq> » puis le reveal, tout sur le tableau → reçu claimed + revue PASS
//   sniper    accepte, attend le verrou, révèle sans livrer → reçu claimed + revue FAIL
//   railonly  accepte, réclame le rail papier sans poster de reveal → reçu claimed + revue FAIL
//   ghost     accepte, ne fait plus rien → refund + reçu refunded
//
//   node deals/rehearse_payee_board.mjs <conduite> <did du payeur>

import { OFFER_ROOM, PaperRail, generateHashLock, makeAccept } from "@flop-labs/tclk";
import { signerFromEnv } from "./signing.mjs";
import { authenticate, notes, post, postText, readSince, requireLocalVenue } from "./venue.mjs";

requireLocalVenue("rehearse payee");
const conduite = process.argv[2], payeur = process.argv[3];
if (!["honest", "sniper", "railonly", "ghost"].includes(conduite) || !payeur) {
  console.error("usage: rehearse_payee_board.mjs honest|sniper|railonly|ghost <payer did>"); process.exit(2);
}
const signer = signerFromEnv();
const lock = generateHashLock();
let since = (await readSince(OFFER_ROOM, 0, 0)).lastSeq; // seules les offres postées après notre départ comptent
async function neuf() { const v = await readSince(OFFER_ROOM, since, 5); since = v.lastSeq; return v.records; }
const frames = async () => (await neuf()).map(authenticate).filter((a) => a.reason === null).map((a) => a.frame);

// 1. une offre fraîche du payeur
let offer = null;
while (!offer) for (const f of await frames()) if (f.type === "offer" && f.from === payeur && Number(f.expiresMs) > Date.now()) offer = f;
const accept = makeAccept(offer, { from: signer.did, statement: lock.hash });
await post(signer, OFFER_ROOM, accept);
console.log(`accept ${accept.contract.slice(0, 14)} (${conduite})`);

// 2. le verrou du payeur, sur le tableau (nous n'ouvrons pas de salon)
let ref = null;
const limite = Date.now() + 150_000;
while (!ref && Date.now() < limite) for (const f of await frames()) if (f.type === "lock" && f.contract === accept.contract && f.from === payeur) ref = f.ref;
if (!ref) { console.log("pas de verrou en 120 s"); process.exit(1); }
console.log(`verrou ${String(ref).slice(0, 14)}`);

// 3. la conduite
const reveal = { type: "reveal", from: signer.did, contract: accept.contract, secret: lock.preimage };
if (conduite === "honest") {
  const ligne = `tclk-attest ${accept.contract}`;
  let seqAtt = (await postText(signer, OFFER_ROOM, ligne)).seq;
  // une venue qui ne renvoie pas le seq : on relit notre propre ligne sur le tableau
  for (let i = 0; i < 10 && seqAtt == null; i++) for (const r of await neuf()) if (r.from === signer.did && r.text === ligne) seqAtt = r.seq;
  await postText(signer, OFFER_ROOM, `attested seq ${seqAtt}`);
  await post(signer, OFFER_ROOM, reveal);
  await new PaperRail(notes).claim(ref, lock.preimage);
} else if (conduite === "sniper") {
  await post(signer, OFFER_ROOM, reveal);
  await new PaperRail(notes).claim(ref, lock.preimage);
} else if (conduite === "railonly") {
  await new PaperRail(notes).claim(ref, lock.preimage);
}

// 4. le reçu et la revue du payeur, sur le tableau
const fin = Date.now() + 240_000;
let outcome = null, revue = null;
while (Date.now() < fin && (outcome === null || revue === null)) {
  for (const r of await neuf()) {
    if (r.from !== payeur) continue;
    const a = authenticate(r);
    if (a.reason === null && a.frame.type === "receipt" && a.frame.contract === accept.contract) outcome = a.frame.outcome;
    if (!a.frame && /^review /.test(r.text ?? "") && r.text.includes(accept.contract.slice(0, 18))) revue = r.text;
  }
}
console.log(JSON.stringify({ conduite, contract: accept.contract, outcome, revue }));
process.exit(outcome === null ? 1 : 0);
