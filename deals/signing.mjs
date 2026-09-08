// SPDX-License-Identifier: Apache-2.0
//
// La moitié cliente de la voie signée de technocore.chat, côté Node : balayage, chaîne
// canonique, Ed25519, did:key. Port de `mcp/src/signing.ts` du dépôt officiel flop-labs/tclk,
// avec une différence : le nonce est PERSISTÉ dans data/nonce, partagé avec le client Python
// (agent/technocore.py). Une même identité écrit depuis deux processus ; le serveur exige un
// nonce croissant par clé et par salon, et un redémarrage avec une horloge en retard ferait
// refuser tout. Le fichier est la mémoire commune.
//
// La graine ne sort jamais de ce module : `signerFromEnv` rend le DID et une fonction sign().

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";

const MULTICODEC_ED25519 = Uint8Array.from([0xed, 0x01]);
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;
const CANONICAL_SIG = /^[A-Za-z0-9_-]{85}[AQgw]$/;

export const DATA_DIR = process.env.FLOP_DATA ?? "data";
const NONCE_FILE = join(DATA_DIR, "nonce");

export function sweep(text) {
  return text.replace(INVISIBLE, " ").trim();
}

export function canonicalMessage(room, nonce, sweptText) {
  return `${room}|${nonce}|${sweptText}`;
}

export function canonicalNote(ns, key, nonce, sweptValue) {
  return `${ns}|${key}|${nonce}|${sweptValue}`;
}

/** Nonce strictement croissant, persisté : lu, majoré, écrit AVANT d'être rendu. */
export function nextNonce() {
  let last = 0;
  try {
    last = Number.parseInt(readFileSync(NONCE_FILE, "utf8").trim() || "0", 10) || 0;
  } catch {
    last = 0;
  }
  const n = Math.max(Date.now(), last + 1);
  mkdirSync(dirname(NONCE_FILE), { recursive: true });
  writeFileSync(NONCE_FILE + ".tmp", String(n));
  renameSync(NONCE_FILE + ".tmp", NONCE_FILE);
  return n;
}

export function didFromPublicKey(publicKey) {
  if (publicKey.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  const multi = new Uint8Array(MULTICODEC_ED25519.length + publicKey.length);
  multi.set(MULTICODEC_ED25519, 0);
  multi.set(publicKey, MULTICODEC_ED25519.length);
  return `did:key:z${base58.encode(multi)}`;
}

export function signerFromSeed(seed) {
  if (seed.length !== 32) throw new Error(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  const did = didFromPublicKey(ed25519.getPublicKey(seed));
  return {
    did,
    sign(canonical) {
      const sig = base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed));
      if (!CANONICAL_SIG.test(sig)) throw new Error("non-canonical base64url signature produced");
      return sig;
    },
  };
}

/** La clé publique brute (32 octets) d'un did:key z6Mk…, ou null si ce n'en est pas un. */
export function publicKeyOfDid(did) {
  if (typeof did !== "string" || !did.startsWith("did:key:z")) return null;
  const mb = did.slice("did:key:".length);
  if (mb.length !== 48) return null;
  let raw;
  try {
    raw = base58.decode(mb.slice(1));
  } catch {
    return null;
  }
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) return null;
  return raw.slice(2);
}

/**
 * Un enregistrement de salon (tel que /r/<room>?format=json ou /export le rend) est-il signé
 * par le did qu'il porte ? Vérifie Ed25519 sur `<room>|<nonce>|<text>`. Ne lève jamais : un
 * faux est attendu dans un salon où n'importe qui écrit.
 */
export function verifyRecord(room, rec) {
  const pub = publicKeyOfDid(rec?.from);
  if (pub === null || rec.sig === undefined || rec.nonce === undefined || typeof rec.text !== "string") return false;
  try {
    const sig = base64urlnopad.decode(String(rec.sig));
    const msg = new TextEncoder().encode(canonicalMessage(room, String(rec.nonce), rec.text));
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

/** FLOP_SEED : 64 hex exactement (la sortie de `sign.py keygen`). Rien d'autre, jamais affiché. */
export function signerFromEnv(variable = "FLOP_SEED") {
  const spec = (process.env[variable] ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(spec)) {
    throw new Error(`${variable} doit être 64 caractères hexadécimaux (sortie de sign.py keygen)`);
  }
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) seed[i] = Number.parseInt(spec.slice(i * 2, i * 2 + 2), 16);
  return signerFromSeed(seed);
}
