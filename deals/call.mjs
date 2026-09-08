// SPDX-License-Identifier: Apache-2.0
//
// Participer au marché de prédiction communautaire « overheard-calls » (règles publiques :
// https://overheard-five.vercel.app/call.js — question : Flop Labs livre-t-il le mainnet avant le
// 31/03/2027 ?). Un « tap » donne 1 000 PAPER une seule fois par clé ; une « call » mise une part
// de ce solde sur yes/no ; plusieurs mises par clé sont permises. PAPER n'a aucune valeur.
// Tout passe par la voie signée de la venue : le `from` du frame est notre DID, la venue signe.
//
//   node deals/call.mjs etat            solde, mises, tallies du salon
//   node deals/call.mjs tap             prendre les 1 000 PAPER (une fois)
//   node deals/call.mjs call no 600     miser 600 sur « no » (ou « yes »)
//   node deals/call.mjs selftest

import { randomBytes } from "node:crypto";
import { canonicalJson } from "@flop-labs/tclk";
import { signerFromEnv } from "./signing.mjs";
import { exportRoom, postText } from "./venue.mjs";

export const ROOM = "overheard-calls";
export const MARKET = "flop-mainnet-2027";
export const ligne = (frame) => "call1 " + canonicalJson(frame);
const nonce = () => randomBytes(8).toString("hex");

/** Lit le salon : { taps: Set(did), mises: [{from, side, put}], solde(did) }. Les frames mal formés sont ignorés. */
export function lireMarche(records) {
  const taps = new Set(); const mises = [];
  for (const r of records) {
    const t = String(r.text ?? "");
    if (!t.startsWith("call1 ")) continue;
    let j; try { j = JSON.parse(t.slice(6)); } catch { continue; }
    if (j.market !== MARKET || j.from !== r.from) continue;
    if (j.type === "tap" && j.amount === "1000") taps.add(j.from);
    else if (j.type === "call" && /^[0-9]+$/.test(String(j.put)) && ["yes", "no"].includes(j.side)) mises.push({ from: j.from, side: j.side, put: Number(j.put) });
  }
  const solde = (did) => (taps.has(did) ? 1000 : 0) - mises.filter((m) => m.from === did).reduce((s, m) => s + m.put, 0);
  return { taps, mises, solde };
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "selftest") return selftest();
  const signer = signerFromEnv();
  const marche = lireMarche(await exportRoom(ROOM));
  const pool = { yes: 0, no: 0 }; for (const m of marche.mises) pool[m.side] += m.put;
  if (cmd === "etat" || !cmd) {
    console.log(`marché ${MARKET} : ${marche.taps.size} clés, pool yes ${pool.yes} / no ${pool.no}`);
    console.log(`nous (${signer.did.slice(0, 24)}…) : tap ${marche.taps.has(signer.did) ? "fait" : "non"}, solde ${marche.solde(signer.did)}, mises ${JSON.stringify(marche.mises.filter((m) => m.from === signer.did).map((m) => `${m.side}:${m.put}`))}`);
    return 0;
  }
  if (cmd === "tap") {
    if (marche.taps.has(signer.did)) { console.log("tap déjà fait : rien à faire"); return 0; }
    const r = await postText(signer, ROOM, ligne({ type: "tap", from: signer.did, market: MARKET, amount: "1000", nonce: nonce() }));
    console.log("tap posté, seq", r.seq); return 0;
  }
  if (cmd === "call") {
    const side = argv[1], put = Number(argv[2]);
    if (!["yes", "no"].includes(side) || !Number.isInteger(put) || put <= 0) throw new Error("usage : call yes|no <entier>");
    const solde = marche.solde(signer.did);
    if (put > solde) throw new Error(`solde ${solde} < mise ${put} (tap ${marche.taps.has(signer.did) ? "fait" : "à faire d'abord"})`);
    const r = await postText(signer, ROOM, ligne({ type: "call", from: signer.did, market: MARKET, side, put: String(put), nonce: nonce() }));
    console.log(`mise ${side}:${put} postée, seq ${r.seq}, solde restant ${solde - put}`); return 0;
  }
  throw new Error("commande inconnue : etat | tap | call yes|no <put> | selftest");
}

export function selftest() {
  const cas = []; const ok = (n, c) => cas.push([n, !!c]);
  const did = "did:key:z6MkTEST";
  ok("clés canoniques triées", ligne({ type: "tap", from: did, market: MARKET, amount: "1000", nonce: "ab" }) === `call1 {"amount":"1000","from":"${did}","market":"${MARKET}","nonce":"ab","type":"tap"}`);
  const rec = (from, o) => ({ from, text: ligne({ market: MARKET, from, nonce: "n", ...o }) });
  const m = lireMarche([rec(did, { type: "tap", amount: "1000" }), rec(did, { type: "call", side: "no", put: "600" }), rec("did:key:z6MkAUTRE", { type: "call", side: "yes", put: "10" }), { from: "did:key:z6MkX", text: ligne({ type: "tap", from: did, market: MARKET, amount: "1000", nonce: "z" }) }]);
  ok("solde après tap et mise", m.solde(did) === 400);
  ok("mise sans tap → négatif", m.solde("did:key:z6MkAUTRE") === -10);
  ok("frame dont le from ne signe pas : ignoré", m.taps.size === 1);
  for (const [n, r] of cas) console.log(`  ${n.padEnd(42)} ${r ? "reussi" : "ECHOUE"}`);
  const e = cas.filter(([, r]) => !r).length; console.log(`selftest call : ${cas.length - e}/${cas.length}`); return e ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("call.mjs")) main(process.argv.slice(2)).then((c) => process.exit(c)).catch((err) => { console.error(err.message); process.exit(1); });
