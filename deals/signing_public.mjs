// SPDX-License-Identifier: Apache-2.0
//
// La moitié PUBLIQUE de la voie signée : balayage, chaîne canonique, lecture d'un did:key,
// vérification Ed25519. Tout ce qu'il faut pour LIRE la place, rien pour y écrire.
//
// Ce module existe séparément de `signing.mjs` pour une raison structurelle : l'observatoire ne
// doit pas pouvoir toucher la graine, même par accident. Ici il n'y a aucun chemin qui mène à
// FLOP_SEED, aucun accès au fichier de nonce, aucune fonction de signature. La garantie tient à
// ce qui est absent du fichier, pas à une promesse écrite dans un commentaire.
//
// Le port de référence reste `mcp/src/signing.ts` du dépôt flop-labs/tclk.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";

const MULTICODEC_ED25519 = Uint8Array.from([0xed, 0x01]);
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

/** Le texte tel que la venue le stocke : les invisibles deviennent des espaces, les bords tombent. */
export function sweep(text) {
  return String(text ?? "").replace(INVISIBLE, " ").trim();
}

/** La chaîne exacte sur laquelle porte la signature. */
export function canonicalMessage(room, nonce, sweptText) {
  return `${room}|${nonce}|${sweptText}`;
}

/** La clé publique portée par un did:key Ed25519, ou null si le DID n'en est pas un. */
export function publicKeyOfDid(did) {
  if (typeof did !== "string" || !did.startsWith("did:key:z")) return null;
  try {
    const raw = base58.decode(did.slice("did:key:z".length));
    if (raw.length !== 34 || raw[0] !== MULTICODEC_ED25519[0] || raw[1] !== MULTICODEC_ED25519[1]) return null;
    return raw.slice(2);
  } catch {
    return null;
  }
}

/**
 * Le nonce de l'enveloppe est signé comme TEXTE, mais la venue l'envoie comme NOMBRE JSON.
 * Un entier de plus de seize chiffres dépasse les 2^53 que JavaScript représente exactement :
 * `JSON.parse` l'arrondit, la chaîne reconstruite ne correspond plus à celle qui a été signée,
 * et la trame est refusée alors qu'elle est parfaitement valide.
 *
 * Mesuré le 09/09/2026 sur trois mille trames signées du tableau : les nonces de 2, 13 et 16
 * chiffres passaient tous, ceux de 19 chiffres échouaient 1 394 fois sur 1 400. Les six rescapés
 * sont ceux qui tombent pile sur une valeur représentable — à cette magnitude le pas des doubles
 * vaut 256, donc environ une valeur sur 233 survit, ce que 6/1400 prédit exactement.
 *
 * On met donc le nonce entre guillemets AVANT le parse. Le motif n'atteint que l'enveloppe : dans
 * le champ `text`, qui est une chaîne JSON, les guillemets sont échappés (`\"nonce\"`), donc un
 * nonce interne à une trame tclk1 n'est jamais touché.
 */
export function protegerNonce(json) {
  return String(json ?? "").replace(/(^|[{,])(\s*)"nonce"(\s*):(\s*)(-?\d+)(\s*)([,}])/g,
    (_, avant, e1, e2, e3, chiffres, e4, apres) => `${avant}${e1}"nonce"${e2}:${e3}"${chiffres}"${e4}${apres}`);
}

/** `JSON.parse` qui conserve le nonce de l'enveloppe tel qu'il a été signé. */
export function parseAvecNonceExact(json) {
  return JSON.parse(protegerNonce(json));
}

/** La signature d'un message par un did:key est-elle valide ? Ne lève jamais. */
export async function verifieurEd25519(did, message, signature) {
  const pub = publicKeyOfDid(did);
  if (pub === null) return false;
  try {
    return ed25519.verify(base64urlnopad.decode(String(signature)), new TextEncoder().encode(message), pub);
  } catch {
    return false;
  }
}

/** Un enregistrement de salon est-il signé par le did qu'il porte ? */
export function verifyRecord(room, rec) {
  const pub = publicKeyOfDid(rec?.from);
  if (pub === null || rec.sig === undefined || rec.nonce === undefined || typeof rec.text !== "string") return false;
  try {
    return ed25519.verify(
      base64urlnopad.decode(String(rec.sig)),
      new TextEncoder().encode(canonicalMessage(room, String(rec.nonce), rec.text)),
      pub,
    );
  } catch {
    return false;
  }
}
