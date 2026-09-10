#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Le canal de calcul FLOP, côté agent : l'Appendix F du yellowpaper FLOP v0.5 (codec F.0,
// préimages F.1, attestation F.2, transcription F.3, disponibilité F.4).
//
// Adapté de l'encodeur de référence officiel `evidence/compute-channel.py`, et prouvé contre le
// corpus officiel `evidence/wire-format-v1.json` : deux fichiers de FLOP Labs, dépôt public
// https://github.com/flop-labs/yellowpaper, sous licence CC BY 4.0
// (https://creativecommons.org/licenses/by/4.0/). Changements : traduction en JavaScript, les
// écarts listés plus bas, et des fonctions au-delà de la référence. Le corpus est embarqué en fin
// de fichier sans aucune modification ; le selftest recalcule son sha256 avant de s'en servir.
// Copies relevées le 10/09/2026, identiques octet pour octet à la version publiée le 11/09/2026 :
//   compute-channel.py   sha256 7a7ad29bffa6a9c3f143eb929225db858a5b9fe56374684f3a1b2d57e9047d28
//   wire-format-v1.json  sha256 80d4a7e70f984342eb474ae5285a17a6b9348eca887e1689b15e641922051d93
//
// Même découpage et mêmes noms que la référence (fonctions, champs, messages de refus), pour lire
// les deux fichiers côte à côte. Octets : Uint8Array. Entiers : un BigInt est accepté partout et
// rendu pour u64/u128 ; un Number n'est accepté que s'il est un entier exactement représentable,
// car F.0 interdit l'arrondi. Un tuple Python devient un tableau [a, b], None devient null.
//
// Écarts volontaires, tous plus stricts que la référence, qui compte sur ses types :
//   1. une version de feuille hors de 0..3 est refusée partout ("unsupported leaf version"). La
//      référence construit sans rien dire une préimage de forme V2 pour la version 4, écrit
//      l'octet 07 dans un VerifiedTurn, et traite une étiquette 7 comme V3 dans l'encodeur FCC4.
//   2. l'orientation d'un chemin de Merkle doit être un booléen : la référence écrirait 02, qu'un
//      décodeur doit refuser (F.0 : un bool vaut 00 ou 01).
//   3. un booléen n'est pas un entier (en Python, True vaut 1).
// Tout le reste est reproduit, bizarreries comprises : un blob FCC4 qui s'arrête pile avant un tour
// est refusé avec "unsupported leaf version", parce que la référence lit cet octet dans le même
// try/except que la conversion de l'étiquette en énumération.
//
// Au-delà de la référence, écrit depuis le texte de l'Appendix F et prouvé par le corpus : décodage
// d'un VerifiedTurn (F.3) ; vérification d'un tour et d'un lot de tours (coupure de version,
// cohérence, politique, signature de l'enclave, appartenance, indices distincts, somme contrôlée) ;
// reçus v1 et hérités ; DecodePolicy v1 et report_data v1 (F.1) ; ValidatorAttestation v1 (F.2) ;
// DataRef v1 (F.4). Un refus porte `code` quand le corpus ou le yellowpaper nomme l'erreur du
// runtime ; sinon `code` vaut null, on n'invente pas de nom.
//
// Une règle n'est écrite nulle part, mais le corpus l'exige : refuser un chemin qui prouve la copie
// d'un nœud impair dupliqué. Le cas négatif wrong_path_orientation retourne l'orientation d'un frère
// qui est la feuille elle-même (dernier nœud d'un niveau impair, donc dupliqué) : hash_pair(V3, V3)
// ne dépend pas de l'ordre, la racine recalculée ne bouge pas, et root_from_path de la référence
// accepte ce cas que le corpus attend refusé (LeafNotInRoot). Un frère identique au nœud courant et
// placé à gauche ne peut désigner que cette copie fantôme ; le refuser n'empêche de prouver aucune
// vraie feuille. root_from_path reste fidèle à la référence ; la règle vit dans verify_turn_proof.
//
// Signatures : sr25519, contexte de signature Substrate "substrate" (F.0), celui qu'applique
// @scure/sr25519. Mesuré le 11/09/2026 sur les sept signatures distinctes du corpus, contre chaque
// message candidat (empreintes de feuille, préimages, message de reçu v1, message hérité, et le
// blake2_256 de chacun) et chaque clé publique :
//   v3_leaf_signature          l'empreinte de feuille V3 de 32 octets ; ni la préimage, ni le hash
//                              de l'empreinte (c'est aussi l'enclave_sig du blob FCC4 et des tours)
//   enclave_sig du tour V1     (cas legacy_leaf_current_channel) l'empreinte de feuille V1
//   receipt.signature          les 125 octets du message de reçu v1 tels quels, pas leur blake2_256
//   signature du reçu hérité   (cas legacy_receipt_current_channel) les 96 octets hérités
//   validator_signature        les 179 octets signables de l'attestation tels quels
//   les deux signatures au premier octet retourné : aucun message, aucune clé
// Aucune ne vérifie en ed25519. Les trois clés publiques du corpus (enclave, reçu, validateur) sont
// une seule et même clé : le corpus ne peut pas prouver qu'un vérificateur prend la clé du bon rôle.
// @scure/sr25519 lève si le marqueur Schnorrkel manque ou si la clé n'est pas un point ristretto255
// (c'est le cas des comptes 0x11... et 0x22... du corpus) : sr25519_verify, lui, ne lève jamais.
//
// Commande :
//   node deals/canal.mjs selftest    corpus officiel, signatures et nos cas négatifs, sans réseau

import { pathToFileURL } from "node:url";

import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as sr25519 from "@scure/sr25519";

/** Un refus. `message` : celui de la référence ; `code` : le nom de l'erreur du runtime, s'il est publié. */
export class CanalError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "CanalError";
    this.code = code;
  }
}

// ----- constantes (F.1, F.3) -----

const ascii = (texte) => new TextEncoder().encode(texte);

// Les calculs lisent ces copies privées : modifier une constante exportée ne change aucun hash.
const DOMAINE_ID = ascii("FLOP/COMPUTE_CHANNEL/ID");
const DOMAINE_RECU = ascii("FLOP/COMPUTE_CHANNEL/RECEIPT");
const DOMAINE_TACHE = ascii("FLOP/POUI/TASK");
const MAGIE_FCC4 = ascii("FCC4");
const DOMAINE_POLITIQUE = ascii("FLOP_DECODE_POLICY_HASH_V1");

export const CHANNEL_ID_DOMAIN_V1 = ascii("FLOP/COMPUTE_CHANNEL/ID");
export const RECEIPT_DOMAIN = ascii("FLOP/COMPUTE_CHANNEL/RECEIPT");
export const TASK_HASH_DOMAIN_V1 = ascii("FLOP/POUI/TASK");
export const TRANSCRIPT_BLOB_MAGIC = ascii("FCC4");
export const DECODE_POLICY_DOMAIN_V1 = ascii("FLOP_DECODE_POLICY_HASH_V1");

export const TranscriptLeafVersion = Object.freeze({ V0: 0, V1: 1, V2: 2, V3: 3 });

// Bornes d'un règlement, valeurs du tableau des paramètres du yellowpaper
// (channel_max_settlement_turns, channel_max_merkle_path_len).
export const CHANNEL_MAX_SETTLEMENT_TURNS = 1024;
export const CHANNEL_MAX_MERKLE_PATH_LEN = 64;

// ChannelWireProfiles[channel_id] = 1 : le canal exige le reçu v1 (F.3). null : le marqueur est absent.
export const WIRE_PROFILE_V1 = 1;

const U128_MAX = (1n << 128n) - 1n;

// ----- aides privées, calquées sur celles de la référence -----

function _fixed(value, length, name) {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new CanalError(`${name} must be ${length} bytes`);
  return value;
}

function _uint_le(value, length, name) {
  const bits = length * 8;
  let v = null;
  if (typeof value === "bigint") v = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) v = BigInt(value);
  if (v === null || v < 0n || v >= 1n << BigInt(bits)) throw new CanalError(`${name} does not fit u${bits}`);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function _join(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const _concat = (...parts) => _join(parts);

// Une copie, jamais une vue : un Buffer de Node partage sa mémoire quand on le découpe.
const _copy = (bytes) => new Uint8Array(bytes);

function _equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** `any()` de Python sur des octets : au moins un octet non nul. */
const _any = (bytes) => Array.prototype.some.call(bytes, (b) => b !== 0);

/** `x or bytes(32)` de Python : None et les octets vides valent 32 zéros. */
const _or_zero = (value) => (value == null || value.length === 0 ? new Uint8Array(32) : value);

function _read_le(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function _leaf_version(version) {
  if (!Number.isInteger(version) || version < 0 || version > 3) throw new CanalError("unsupported leaf version");
  return version;
}

// ----- port de compute-channel.py, fonction par fonction -----

/** blake2b à 32 octets, sans clé ni personnalisation (F.0). */
export function blake2_256(value) {
  return blake2b(value, { dkLen: 32 });
}

/** Compact<u32> SCALE canonique : un octet sous 2^6, deux sous 2^14, quatre sous 2^30, sinon 03 || u32LE. */
export function compact_u32(value) {
  _uint_le(value, 4, "compact value");
  const v = BigInt(value);
  if (v < 1n << 6n) return Uint8Array.of(Number(v << 2n));
  if (v < 1n << 14n) return _uint_le((v << 2n) | 1n, 2, "compact value");
  if (v < 1n << 30n) return _uint_le((v << 2n) | 2n, 4, "compact value");
  return _concat(Uint8Array.of(3), _uint_le(v, 4, "compact value"));
}

/**
 * Lit un Compact<u32> à `offset` et rend [valeur, fin]. Refuse le tronqué, le plus large que u32 et
 * toute forme non minimale (F.0), dans l'ordre de la référence.
 */
export function decode_compact_u32(data, offset = 0) {
  if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative integer");
  if (offset >= data.length) throw new CanalError("truncated compact integer");
  const first = data[offset];
  const mode = first & 3;
  const size = [1, 2, 4, (first >> 2) + 5][mode];
  const end = offset + size;
  if (end > data.length) throw new CanalError("truncated compact integer");
  let value;
  if (mode === 0) value = first >> 2;
  else if (mode === 1 || mode === 2) value = Number(_read_le(data.subarray(offset, end)) >> 2n);
  else {
    const payload = _read_le(data.subarray(offset + 1, end));
    if (size !== 5 || payload > 0xffff_ffffn) throw new CanalError("compact integer exceeds u32");
    value = Number(payload);
  }
  if (!_equal(data.subarray(offset, end), compact_u32(value))) throw new CanalError("non-canonical compact integer");
  return [value, end];
}

/** channel_id v1 (F.1) : blake2_256("FLOP/COMPUTE_CHANNEL/ID" || 01 || genesis || agent || miner || nonce:u64LE). */
export function channel_id_v1(genesis_hash, agent, miner, nonce) {
  return blake2_256(_concat(
    DOMAINE_ID,
    Uint8Array.of(1),
    _fixed(genesis_hash, 32, "genesis_hash"),
    _fixed(agent, 32, "agent"),
    _fixed(miner, 32, "miner"),
    _uint_le(nonce, 8, "nonce"),
  ));
}

/** task_hash v1 du rail direct (F.1), dérivé par le producteur. */
export function task_hash_v1(genesis_hash, agent, nonce, model_hash, payload_hash, commit_hash) {
  return blake2_256(_concat(
    DOMAINE_TACHE,
    Uint8Array.of(1),
    _fixed(genesis_hash, 32, "genesis_hash"),
    _fixed(agent, 32, "agent"),
    _uint_le(nonce, 8, "nonce"),
    _fixed(model_hash, 32, "model_hash"),
    _fixed(payload_hash, 32, "payload_hash"),
    _fixed(commit_hash, 32, "commit_hash"),
  ));
}

/** h_ids : blake2_256(u32LE(n) || ids du prompt || u32LE(m) || ids générés), chaque id en u32LE. */
export function h_ids(prompt_ids, generated_ids) {
  const parts = [_uint_le(prompt_ids.length, 4, "prompt length")];
  for (const token of prompt_ids) parts.push(_uint_le(token, 4, "token id"));
  parts.push(_uint_le(generated_ids.length, 4, "generated length"));
  for (const token of generated_ids) parts.push(_uint_le(token, 4, "token id"));
  return blake2_256(_join(parts));
}

// Les onze champs d'une feuille, exigés au complet comme par la signature Python de leaf_preimage ;
// ceux que la version n'utilise pas ne sont pas lus. Attention : ids_hash ici, h_ids dans un tour.
const CHAMPS_FEUILLE = ["channel_id", "turn_index", "h_in", "h_out", "g_n", "decode_policy_hash", "ids_hash",
  "toploc_commitment_hash", "miner_recv_ms", "miner_done_ms", "latency_ms"];

/** La préimage de feuille de la version choisie (F.3) : 116, 140, 172 ou 236 octets. */
export function leaf_preimage(version, fields) {
  _leaf_version(version);
  if (fields === null || typeof fields !== "object") throw new TypeError("leaf fields must be an object");
  for (const k of CHAMPS_FEUILLE) if (!(k in fields)) throw new TypeError(`missing leaf field: ${k}`);
  for (const k of Object.keys(fields)) if (!CHAMPS_FEUILLE.includes(k)) throw new TypeError(`unexpected leaf field: ${k}`);
  const parts = [
    _fixed(fields.channel_id, 32, "channel_id"),
    _uint_le(fields.turn_index, 4, "turn_index"),
    _fixed(fields.h_in, 32, "h_in"),
    _fixed(fields.h_out, 32, "h_out"),
    _uint_le(fields.g_n, 16, "g_n"),
  ];
  if (version >= 2) parts.push(_fixed(fields.decode_policy_hash, 32, "decode_policy_hash"));
  if (version === 3) {
    parts.push(_fixed(fields.ids_hash, 32, "h_ids"));
    parts.push(_fixed(fields.toploc_commitment_hash, 32, "toploc_commitment_hash"));
  }
  if (version >= 1) {
    parts.push(_uint_le(fields.miner_recv_ms, 8, "miner_recv_ms"));
    parts.push(_uint_le(fields.miner_done_ms, 8, "miner_done_ms"));
    parts.push(_uint_le(fields.latency_ms, 8, "latency_ms"));
  }
  return _join(parts);
}

/** L'empreinte de feuille : blake2_256 de la préimage, sans préfixe. C'est elle que l'enclave signe. */
export function transcript_leaf(version, fields) {
  return blake2_256(leaf_preimage(version, fields));
}

/**
 * Le reçu v1 que l'agent signe (F.3), 125 octets :
 * "FLOP/COMPUTE_CHANNEL/RECEIPT" || 01 || channel_id || final_root || aggregate_gn:u128LE || payable:u128LE.
 */
export function receipt_message_v1(channel_id, final_root, aggregate_gn, payable) {
  return _concat(
    DOMAINE_RECU,
    Uint8Array.of(1),
    _fixed(channel_id, 32, "channel_id"),
    _fixed(final_root, 32, "final_root"),
    _uint_le(aggregate_gn, 16, "aggregate_gn"),
    _uint_le(payable, 16, "payable"),
  );
}

/** Le reçu historique non étiqueté, 96 octets, des canaux sans marqueur de profil. */
export function legacy_receipt_message(channel_id, final_root, aggregate_gn, payable) {
  return _concat(
    _fixed(channel_id, 32, "channel_id"),
    _fixed(final_root, 32, "final_root"),
    _uint_le(aggregate_gn, 16, "aggregate_gn"),
    _uint_le(payable, 16, "payable"),
  );
}

/** Un nœud de Merkle : blake2_256(gauche || droite), 64 octets sans préfixe. */
export function hash_pair(left, right) {
  return blake2_256(_concat(_fixed(left, 32, "left"), _fixed(right, 32, "right")));
}

/** Racine de Merkle : 32 zéros si vide, la feuille elle-même si unique, le dernier nœud impair dupliqué. */
export function merkle_root(leaves) {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = leaves.map((leaf) => _fixed(leaf, 32, "leaf"));
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(hash_pair(level[i], level[i + 1]));
    level = next;
  }
  return _copy(level[0]);
}

/** Le chemin d'authentification d'une feuille : des paires [frère, frère_à_gauche], vers la racine. */
export function merkle_path(leaves, index) {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new CanalError("leaf index out of range");
  let level = leaves.map((leaf) => _fixed(leaf, 32, "leaf"));
  const path = [];
  let i = index;
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]);
    const sibling = i % 2 ? i - 1 : i + 1;
    path.push([_copy(level[sibling]), i % 2 === 1]);
    const next = [];
    for (let k = 0; k < level.length; k += 2) next.push(hash_pair(level[k], level[k + 1]));
    level = next;
    i = Math.floor(i / 2);
  }
  return path;
}

/** Remonte un chemin de la feuille à la racine. */
export function root_from_path(leaf, path) {
  let current = _fixed(leaf, 32, "leaf");
  for (const [sibling, sibling_is_left] of path) {
    current = sibling_is_left ? hash_pair(sibling, current) : hash_pair(current, sibling);
  }
  return _copy(current);
}

/**
 * Un tour au format de la référence (TurnRecord) :
 *   { leaf_version, turn_index, h_in, h_out, g_n, decode_policy_hash, h_ids, toploc_commitment_hash,
 *     miner_recv_ms, miner_done_ms, latency_ms, enclave_sig, agent_ack }
 * où les trois empreintes facultatives valent null quand elles sont absentes, et agent_ack vaut null
 * ou { agent_send_ms, agent_recv_ms, agent_sig } (TurnAckRecord).
 *
 * Cohérence d'un tour avec sa version (`_check_record` de la référence, règle FCC4 de F.3) : V0/V1
 * sans politique ni champs V3 non nuls, V2 avec politique et champs V3 nuls, V3 avec politique et
 * h_ids non nul. Une politique « présente » est non null ; un h_ids ou un toploc nul vaut absent.
 */
export function check_record(record) {
  const version = _leaf_version(record.leaf_version);
  const ids_nonzero = record.h_ids != null && _any(record.h_ids);
  const toploc_nonzero = record.toploc_commitment_hash != null && _any(record.toploc_commitment_hash);
  const sans_politique = record.decode_policy_hash == null;
  if (version === 0 || version === 1) {
    if (!sans_politique || ids_nonzero || toploc_nonzero) throw new CanalError("V0/V1 fields are inconsistent");
  } else if (version === 2) {
    if (sans_politique || ids_nonzero || toploc_nonzero) throw new CanalError("V2 fields are inconsistent");
  } else if (sans_politique || !ids_nonzero) {
    throw new CanalError("V3 fields are inconsistent");
  }
}

/** Le conteneur de transcription FCC4 (F.3, « DA transcript container »). */
export function encode_transcript_blob(channel_id, turns) {
  const parts = [MAGIE_FCC4, _fixed(channel_id, 32, "channel_id"), _uint_le(turns.length, 4, "turn count")];
  for (const turn of turns) {
    check_record(turn);
    parts.push(Uint8Array.of(turn.leaf_version), _uint_le(turn.turn_index, 4, "turn_index"));
    parts.push(_fixed(turn.h_in, 32, "h_in"), _fixed(turn.h_out, 32, "h_out"));
    parts.push(_uint_le(turn.g_n, 16, "g_n"));
    const a_politique = turn.decode_policy_hash != null;
    parts.push(Uint8Array.of(a_politique ? 1 : 0));
    if (a_politique) parts.push(_fixed(turn.decode_policy_hash, 32, "decode_policy_hash"));
    parts.push(_fixed(_or_zero(turn.h_ids), 32, "h_ids"));
    parts.push(_fixed(_or_zero(turn.toploc_commitment_hash), 32, "toploc_commitment_hash"));
    parts.push(_uint_le(turn.miner_recv_ms, 8, "miner_recv_ms"));
    parts.push(_uint_le(turn.miner_done_ms, 8, "miner_done_ms"));
    parts.push(_uint_le(turn.latency_ms, 8, "latency_ms"));
    parts.push(_fixed(turn.enclave_sig, 64, "enclave_sig"));
    const a_ack = turn.agent_ack != null;
    parts.push(Uint8Array.of(a_ack ? 1 : 0));
    if (a_ack) {
      parts.push(_uint_le(turn.agent_ack.agent_send_ms, 8, "agent_send_ms"));
      parts.push(_uint_le(turn.agent_ack.agent_recv_ms, 8, "agent_recv_ms"));
      parts.push(_fixed(turn.agent_ack.agent_sig, 64, "agent_sig"));
    }
  }
  return _join(parts);
}

/** Décode un FCC4 en consommant tout et rend [channel_id, tours] ; un blob historique exige un outil de migration. */
export function decode_transcript_blob(data) {
  if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
  let offset = 0;
  const take = (length) => {
    const end = offset + length;
    if (end > data.length) throw new CanalError("truncated transcript blob");
    const value = _copy(data.subarray(offset, end));
    offset = end;
    return value;
  };
  if (!_equal(take(4), MAGIE_FCC4)) throw new CanalError("unsupported transcript blob version");
  const channel_id = take(32);
  const count = Number(_read_le(take(4)));
  const turns = [];
  for (let n = 0; n < count; n += 1) {
    // Fidèle à la référence : elle lit cet octet dans le try/except qui convertit l'étiquette en
    // énumération, si bien qu'un blob arrêté pile avant un tour sort "unsupported leaf version" et
    // non "truncated transcript blob".
    if (offset >= data.length) throw new CanalError("unsupported leaf version");
    const leaf_version = take(1)[0];
    if (leaf_version > 3) throw new CanalError("unsupported leaf version");
    const turn_index = Number(_read_le(take(4)));
    const h_in = take(32);
    const h_out = take(32);
    const g_n = _read_le(take(16));
    const has_policy = take(1)[0];
    if (has_policy !== 0 && has_policy !== 1) throw new CanalError("invalid option tag");
    const policy = has_policy ? take(32) : null;
    const ids = take(32);
    const toploc = take(32);
    const miner_recv_ms = _read_le(take(8));
    const miner_done_ms = _read_le(take(8));
    const latency_ms = _read_le(take(8));
    const enclave_sig = take(64);
    const has_ack = take(1)[0];
    if (has_ack !== 0 && has_ack !== 1) throw new CanalError("invalid option tag");
    let agent_ack = null;
    if (has_ack) agent_ack = { agent_send_ms: _read_le(take(8)), agent_recv_ms: _read_le(take(8)), agent_sig: take(64) };
    const record = {
      leaf_version, turn_index, h_in, h_out, g_n,
      decode_policy_hash: policy,
      h_ids: _any(ids) ? ids : null,
      toploc_commitment_hash: _any(toploc) ? toploc : null,
      miner_recv_ms, miner_done_ms, latency_ms, enclave_sig, agent_ack,
    };
    check_record(record);
    turns.push(record);
  }
  if (offset !== data.length) throw new CanalError("trailing transcript blob bytes");
  return [channel_id, turns];
}

/** Encodage SCALE du VerifiedTurn du runtime (F.3) : 269 + compact_len(L) + 33L octets pour un chemin de L. */
export function encode_verified_turn(record, path) {
  _leaf_version(record.leaf_version);
  const parts = [Uint8Array.of(record.leaf_version), _uint_le(record.turn_index, 4, "turn_index")];
  parts.push(_fixed(record.h_in, 32, "h_in"), _fixed(record.h_out, 32, "h_out"));
  parts.push(_uint_le(record.g_n, 16, "g_n"));
  parts.push(_fixed(_or_zero(record.decode_policy_hash), 32, "decode_policy_hash"));
  parts.push(_fixed(_or_zero(record.h_ids), 32, "h_ids"));
  parts.push(_fixed(_or_zero(record.toploc_commitment_hash), 32, "toploc_commitment_hash"));
  parts.push(_uint_le(record.miner_recv_ms, 8, "miner_recv_ms"));
  parts.push(_uint_le(record.miner_done_ms, 8, "miner_done_ms"));
  parts.push(_uint_le(record.latency_ms, 8, "latency_ms"));
  parts.push(_fixed(record.enclave_sig, 64, "enclave_sig"), compact_u32(path.length));
  for (const [sibling, sibling_is_left] of path) {
    parts.push(_fixed(sibling, 32, "path sibling"));
    if (typeof sibling_is_left !== "boolean") throw new CanalError("path orientation must be a boolean");
    parts.push(Uint8Array.of(sibling_is_left ? 1 : 0));
  }
  return _join(parts);
}

// ----- au-delà de la référence : lecture SCALE (F.0, F.3, F.4) -----

function _lecteur(data, what) {
  if (!(data instanceof Uint8Array)) throw new TypeError(`${what} must be a Uint8Array`);
  let offset = 0;
  const l = {
    take(length) {
      const end = offset + length;
      if (end > data.length) throw new CanalError(`truncated ${what}`);
      const value = _copy(data.subarray(offset, end));
      offset = end;
      return value;
    },
    u8: () => l.take(1)[0],
    bool() {
      const b = l.u8();
      if (b > 1) throw new CanalError("invalid bool");
      return b === 1;
    },
    compact() {
      const [value, end] = decode_compact_u32(data, offset);
      offset = end;
      return value;
    },
    fin() {
      if (offset !== data.length) throw new CanalError(`trailing ${what} bytes`);
    },
  };
  return l;
}

/** Un bool SCALE (F.0) : 00 ou 01, toute autre valeur est refusée. */
export function decode_scale_bool(data) {
  const l = _lecteur(data, "bool");
  const v = l.bool();
  l.fin();
  return v;
}

/** L'énumération TranscriptLeafVersion seule (F.3) : une étiquette inconnue est refusée au décodage. */
export function decode_leaf_version(data) {
  const l = _lecteur(data, "leaf version");
  const v = l.u8();
  if (v > 3) throw new CanalError("unsupported leaf version");
  l.fin();
  return v;
}

const _ou_null = (bytes) => (_any(bytes) ? bytes : null);

function _lire_tour(l) {
  const leaf_version = l.u8();
  if (leaf_version > 3) throw new CanalError("unsupported leaf version");
  const record = {
    leaf_version,
    turn_index: Number(_read_le(l.take(4))),
    h_in: l.take(32),
    h_out: l.take(32),
    g_n: _read_le(l.take(16)),
    decode_policy_hash: _ou_null(l.take(32)),
    h_ids: _ou_null(l.take(32)),
    toploc_commitment_hash: _ou_null(l.take(32)),
    miner_recv_ms: _read_le(l.take(8)),
    miner_done_ms: _read_le(l.take(8)),
    latency_ms: _read_le(l.take(8)),
    enclave_sig: l.take(64),
    agent_ack: null,
  };
  const n = l.compact();
  const path = [];
  for (let i = 0; i < n; i += 1) {
    const sibling = l.take(32);
    path.push([sibling, l.bool()]);
  }
  return [record, path];
}

/**
 * Décode un VerifiedTurn en consommant tout et rend [tour, chemin]. Une empreinte nulle redevient
 * null, l'inverse exact de encode_verified_turn : check_record applique alors la règle FCC4 aux
 * champs fixes du tour. C'est notre lecture : F.3 nomme LeafFieldsInconsistent sans écrire la règle
 * propre au VerifiedTurn.
 */
export function decode_verified_turn(data) {
  const l = _lecteur(data, "verified turn");
  const tour = _lire_tour(l);
  l.fin();
  return tour;
}

/** Le Vec<VerifiedTurn> SCALE d'un règlement : [[tour, chemin], ...]. */
export function decode_verified_turns(data) {
  const l = _lecteur(data, "verified turns");
  const n = l.compact();
  const tours = [];
  for (let i = 0; i < n; i += 1) tours.push(_lire_tour(l));
  l.fin();
  return tours;
}

// ----- au-delà de la référence : signatures et vérification (F.0, F.2, F.3) -----

/** sr25519, contexte "substrate" (F.0). Ne lève jamais : clé, signature ou marqueur mal formés donnent false. */
export function sr25519_verify(message, signature, public_key) {
  if (!(message instanceof Uint8Array) || !(signature instanceof Uint8Array) || !(public_key instanceof Uint8Array)) return false;
  if (signature.length !== 64 || public_key.length !== 32) return false;
  try {
    return sr25519.verify(message, signature, public_key) === true;
  } catch {
    return false;
  }
}

/** Les champs de feuille d'un tour, pour transcript_leaf : le h_ids du tour devient ids_hash. */
export function leaf_fields(channel_id, record) {
  return {
    channel_id,
    turn_index: record.turn_index,
    h_in: record.h_in,
    h_out: record.h_out,
    g_n: record.g_n,
    decode_policy_hash: record.decode_policy_hash,
    ids_hash: record.h_ids,
    toploc_commitment_hash: record.toploc_commitment_hash,
    miner_recv_ms: record.miner_recv_ms,
    miner_done_ms: record.miner_done_ms,
    latency_ms: record.latency_ms,
  };
}

/**
 * Le message de reçu qu'exige le canal (F.3) : le v1 si ChannelWireProfiles vaut 1, le reçu hérité
 * de 96 octets si le marqueur est absent (null), un refus pour toute autre valeur (« fails closed »).
 */
export function receipt_message_for_profile(wire_profile, channel_id, final_root, aggregate_gn, payable) {
  if (wire_profile === WIRE_PROFILE_V1) return receipt_message_v1(channel_id, final_root, aggregate_gn, payable);
  if (wire_profile == null) return legacy_receipt_message(channel_id, final_root, aggregate_gn, payable);
  throw new CanalError("unknown wire profile");
}

/**
 * Le reçu de l'agent, comme `verify_receipt` du runtime : le message du profil du canal, signé
 * tel quel (pas son hash) par agent_key. Rend true, ou lève BadReceiptSignature.
 */
export function verify_receipt(receipt, signature, agent_key, wire_profile = WIRE_PROFILE_V1) {
  const message = receipt_message_for_profile(wire_profile, receipt.channel_id, receipt.final_root,
    receipt.aggregate_gn, receipt.payable);
  if (!sr25519_verify(message, signature, agent_key)) throw new CanalError("bad receipt signature", "BadReceiptSignature");
  return true;
}

/**
 * Un tour prouvé, dans l'ordre de `verify_turn_proof` / `respond_dispute` tel que le corpus le
 * contraint : coupure de version, cohérence, politique épinglée, borne du chemin, signature de
 * l'enclave sur l'empreinte de feuille de 32 octets, appartenance à la racine. Rend l'empreinte.
 * `channel` : { channel_id, final_root, enclave_key, decode_policy_hash }, ce dernier à null quand
 * le canal n'a pas de marqueur ChannelDecodePolicies (il accepte alors V0 à V3).
 * La cohérence passe avant la signature : sinon le cas wrong_leaf_version du corpus sortirait en
 * mauvaise signature au lieu de LeafFieldsInconsistent.
 */
export function verify_turn_proof(record, path, channel) {
  const version = _leaf_version(record.leaf_version);
  const epinglee = channel.decode_policy_hash ?? null;
  if (epinglee !== null && version < 2) {
    throw new CanalError("leaf version not accepted on this channel", "UnsupportedLeafVersion");
  }
  try {
    check_record(record);
  } catch (e) {
    if (e instanceof CanalError) throw new CanalError(e.message, "LeafFieldsInconsistent");
    throw e;
  }
  if (epinglee !== null
    && !_equal(_fixed(record.decode_policy_hash, 32, "decode_policy_hash"), _fixed(epinglee, 32, "channel decode_policy_hash"))) {
    throw new CanalError("decode policy mismatch");
  }
  if (path.length > CHANNEL_MAX_MERKLE_PATH_LEN) throw new CanalError("merkle path too long", "MerklePathTooLong");
  const feuille = transcript_leaf(version, leaf_fields(channel.channel_id, record));
  if (!sr25519_verify(feuille, record.enclave_sig, channel.enclave_key)) throw new CanalError("bad turn signature");
  // root_from_path, plus une règle : la copie d'un nœud impair est toujours à droite de l'original,
  // donc un frère identique au nœud courant et placé à gauche prouve une position fantôme (voir
  // l'en-tête). La racine seule ne le voit pas, puisque hash_pair(x, x) ne dépend pas de l'ordre.
  let courant = feuille;
  for (const [sibling, sibling_is_left] of path) {
    if (sibling_is_left && _equal(_fixed(sibling, 32, "left"), courant)) {
      throw new CanalError("leaf not in root: path proves the copy of an odd last node", "LeafNotInRoot");
    }
    courant = sibling_is_left ? hash_pair(sibling, courant) : hash_pair(courant, sibling);
  }
  if (!_equal(courant, _fixed(channel.final_root, 32, "final_root"))) throw new CanalError("leaf not in root", "LeafNotInRoot");
  return feuille;
}

/**
 * La somme contrôlée des g_n de tours distincts (F.3, `verified_work_from_turns`). Chaque tour est
 * prouvé, puis un turn_index déjà vu lève DuplicateVerifiedTurn AVANT l'addition : le corpus répète
 * un tour dont g_n vaut u128::MAX, et une somme faite d'abord déborderait en masquant la vraie
 * raison. Avec aggregate_gn, l'égalité est exigée (AggregateGnMismatch). Rend la somme, en BigInt.
 */
export function verified_work_from_turns(turns, channel, aggregate_gn = undefined) {
  if (turns.length > CHANNEL_MAX_SETTLEMENT_TURNS) throw new CanalError("too many settlement turns", "TooManySettlementTurns");
  const vus = new Set();
  let somme = 0n;
  for (const [record, path] of turns) {
    verify_turn_proof(record, path, channel);
    const indice = BigInt(record.turn_index);
    if (vus.has(indice)) throw new CanalError("duplicate verified turn", "DuplicateVerifiedTurn");
    vus.add(indice);
    somme += BigInt(record.g_n);
    if (somme > U128_MAX) throw new CanalError("aggregate g_n overflows u128");
  }
  if (aggregate_gn !== undefined && somme !== _read_le(_uint_le(aggregate_gn, 16, "aggregate_gn"))) {
    throw new CanalError("aggregate g_n mismatch", "AggregateGnMismatch");
  }
  return somme;
}

// ----- au-delà de la référence : DecodePolicy v1 et report_data v1 (F.1) -----

export const DecodePolicyClass = Object.freeze({ TextGeneration: 0, ImageDenoise: 1, Rollout: 2, ControlLoop: 3, Other: 4 });
export const TeeType = Object.freeze({ IntelTdx: 0, NvidiaHopperCc: 1, NvidiaRubinCc: 2, Simulator: 3 });

function _classe(c) {
  if (Number.isInteger(c) && c >= 0 && c <= 3) return Uint8Array.of(c);
  if (c !== null && typeof c === "object" && "other" in c) return _concat(Uint8Array.of(4), _uint_le(c.other, 2, "class other"));
  throw new CanalError("unknown decode policy class");
}

/**
 * SCALE(DecodePolicy) v1 (F.1) : version:u16(1), class, tokenizer_hash, SamplingParams,
 * stop_conditions_hash, output_transform, class_policy_hash. `class` vaut 0..3 ou { other: u16 } ;
 * `output_transform` vaut null (Identity) ou une empreinte de 32 octets (TransformId).
 */
export function encode_decode_policy_v1(policy) {
  const s = policy.sampling;
  return _concat(
    _uint_le(1, 2, "version"),
    _classe(policy.class),
    _fixed(policy.tokenizer_hash, 32, "tokenizer_hash"),
    _uint_le(s.temperature_milli, 4, "temperature_milli"),
    _uint_le(s.top_p_ppm, 4, "top_p_ppm"),
    _uint_le(s.top_k, 4, "top_k"),
    _uint_le(s.repetition_penalty_ppm, 4, "repetition_penalty_ppm"),
    _uint_le(s.beam_width, 2, "beam_width"),
    _uint_le(s.seed, 8, "seed"),
    _fixed(policy.stop_conditions_hash, 32, "stop_conditions_hash"),
    policy.output_transform == null
      ? Uint8Array.of(0)
      : _concat(Uint8Array.of(1), _fixed(policy.output_transform, 32, "output_transform")),
    _fixed(policy.class_policy_hash, 32, "class_policy_hash"),
  );
}

/**
 * `hp_poui::DecodePolicy::default()`, telle que le générateur officiel l'encode : la seule source
 * publique de ces valeurs, et le corpus la prouve.
 */
export function default_decode_policy() {
  return {
    class: DecodePolicyClass.TextGeneration,
    tokenizer_hash: new Uint8Array(32),
    sampling: { temperature_milli: 0, top_p_ppm: 1_000_000, top_k: 0, repetition_penalty_ppm: 1_000_000, beam_width: 1, seed: 0n },
    stop_conditions_hash: new Uint8Array(32),
    output_transform: null,
    class_policy_hash: new Uint8Array(32),
  };
}

/** "FLOP_DECODE_POLICY_HASH_V1" || SCALE(DecodePolicy). */
export function decode_policy_preimage_v1(scale_bytes) {
  if (!(scale_bytes instanceof Uint8Array)) throw new TypeError("scale_bytes must be a Uint8Array");
  return _concat(DOMAINE_POLITIQUE, scale_bytes);
}

/** decode_policy_hash v1 (F.1) : SHA256, pas blake2, sur la préimage ci-dessus. */
export function decode_policy_hash_v1(scale_bytes) {
  return sha256(decode_policy_preimage_v1(scale_bytes));
}

function _tee(t) {
  if (!Number.isInteger(t) || t < 0 || t > 3) throw new CanalError("unknown tee_type");
  return Uint8Array.of(t);
}

function _bool(b, name) {
  if (typeof b !== "boolean") throw new CanalError(`${name} must be a boolean`);
  return Uint8Array.of(b ? 1 : 0);
}

/** task_hash || gn_weight:u64LE || latency_ms:u64LE || model_hash || output_hash || decode_policy_hash || tee_type. */
export function report_data_preimage_v1(f) {
  return _concat(
    _fixed(f.task_hash, 32, "task_hash"),
    _uint_le(f.gn_weight, 8, "gn_weight"),
    _uint_le(f.latency_ms, 8, "latency_ms"),
    _fixed(f.model_hash, 32, "model_hash"),
    _fixed(f.output_hash, 32, "output_hash"),
    _fixed(f.decode_policy_hash, 32, "decode_policy_hash"),
    _tee(f.tee_type),
  );
}

/** report_data v1 (F.1) : SHA256(préimage) || 00 x 32, exactement 64 octets. */
export function report_data_v1(f) {
  return _concat(sha256(report_data_preimage_v1(f)), new Uint8Array(32));
}

// ----- au-delà de la référence : ValidatorAttestation v1 (F.2) -----

/** Les dix premiers champs, 179 octets, que le validateur signe tels quels. */
export function validator_attestation_signable_v1(a) {
  return _concat(
    report_data_preimage_v1(a),
    _bool(a.quote_verified, "quote_verified"),
    _bool(a.event_log_verified, "event_log_verified"),
    _fixed(a.hardware_id_hash, 32, "hardware_id_hash"),
  );
}

/** L'attestation SCALE complète, 275 octets : signable || validator_id || signature. */
export function encode_validator_attestation_v1(a) {
  return _concat(validator_attestation_signable_v1(a), _fixed(a.validator_id, 32, "validator_id"), _fixed(a.signature, 64, "signature"));
}

/** La signature d'un validateur sur ses 179 octets signables : rend true, ou lève BadValidatorSignature. */
export function verify_validator_signature(signable, signature, validator_id) {
  _fixed(signable, 179, "signable");
  if (!sr25519_verify(signable, signature, validator_id)) {
    throw new CanalError("bad validator signature", "BadValidatorSignature");
  }
  return true;
}

// ----- au-delà de la référence : DataRef v1 (F.4) -----

export const Retention = Object.freeze({ Ephemeral: 0, Leased: 1 });

/** commitment:H256 || provider_id:u8 || retention, 34 octets fixes. */
export function encode_data_ref_v1(ref) {
  if (ref.retention !== 0 && ref.retention !== 1) throw new CanalError("unknown retention");
  return _concat(_fixed(ref.commitment, 32, "commitment"), _uint_le(ref.provider_id, 1, "provider_id"), Uint8Array.of(ref.retention));
}

/** L'énumération de rétention seule : 00 ou 01, une étiquette inconnue échoue au décodage SCALE. */
export function decode_retention(data) {
  const l = _lecteur(data, "retention");
  const t = l.u8();
  if (t > 1) throw new CanalError("unknown retention");
  l.fin();
  return t;
}

/** Un DataRef v1 en consommant tout ; un provider inconnu n'est pas une affaire de codec (registre). */
export function decode_data_ref_v1(data) {
  const l = _lecteur(data, "data ref");
  const commitment = l.take(32);
  const provider_id = l.u8();
  const retention = l.u8();
  if (retention > 1) throw new CanalError("unknown retention");
  l.fin();
  return { commitment, provider_id, retention };
}

// ----- selftest -----

const SHA256_CORPUS = "80d4a7e70f984342eb474ae5285a17a6b9348eca887e1689b15e641922051d93";
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new TypeError("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const repeat = (byte, length = 32) => new Uint8Array(length).fill(byte);

/** Sans réseau : le corpus officiel embarqué, ce que signent ses signatures, et nos propres refus. */
export function selftest() {
  const cas = [];
  // vrai : la fonction doit rendre exactement true ; une exception est un échec, raison à l'appui
  const vrai = (nom, fn) => {
    try {
      const r = fn();
      cas.push([nom, r === true, r === true ? "" : `returned ${String(r)}`]);
    } catch (e) {
      cas.push([nom, false, `threw ${e?.message ?? e}`]);
    }
  };
  // refuse : la fonction doit lever un CanalError, avec ce message et ce code quand ils sont donnés
  const refuse = (nom, fn, attendu = {}) => {
    try {
      fn();
      cas.push([nom, false, "accepted"]);
    } catch (e) {
      const bon = e instanceof CanalError
        && (attendu.message === undefined || e.message === attendu.message)
        && (attendu.code === undefined || e.code === attendu.code);
      cas.push([nom, bon, bon ? "" : `threw ${e?.name}: ${e?.message} (code ${e?.code ?? null})`]);
    }
  };

  // 1. la copie embarquée est bien le fichier publié
  const octets = new TextEncoder().encode(CORPUS_JSON);
  vrai("corpus: embedded copy is the published file (sha256)", () => octets.length === 24213 && toHex(sha256(octets)) === SHA256_CORPUS);
  const J = JSON.parse(CORPUS_JSON);
  const cc = J.compute_channel_v1;
  const dr = J.direct_rail_v1;
  const li = cc.leaf_inputs;
  const neg = Object.fromEntries(J.negative_cases.map((n) => [n.id, fromHex(n.bytes_hex)]));

  // 2. codec (F.0)
  for (const v of J.codec.scale_compact_u32) {
    vrai(`compact ${v.value} <-> ${v.bytes_hex}`, () => {
      const b = fromHex(v.bytes_hex);
      const [valeur, fin] = decode_compact_u32(b);
      return v.expected === "accept" && toHex(compact_u32(v.value)) === v.bytes_hex && valeur === v.value && fin === b.length;
    });
  }
  const famille = (raison) => {
    if (raison.startsWith("truncated")) return "truncated compact integer";
    if (raison.startsWith("overlong")) return "non-canonical compact integer";
    if (raison === "exceeds u32") return "compact integer exceeds u32";
    return "(unmapped corpus reason)";
  };
  for (const v of J.codec.malformed_compact) {
    refuse(`compact rejects "${v.bytes_hex}" (${v.reason})`, () => decode_compact_u32(fromHex(v.bytes_hex)), { message: famille(v.reason) });
  }
  const sb = J.codec.scale_bool;
  vrai(`bool ${sb.false} = false, ${sb.true} = true`, () => decode_scale_bool(fromHex(sb.false)) === false && decode_scale_bool(fromHex(sb.true)) === true);
  refuse(`bool 02: ${sb.other}`, () => decode_scale_bool(Uint8Array.of(2)), { message: "invalid bool" });

  // 3. DecodePolicy v1 (F.1)
  const dp = J.decode_policy_v1;
  const politiqueDefaut = encode_decode_policy_v1(default_decode_policy());
  vrai("decode_policy_v1: SCALE of the default policy", () => toHex(politiqueDefaut) === dp.scale_bytes_hex);
  vrai("decode_policy_v1: hash preimage", () => toHex(decode_policy_preimage_v1(politiqueDefaut)) === dp.hash_preimage_hex);
  vrai("decode_policy_v1: sha256", () => toHex(decode_policy_hash_v1(politiqueDefaut)) === dp.sha256_hex);

  // 4. rail direct (F.1, F.2)
  const th = dr.task_hash;
  const ti = th.inputs;
  vrai("task_hash v1", () => toHex(task_hash_v1(fromHex(ti.genesis_hash_hex), fromHex(ti.agent_account_id32_hex), ti.nonce,
    fromHex(ti.model_hash_hex), fromHex(ti.payload_hash_hex), fromHex(ti.commit_hash_hex))) === th.hash_hex);
  vrai("task_hash: corpus preimage hashes to it", () => toHex(blake2_256(fromHex(th.preimage_hex))) === th.hash_hex);
  const di = dr.inputs;
  const rail = {
    task_hash: fromHex(di.task_hash_hex), gn_weight: di.gn_weight, latency_ms: di.latency_ms,
    model_hash: fromHex(di.model_hash_hex), output_hash: fromHex(di.output_hash_hex),
    decode_policy_hash: fromHex(di.decode_policy_hash_hex), tee_type: di.tee_type.scale_tag,
    quote_verified: di.quote_verified, event_log_verified: di.event_log_verified,
    hardware_id_hash: fromHex(di.hardware_id_hash_hex),
  };
  vrai("direct rail: inputs chain task_hash, policy and tee tag", () => di.task_hash_hex === th.hash_hex
    && di.decode_policy_hash_hex === dp.sha256_hex && TeeType[di.tee_type.name] === di.tee_type.scale_tag);
  vrai("report_data v1: preimage", () => toHex(report_data_preimage_v1(rail)) === dr.report_data_preimage_hex);
  vrai("report_data v1: 64 B", () => {
    const r = report_data_v1(rail);
    return r.length === 64 && toHex(r) === dr.report_data_hex;
  });
  const signable = validator_attestation_signable_v1(rail);
  const idValidateur = fromHex(dr.validator_id_hex);
  const sigValidateur = fromHex(dr.validator_signature_hex);
  vrai("validator attestation: signable of 179 B", () => signable.length === 179 && toHex(signable) === dr.validator_attestation_signable_hex);
  vrai("validator attestation: SCALE of 275 B", () => {
    const b = encode_validator_attestation_v1({ ...rail, validator_id: idValidateur, signature: sigValidateur });
    return b.length === 275 && toHex(b) === dr.validator_attestation_scale_hex;
  });
  vrai("validator signature: over the 179 signable bytes", () => verify_validator_signature(signable, sigValidateur, idValidateur));

  // 5. canal de calcul (F.1, F.3)
  const dec = new TextDecoder();
  vrai("domains: channel id and receipt ascii", () => dec.decode(CHANNEL_ID_DOMAIN_V1) === cc.domains.channel_id_ascii
    && dec.decode(RECEIPT_DOMAIN) === cc.domains.receipt_ascii);
  const ci = cc.channel_id.inputs;
  const genesis = fromHex(ci.genesis_hash_hex);
  const agent = fromHex(ci.agent_account_id32_hex);
  const miner = fromHex(ci.miner_account_id32_hex);
  const channelId = channel_id_v1(genesis, agent, miner, ci.nonce);
  vrai("channel_id v1", () => toHex(channelId) === cc.channel_id.hash_hex);
  vrai("channel_id: corpus preimage hashes to it", () => toHex(blake2_256(fromHex(cc.channel_id.preimage_hex))) === cc.channel_id.hash_hex);
  vrai("h_ids([], [0, u32::MAX]), official generator inputs", () => toHex(h_ids([], [0, 0xffff_ffff])) === li.h_ids_hex);
  const champs = {
    channel_id: fromHex(li.channel_id_hex), turn_index: li.turn_index, h_in: fromHex(li.h_in_hex), h_out: fromHex(li.h_out_hex),
    g_n: BigInt(li.g_n), decode_policy_hash: fromHex(li.decode_policy_hash_hex), ids_hash: fromHex(li.h_ids_hex),
    toploc_commitment_hash: fromHex(li.toploc_commitment_hash_hex), miner_recv_ms: BigInt(li.miner_recv_ms),
    miner_done_ms: BigInt(li.miner_done_ms), latency_ms: BigInt(li.latency_ms),
  };
  vrai("leaf_inputs.channel_id is channel_id v1", () => toHex(champs.channel_id) === cc.channel_id.hash_hex);
  const tailles = { V0: 116, V1: 140, V2: 172, V3: 236 };   // F.3
  for (const lv of cc.leaf_versions) {
    vrai(`leaf ${lv.version}: preimage of ${tailles[lv.version]} B and hash`, () => {
      const pre = leaf_preimage(lv.scale_tag, champs);
      return TranscriptLeafVersion[lv.version] === lv.scale_tag && pre.length === tailles[lv.version]
        && toHex(pre) === lv.preimage_hex && toHex(transcript_leaf(lv.scale_tag, champs)) === lv.hash_hex;
    });
  }
  const feuille = Object.fromEntries(cc.leaf_versions.map((lv) => [lv.version, fromHex(lv.hash_hex)]));
  const arbre = cc.merkle.leaf_order.map((v) => feuille[v]);
  const racine = fromHex(cc.merkle.root_hex);
  const chemin = cc.merkle.path_for_index_2.map((x) => [fromHex(x.sibling_hex), x.sibling_is_left]);
  vrai("merkle root over [V1, V2, V3], last node duplicated", () => toHex(merkle_root(arbre)) === cc.merkle.root_hex);
  vrai("merkle path for index 2", () => {
    const p = merkle_path(arbre, 2);
    return p.length === chemin.length && p.every(([s, g], i) => _equal(s, chemin[i][0]) && g === chemin[i][1]);
  });
  vrai("hash_pair(V1, V2) is the upper sibling, 64 B, no prefix", () => _equal(hash_pair(feuille.V1, feuille.V2), chemin[1][0]));
  vrai("root_from_path(V3 leaf, path) = root", () => _equal(root_from_path(feuille.V3, chemin), racine));
  const cle = fromHex(cc.v3_leaf_signature.public_key_hex);
  const sigFeuille = fromHex(cc.v3_leaf_signature.signature_hex);
  const preV3 = fromHex(cc.leaf_versions.find((lv) => lv.version === "V3").preimage_hex);
  vrai("v3 leaf signature: over the 32 B leaf hash", () => cc.v3_leaf_signature.leaf_hash_hex === toHex(feuille.V3)
    && sr25519_verify(feuille.V3, sigFeuille, cle));
  vrai("v3 leaf signature: not over the 236 B preimage", () => sr25519_verify(preV3, sigFeuille, cle) === false);
  const tour = {
    leaf_version: 3, turn_index: li.turn_index, h_in: champs.h_in, h_out: champs.h_out, g_n: champs.g_n,
    decode_policy_hash: champs.decode_policy_hash, h_ids: champs.ids_hash, toploc_commitment_hash: champs.toploc_commitment_hash,
    miner_recv_ms: champs.miner_recv_ms, miner_done_ms: champs.miner_done_ms, latency_ms: champs.latency_ms,
    enclave_sig: sigFeuille, agent_ack: null,
  };
  const vt = fromHex(cc.verified_turn_v3_scale_hex);
  vrai("verified_turn V3: SCALE of 269 + 1 + 33 * 2 B", () => {
    const b = encode_verified_turn(tour, chemin);
    return b.length === 336 && _equal(b, vt);
  });
  vrai("verified_turn V3: decodes and re-encodes identically", () => {
    const [r, p] = decode_verified_turn(vt);
    return _equal(encode_verified_turn(r, p), vt);
  });
  const canalCourant = { channel_id: channelId, final_root: racine, enclave_key: cle, decode_policy_hash: champs.decode_policy_hash };
  vrai("verified_turn V3: proof accepted on a current channel", () => {
    const [r, p] = decode_verified_turn(vt);
    return _equal(verify_turn_proof(r, p, canalCourant), feuille.V3);
  });
  // le chemin du cas wrong_path_orientation : son premier frère est la feuille elle-même
  const retourne = [[chemin[0][0], !chemin[0][1]], chemin[1]];
  vrai("flipped odd node: reference root_from_path still reaches root", () => _equal(chemin[0][0], feuille.V3)
    && _equal(root_from_path(feuille.V3, retourne), racine));
  vrai("flipped odd node: it proves the phantom position 3", () => {
    const p = merkle_path([...arbre, feuille.V3], 3);
    return p.length === 2 && p.every(([s, g], i) => _equal(s, retourne[i][0]) && g === retourne[i][1]);
  });
  refuse("flipped odd node: refused as a phantom position", () => verify_turn_proof(tour, retourne, canalCourant),
    { code: "LeafNotInRoot", message: "leaf not in root: path proves the copy of an odd last node" });
  refuse("flipped upper sibling: a real wrong orientation", () => verify_turn_proof(tour, [chemin[0], [chemin[1][0], !chemin[1][1]]], canalCourant),
    { code: "LeafNotInRoot", message: "leaf not in root" });
  const blob = fromHex(cc.fcc4_transcript_blob_hex);
  vrai("FCC4 blob: encodes the V3 turn", () => _equal(encode_transcript_blob(channelId, [tour]), blob));
  vrai("FCC4 blob: decodes and re-encodes identically", () => {
    const [c, t] = decode_transcript_blob(blob);
    return t.length === 1 && _equal(encode_transcript_blob(c, t), blob);
  });
  const ri = cc.receipt.inputs;
  const recu = { channel_id: fromHex(ri.channel_id_hex), final_root: fromHex(ri.final_root_hex), aggregate_gn: ri.aggregate_gn, payable: ri.payable };
  const cleRecu = fromHex(cc.receipt.public_key_hex);
  const sigRecu = fromHex(cc.receipt.signature_hex);
  const messageRecu = receipt_message_v1(recu.channel_id, recu.final_root, recu.aggregate_gn, recu.payable);
  vrai("receipt v1: message of 125 B", () => messageRecu.length === 125 && toHex(messageRecu) === cc.receipt.preimage_hex);
  vrai("receipt v1: signature over the message bytes", () => verify_receipt(recu, sigRecu, cleRecu, WIRE_PROFILE_V1));
  vrai("receipt v1: signature not over blake2_256(message)", () => sr25519_verify(blake2_256(messageRecu), sigRecu, cleRecu) === false);
  const dref = J.data_ref_v1;
  vrai("data_ref v1: SCALE of 34 B and back", () => {
    const b = encode_data_ref_v1({ commitment: fromHex(dref.input.commitment_hex), provider_id: dref.input.provider_id,
      retention: Retention[dref.input.retention] });
    const d = decode_data_ref_v1(b);
    return b.length === 34 && toHex(b) === dref.scale_bytes_hex && d.provider_id === 0
      && d.retention === Retention.Ephemeral && _equal(d.commitment, fromHex(dref.input.commitment_hex));
  });

  // 6. les cas négatifs du corpus, tous, avec leur raison quand le corpus la nomme
  const recuDe = (b) => ({ channel_id: b.subarray(0, 32), final_root: b.subarray(32, 64),
    aggregate_gn: _read_le(b.subarray(64, 80)), payable: _read_le(b.subarray(80, 96)) });
  const traitement = {
    unknown_leaf_enum: (b) => decode_leaf_version(b),
    unknown_retention_enum: (b) => decode_retention(b),
    truncated_fcc4: (b) => decode_transcript_blob(b),
    trailing_fcc4: (b) => decode_transcript_blob(b),
    unknown_fcc_version: (b) => decode_transcript_blob(b),
    duplicate_turn_index: (b) => verified_work_from_turns(decode_verified_turns(b), canalCourant),
    wrong_path_orientation: (b) => verify_turn_proof(...decode_verified_turn(b), canalCourant),
    wrong_leaf_version: (b) => verify_turn_proof(...decode_verified_turn(b), canalCourant),
    legacy_leaf_current_channel: (b) => verify_turn_proof(...decode_verified_turn(b), canalCourant),
    invalid_receipt_signature: (b) => verify_receipt(recu, b, cleRecu, WIRE_PROFILE_V1),
    legacy_receipt_current_channel: (b) => verify_receipt(recuDe(b), b.subarray(96), cleRecu, WIRE_PROFILE_V1),
    invalid_validator_signature: (b) => verify_validator_signature(signable, b, idValidateur),
  };
  // la référence nomme ces refus par leur message ; le corpus, lui, n'écrit que « reject »
  const messageDe = {
    unknown_leaf_enum: "unsupported leaf version",
    unknown_retention_enum: "unknown retention",
    truncated_fcc4: "truncated transcript blob",
    trailing_fcc4: "trailing transcript blob bytes",
    unknown_fcc_version: "unsupported transcript blob version",
  };
  // « different channel_id » : l'entrée mutée, telle que le générateur officiel la construit
  const autreCanal = {
    wrong_genesis_network: () => channel_id_v1(_concat(Uint8Array.of(1), genesis.subarray(1)), agent, miner, ci.nonce),
    wrong_session: () => channel_id_v1(genesis, repeat(0x12), miner, ci.nonce),
  };
  for (const n of J.negative_cases) {
    const b = neg[n.id];
    const nom = `corpus negative ${n.id}: ${n.expected}`;
    if (n.expected === "different channel_id" && autreCanal[n.id]) {
      vrai(nom, () => {
        const c = autreCanal[n.id]();
        return _equal(c, b) && !_equal(c, channelId);
      });
    } else if (n.expected.startsWith("reject") && traitement[n.id]) {
      const code = n.expected === "reject" ? undefined : n.expected.slice("reject ".length);
      refuse(nom, () => traitement[n.id](b), { code, message: messageDe[n.id] });
    } else {
      cas.push([nom, false, "no handler: new corpus case?"]);
    }
  }

  // 7. ce que signe chaque signature du corpus (mesuré, voir l'en-tête)
  const [tourHerite, cheminHerite] = decode_verified_turn(neg.legacy_leaf_current_channel);
  const recuHerite = neg.legacy_receipt_current_channel;
  vrai("legacy V1 signature: over the 32 B V1 leaf hash", () => sr25519_verify(feuille.V1, tourHerite.enclave_sig, cle));
  vrai("legacy V1 turn: accepted without decode-policy marker", () => _equal(
    verify_turn_proof(tourHerite, cheminHerite, { ...canalCourant, decode_policy_hash: null }), feuille.V1));
  vrai("legacy receipt: signature over the 96 legacy bytes", () => verify_receipt(recuDe(recuHerite), recuHerite.subarray(96), cleRecu, null));
  refuse("receipt v1 on a channel without profile marker", () => verify_receipt(recu, sigRecu, cleRecu, null), { code: "BadReceiptSignature" });
  refuse("unknown wire profile fails closed", () => verify_receipt(recu, sigRecu, cleRecu, 2), { message: "unknown wire profile" });
  const paires = [
    [sigFeuille, feuille.V3], [tourHerite.enclave_sig, feuille.V1], [sigRecu, messageRecu],
    [recuHerite.subarray(96), recuHerite.subarray(0, 96)], [sigValidateur, signable],
  ];
  vrai("no corpus signature verifies in ed25519", () => paires.every(([s, m]) => {
    try {
      return ed25519.verify(s, m, cle) === false;
    } catch {
      return true;
    }
  }));
  vrai("corpus: enclave, receipt and validator keys are one key", () => _equal(cle, cleRecu) && _equal(cle, idValidateur));

  // 8. nos propres cas négatifs
  refuse("own: compact fd00 (63 in mode 1)", () => decode_compact_u32(fromHex("fd00")), { message: "non-canonical compact integer" });
  refuse("own: compact feff0000 (16383 in mode 2)", () => decode_compact_u32(fromHex("feff0000")), { message: "non-canonical compact integer" });
  refuse("own: compact 03ffffff3f (2^30-1 in mode 3)", () => decode_compact_u32(fromHex("03ffffff3f")), { message: "non-canonical compact integer" });
  refuse("own: compact 070000000001 (2^32, canonical u64)", () => decode_compact_u32(fromHex("070000000001")), { message: "compact integer exceeds u32" });
  refuse("own: compact 03ffff truncated in mode 3", () => decode_compact_u32(fromHex("03ffff")), { message: "truncated compact integer" });
  refuse("own: compact_u32(2^32)", () => compact_u32(2 ** 32), { message: "compact value does not fit u32" });
  const mute = (i, v) => {
    const c = blob.slice();
    c[i] = v;
    return c;
  };
  const OCTET_POLITIQUE = 4 + 32 + 4 + 1 + 4 + 32 + 32 + 16;   // has_policy du premier tour
  refuse("own: FCC4 has_policy option tag 2", () => decode_transcript_blob(mute(OCTET_POLITIQUE, 2)), { message: "invalid option tag" });
  refuse("own: FCC4 has_ack option tag 2", () => decode_transcript_blob(mute(blob.length - 1, 2)), { message: "invalid option tag" });
  refuse("own: FCC4 V1 tag with a policy", () => decode_transcript_blob(mute(40, 1)), { message: "V0/V1 fields are inconsistent" });
  refuse("own: FCC4 V3 with a zero h_ids", () => {
    const c = blob.slice();
    c.fill(0, OCTET_POLITIQUE + 33, OCTET_POLITIQUE + 65);
    return decode_transcript_blob(c);
  }, { message: "V3 fields are inconsistent" });
  refuse("own: FCC4 cut exactly before a turn (reference message)", () => decode_transcript_blob(
    _concat(blob.subarray(0, 36), Uint8Array.of(2, 0, 0, 0), blob.subarray(40))), { message: "unsupported leaf version" });
  refuse("own: verified turn with a trailing byte", () => decode_verified_turn(_concat(vt, Uint8Array.of(0))), { message: "trailing verified turn bytes" });
  refuse("own: verified turn one byte short", () => decode_verified_turn(vt.subarray(0, vt.length - 1)), { message: "truncated verified turn" });
  refuse("own: verified turn path bool 02", () => {
    const c = vt.slice();
    c[c.length - 1] = 2;
    return decode_verified_turn(c);
  }, { message: "invalid bool" });
  refuse("own: verified turn path length 0900, non-canonical", () => decode_verified_turn(
    _concat(vt.subarray(0, 269), Uint8Array.of(0x09, 0x00), vt.subarray(270))), { message: "non-canonical compact integer" });
  refuse("own: verified turn tag 04", () => decode_verified_turn(_concat(Uint8Array.of(4), vt.subarray(1))), { message: "unsupported leaf version" });
  refuse("own: verified turns with a trailing byte", () => decode_verified_turns(
    _concat(neg.duplicate_turn_index, Uint8Array.of(0))), { message: "trailing verified turns bytes" });
  refuse("own: data ref of 35 B", () => decode_data_ref_v1(_concat(fromHex(dref.scale_bytes_hex), Uint8Array.of(0))), { message: "trailing data ref bytes" });
  refuse("own: data ref retention 02", () => decode_data_ref_v1(_concat(repeat(0x88), Uint8Array.of(0, 2))), { message: "unknown retention" });
  refuse("own: bool ff", () => decode_scale_bool(Uint8Array.of(0xff)), { message: "invalid bool" });
  refuse("own: 31-byte genesis_hash", () => channel_id_v1(genesis.subarray(1), agent, miner, 42), { message: "genesis_hash must be 32 bytes" });
  refuse("own: 33-byte h_in in a leaf", () => leaf_preimage(3, { ...champs, h_in: repeat(0x33, 33) }), { message: "h_in must be 32 bytes" });
  refuse("own: 63-byte enclave_sig", () => encode_verified_turn({ ...tour, enclave_sig: repeat(1, 63) }, chemin), { message: "enclave_sig must be 64 bytes" });
  refuse("own: 31-byte left node", () => hash_pair(repeat(1, 31), feuille.V1), { message: "left must be 32 bytes" });
  refuse("own: turn_index 2^32", () => leaf_preimage(3, { ...champs, turn_index: 2 ** 32 }), { message: "turn_index does not fit u32" });
  refuse("own: g_n 2^128", () => leaf_preimage(3, { ...champs, g_n: 1n << 128n }), { message: "g_n does not fit u128" });
  refuse("own: negative nonce", () => channel_id_v1(genesis, agent, miner, -1), { message: "nonce does not fit u64" });
  refuse("own: nonce 2^53 as a Number, not exact", () => channel_id_v1(genesis, agent, miner, 2 ** 53), { message: "nonce does not fit u64" });
  refuse("own: nonce 1.5", () => channel_id_v1(genesis, agent, miner, 1.5), { message: "nonce does not fit u64" });
  refuse("own: a boolean is not an integer", () => channel_id_v1(genesis, agent, miner, true), { message: "nonce does not fit u64" });
  refuse("own: leaf version 4, stricter than the reference", () => leaf_preimage(4, champs), { message: "unsupported leaf version" });
  refuse("own: path orientation 2, stricter than the reference", () => encode_verified_turn(tour, [[chemin[0][0], 2]]),
    { message: "path orientation must be a boolean" });
  refuse("own: merkle path index out of range", () => merkle_path(arbre, 3), { message: "leaf index out of range" });
  vrai("own: empty root 00*32, single-leaf root is the leaf", () => toHex(merkle_root([])) === "00".repeat(32)
    && _equal(merkle_root([feuille.V3]), feuille.V3) && merkle_path([feuille.V3], 0).length === 0);

  // 9. nos propres clés : ce qu'un corpus à une seule clé et un seul tour signé ne peut pas montrer
  const alea = repeat(0x42);   // aléa de signature fixé : le selftest reste reproductible
  const secretEnclave = sr25519.secretFromSeed(repeat(0x5a));
  const cleEnclave = sr25519.getPublicKey(secretEnclave);
  const secretAgent = sr25519.secretFromSeed(repeat(0xa5));
  const cleAgent = sr25519.getPublicKey(secretAgent);
  const politique = decode_policy_hash_v1(politiqueDefaut);
  const canal = channel_id_v1(genesis, agent, miner, 43);
  const signe = (r) => ({ ...r, enclave_sig: sr25519.sign(secretEnclave, transcript_leaf(r.leaf_version, leaf_fields(canal, r)), alea) });
  const base = {
    leaf_version: 3, h_in: repeat(0x31), h_out: repeat(0x32), decode_policy_hash: politique, h_ids: h_ids([1, 2, 3], [4, 5]),
    toploc_commitment_hash: repeat(0x77), miner_recv_ms: 1000n, miner_done_ms: 1500n, latency_ms: 500n, agent_ack: null,
  };
  const lotDe = (tours) => {
    const fs = tours.map((t) => transcript_leaf(3, leaf_fields(canal, t)));
    return {
      lot: tours.map((t, i) => [t, merkle_path(fs, i)]),
      ctx: { channel_id: canal, final_root: merkle_root(fs), enclave_key: cleEnclave, decode_policy_hash: politique },
    };
  };
  const t0 = signe({ ...base, turn_index: 0, g_n: 10n });
  const t1 = signe({ ...base, turn_index: 1, g_n: 32n });
  const { lot, ctx } = lotDe([t0, t1]);
  vrai("own keys: two signed turns settle to aggregate 42", () => verified_work_from_turns(lot, ctx, 42n) === 42n);
  refuse("own keys: aggregate mismatch", () => verified_work_from_turns(lot, ctx, 41n), { code: "AggregateGnMismatch" });
  refuse("own keys: g_n sum overflows u128", () => {
    const { lot: l, ctx: c } = lotDe([signe({ ...base, turn_index: 0, g_n: U128_MAX }), signe({ ...base, turn_index: 1, g_n: U128_MAX })]);
    return verified_work_from_turns(l, c);
  }, { message: "aggregate g_n overflows u128" });
  refuse("own keys: tampered enclave signature", () => {
    const s = t0.enclave_sig.slice();
    s[0] ^= 1;
    return verify_turn_proof({ ...t0, enclave_sig: s }, lot[0][1], ctx);
  }, { message: "bad turn signature" });
  refuse("own keys: enclave signature under another key", () => verify_turn_proof(t0, lot[0][1], { ...ctx, enclave_key: cleAgent }),
    { message: "bad turn signature" });
  refuse("own keys: decode policy mismatch", () => verify_turn_proof(t0, lot[0][1], { ...ctx, decode_policy_hash: repeat(0x66) }),
    { message: "decode policy mismatch" });
  refuse("own keys: merkle path of 65 siblings", () => verify_turn_proof(t0, Array.from({ length: 65 }, () => [repeat(0), false]), ctx),
    { code: "MerklePathTooLong" });
  refuse("own keys: 1025 turns in one bundle", () => verified_work_from_turns(Array.from({ length: 1025 }, () => lot[0]), ctx),
    { code: "TooManySettlementTurns" });
  const recuAgent = { channel_id: canal, final_root: ctx.final_root, aggregate_gn: 42n, payable: 7n };
  const sigAgent = sr25519.sign(secretAgent, receipt_message_v1(canal, ctx.final_root, 42n, 7n), alea);
  vrai("own keys: agent receipt v1 under the agent key", () => verify_receipt(recuAgent, sigAgent, cleAgent, WIRE_PROFILE_V1));
  refuse("own keys: same receipt under the enclave key", () => verify_receipt(recuAgent, sigAgent, cleEnclave, WIRE_PROFILE_V1),
    { code: "BadReceiptSignature" });
  refuse("own keys: same receipt with another payable", () => verify_receipt({ ...recuAgent, payable: 8n }, sigAgent, cleAgent, WIRE_PROFILE_V1),
    { code: "BadReceiptSignature" });
  vrai("own keys: FCC4 with an agent ack round-trips", () => {
    const avecAck = { ...t0, agent_ack: { agent_send_ms: 900n, agent_recv_ms: 1600n, agent_sig: repeat(9, 64) } };
    const b = encode_transcript_blob(canal, [avecAck, t1]);
    const [c, ts] = decode_transcript_blob(b);
    return _equal(c, canal) && ts.length === 2 && _equal(encode_transcript_blob(c, ts), b);
  });

  for (const [nom, bon, detail] of cas) console.log(`  ${nom.padEnd(62)} ${bon ? "reussi" : `ECHOUE ${detail}`}`);
  const echecs = cas.filter(([, bon]) => !bon).length;
  console.log(`canal : ${cas.length - echecs}/${cas.length}`);
  return echecs ? 1 : 0;
}

// ----- le corpus officiel, embarqué tel quel -----
//
// evidence/wire-format-v1.json, FLOP Labs, https://github.com/flop-labs/yellowpaper, sous licence
// CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Aucune modification : le selftest
// recalcule son sha256 et le compare à celui du fichier publié. Un gabarit JavaScript ramène toute
// fin de ligne à LF, donc une copie de travail en CRLF garde la même empreinte.
const CORPUS_JSON = String.raw`{
  "$schema": "wire-format-v1.schema.json",
  "codec": {
    "fixed_integers": "unsigned little-endian; reject overflow; no rounding",
    "malformed_compact": [
      {
        "bytes_hex": "",
        "expected": "reject",
        "reason": "truncated"
      },
      {
        "bytes_hex": "fd",
        "expected": "reject",
        "reason": "truncated mode 1"
      },
      {
        "bytes_hex": "feffff",
        "expected": "reject",
        "reason": "truncated mode 2"
      },
      {
        "bytes_hex": "0100",
        "expected": "reject",
        "reason": "overlong zero"
      },
      {
        "bytes_hex": "0301000000",
        "expected": "reject",
        "reason": "overlong big mode"
      },
      {
        "bytes_hex": "070000000000",
        "expected": "reject",
        "reason": "exceeds u32"
      }
    ],
    "scale_bool": {
      "false": "00",
      "other": "reject",
      "true": "01"
    },
    "scale_compact_u32": [
      {
        "bytes_hex": "00",
        "expected": "accept",
        "value": 0
      },
      {
        "bytes_hex": "fc",
        "expected": "accept",
        "value": 63
      },
      {
        "bytes_hex": "0101",
        "expected": "accept",
        "value": 64
      },
      {
        "bytes_hex": "fdff",
        "expected": "accept",
        "value": 16383
      },
      {
        "bytes_hex": "02000100",
        "expected": "accept",
        "value": 16384
      },
      {
        "bytes_hex": "feffffff",
        "expected": "accept",
        "value": 1073741823
      },
      {
        "bytes_hex": "0300000040",
        "expected": "accept",
        "value": 1073741824
      },
      {
        "bytes_hex": "03ffffffff",
        "expected": "accept",
        "value": 4294967295
      }
    ]
  },
  "compute_channel_v1": {
    "channel_id": {
      "hash_hex": "3655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d28",
      "inputs": {
        "agent_account_id32_hex": "1111111111111111111111111111111111111111111111111111111111111111",
        "genesis_hash_hex": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "miner_account_id32_hex": "2222222222222222222222222222222222222222222222222222222222222222",
        "nonce": 42
      },
      "preimage_hex": "464c4f502f434f4d505554455f4348414e4e454c2f494401000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222222a00000000000000"
    },
    "domains": {
      "channel_id_ascii": "FLOP/COMPUTE_CHANNEL/ID",
      "deployment": "genesis_hash in channel_id",
      "leaf": "no prefix; the deployment/session-bound channel_id is the leading field",
      "merkle_node": "no prefix; exactly 64 bytes left_32 || right_32",
      "protocol": "ASCII domain plus version byte",
      "receipt_ascii": "FLOP/COMPUTE_CHANNEL/RECEIPT",
      "session": "channel_id binds agent, miner and nonce"
    },
    "fcc4_transcript_blob_hex": "464343343655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d280100000003ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff016666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff010000000000000094f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea7208600",
    "leaf_inputs": {
      "channel_id_hex": "3655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d28",
      "decode_policy_hash_hex": "6666666666666666666666666666666666666666666666666666666666666666",
      "g_n": "340282366920938463463374607431768211455",
      "h_ids_hex": "368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f",
      "h_in_hex": "3333333333333333333333333333333333333333333333333333333333333333",
      "h_out_hex": "4444444444444444444444444444444444444444444444444444444444444444",
      "latency_ms": 1,
      "miner_done_ms": "18446744073709551614",
      "miner_recv_ms": "18446744073709551613",
      "toploc_commitment_hash_hex": "7777777777777777777777777777777777777777777777777777777777777777",
      "turn_index": 4294967295
    },
    "leaf_versions": [
      {
        "expected": "accept only under selected version and channel cutoff",
        "hash_hex": "c94322dcec243f39ac92af04248f643ca2978f138c1f9bb4bb2d2720ee8f5ad9",
        "preimage_hex": "3655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d28ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff",
        "scale_tag": 0,
        "version": "V0"
      },
      {
        "expected": "accept only under selected version and channel cutoff",
        "hash_hex": "218d9062a948e52066456ecb38cc28517423f427a925d1f57c2cd17cc60f1b97",
        "preimage_hex": "3655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d28ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444fffffffffffffffffffffffffffffffffdfffffffffffffffeffffffffffffff0100000000000000",
        "scale_tag": 1,
        "version": "V1"
      },
      {
        "expected": "accept only under selected version and channel cutoff",
        "hash_hex": "4a3632de6913f0502c6313499b29d0976b085a4612e14e017c5eaf065b1c6c2d",
        "preimage_hex": "3655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d28ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff6666666666666666666666666666666666666666666666666666666666666666fdfffffffffffffffeffffffffffffff0100000000000000",
        "scale_tag": 2,
        "version": "V2"
      },
      {
        "expected": "accept only under selected version and channel cutoff",
        "hash_hex": "8ca5d489cec0a255a48a2e3c2149d8028597e03ea78628d9a3672ddb80df2869",
        "preimage_hex": "3655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d28ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff6666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff0100000000000000",
        "scale_tag": 3,
        "version": "V3"
      }
    ],
    "merkle": {
      "leaf_order": [
        "V1",
        "V2",
        "V3"
      ],
      "node_preimage": "left_32 || right_32; no prefix (length separates nodes from leaf preimages)",
      "odd_node_behavior": "duplicate last",
      "path_for_index_2": [
        {
          "sibling_hex": "8ca5d489cec0a255a48a2e3c2149d8028597e03ea78628d9a3672ddb80df2869",
          "sibling_is_left": false
        },
        {
          "sibling_hex": "482735fe0838313af87270c7fa678a8fb6c3cf9d9e3af35b8c73ea39f279a92a",
          "sibling_is_left": true
        }
      ],
      "root_hex": "1020281304e2677e48c1093e7f5069fc8fbff1ea82daf2ac5b2b49d7cef756ed"
    },
    "receipt": {
      "expected": "accept",
      "inputs": {
        "aggregate_gn": 42,
        "channel_id_hex": "1111111111111111111111111111111111111111111111111111111111111111",
        "final_root_hex": "2222222222222222222222222222222222222222222222222222222222222222",
        "payable": 1000
      },
      "preimage_hex": "464c4f502f434f4d505554455f4348414e4e454c2f5245434549505401111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222222a000000000000000000000000000000e8030000000000000000000000000000",
      "public_key_hex": "b41236c517514b30a4d6619f4b4354a2ce593cd4b64a7c29dd45e3de6972997a",
      "signature_hex": "7803f98d0297c23f5df90f4bce093492de9658045d3d2296717a1e718e8bc40d891e60e517fdc459f59140b289d9fcba90809493875b5d8e77325b0ec9572683"
    },
    "v3_leaf_signature": {
      "expected": "accept",
      "leaf_hash_hex": "8ca5d489cec0a255a48a2e3c2149d8028597e03ea78628d9a3672ddb80df2869",
      "public_key_hex": "b41236c517514b30a4d6619f4b4354a2ce593cd4b64a7c29dd45e3de6972997a",
      "signature_hex": "94f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea72086"
    },
    "verified_turn_v3_scale_hex": "03ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff6666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff010000000000000094f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea72086088ca5d489cec0a255a48a2e3c2149d8028597e03ea78628d9a3672ddb80df286900482735fe0838313af87270c7fa678a8fb6c3cf9d9e3af35b8c73ea39f279a92a01"
  },
  "coverage": [
    {
      "appendix": "F.1",
      "consumer": "hp_poui::DecodePolicy::hash / compute_channel::channel_id",
      "family": "decode_policy_v1/compute_channel_v1.channel_id"
    },
    {
      "appendix": "F.2/G.2",
      "consumer": "submit_validator_attestations -> oracle::check_one/process_verified_poui_result",
      "family": "direct_rail_v1"
    },
    {
      "appendix": "F.3/G.1 settle",
      "consumer": "verify_receipt -> verified_work_from_turns -> verify_turn_proof",
      "family": "compute_channel_v1"
    },
    {
      "appendix": "F.3/G.1 dispute",
      "consumer": "respond_dispute",
      "family": "compute_channel_v1"
    },
    {
      "appendix": "F.4/G.3",
      "consumer": "da_registry::register_blob/pin/is_live",
      "family": "data_ref_v1"
    },
    {
      "appendix": "F.5/G.1",
      "consumer": "submit_toploc_evidence/report_toploc_mismatch/settlement gate",
      "family": "compute_channel_v1.leaf_versions.V3"
    }
  ],
  "data_ref_v1": {
    "expected": "accept when registered, live and pinned as required by consumer",
    "input": {
      "commitment_hex": "8888888888888888888888888888888888888888888888888888888888888888",
      "provider_id": 0,
      "retention": "Ephemeral"
    },
    "scale_bytes_hex": "88888888888888888888888888888888888888888888888888888888888888880000"
  },
  "decode_policy_v1": {
    "expected": "accept",
    "hash_preimage_hex": "464c4f505f4445434f44455f504f4c4943595f484153485f563101000000000000000000000000000000000000000000000000000000000000000000000000000040420f000000000040420f00010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "input": "hp_poui::DecodePolicy::default()",
    "scale_bytes_hex": "01000000000000000000000000000000000000000000000000000000000000000000000000000040420f000000000040420f00010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "sha256_hex": "be572af01bd68df9c660da094b7796244dd29435d532c63c9f42efe6bdabd796"
  },
  "direct_rail_v1": {
    "expected": "accept when pending tuple, active signer and quorum also pass",
    "inputs": {
      "decode_policy_hash_hex": "be572af01bd68df9c660da094b7796244dd29435d532c63c9f42efe6bdabd796",
      "event_log_verified": true,
      "gn_weight": 42,
      "hardware_id_hash_hex": "0404040404040404040404040404040404040404040404040404040404040404",
      "latency_ms": 500,
      "model_hash_hex": "0202020202020202020202020202020202020202020202020202020202020202",
      "output_hash_hex": "0303030303030303030303030303030303030303030303030303030303030303",
      "quote_verified": true,
      "task_hash_hex": "8d06cbf826718cda29c2ec2aa363ea13cebc118947eed5fa5d4dbb364357920d",
      "tee_type": {
        "name": "IntelTdx",
        "scale_tag": 0
      }
    },
    "report_data_hex": "3165c6d38fbf992485c8c8640476f9a7a5db94523a32387e838d205d178bfff70000000000000000000000000000000000000000000000000000000000000000",
    "report_data_preimage_hex": "8d06cbf826718cda29c2ec2aa363ea13cebc118947eed5fa5d4dbb364357920d2a00000000000000f40100000000000002020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303be572af01bd68df9c660da094b7796244dd29435d532c63c9f42efe6bdabd79600",
    "task_hash": {
      "hash_hex": "8d06cbf826718cda29c2ec2aa363ea13cebc118947eed5fa5d4dbb364357920d",
      "inputs": {
        "agent_account_id32_hex": "1111111111111111111111111111111111111111111111111111111111111111",
        "commit_hash_hex": "0606060606060606060606060606060606060606060606060606060606060606",
        "genesis_hash_hex": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "model_hash_hex": "0202020202020202020202020202020202020202020202020202020202020202",
        "nonce": 7,
        "payload_hash_hex": "0505050505050505050505050505050505050505050505050505050505050505"
      },
      "preimage_hex": "464c4f502f504f55492f5441534b01000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f11111111111111111111111111111111111111111111111111111111111111110700000000000000020202020202020202020202020202020202020202020202020202020202020205050505050505050505050505050505050505050505050505050505050505050606060606060606060606060606060606060606060606060606060606060606",
      "runtime_boundary": "producer-derived; runtime stores opaque H256 in ProcessedTasks"
    },
    "validator_attestation_scale_hex": "8d06cbf826718cda29c2ec2aa363ea13cebc118947eed5fa5d4dbb364357920d2a00000000000000f40100000000000002020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303be572af01bd68df9c660da094b7796244dd29435d532c63c9f42efe6bdabd7960001010404040404040404040404040404040404040404040404040404040404040404b41236c517514b30a4d6619f4b4354a2ce593cd4b64a7c29dd45e3de6972997a90cdb722faea5e0a46b6a4e4e332e14b5d80cd175c9293577c9a356bd8a98d0e774333666dc04cca932742e08a56e441aa4cdbadf4dabe3af0e8644e63e60b88",
    "validator_attestation_signable_hex": "8d06cbf826718cda29c2ec2aa363ea13cebc118947eed5fa5d4dbb364357920d2a00000000000000f40100000000000002020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303be572af01bd68df9c660da094b7796244dd29435d532c63c9f42efe6bdabd7960001010404040404040404040404040404040404040404040404040404040404040404",
    "validator_id_hex": "b41236c517514b30a4d6619f4b4354a2ce593cd4b64a7c29dd45e3de6972997a",
    "validator_signature_hex": "90cdb722faea5e0a46b6a4e4e332e14b5d80cd175c9293577c9a356bd8a98d0e774333666dc04cca932742e08a56e441aa4cdbadf4dabe3af0e8644e63e60b88"
  },
  "generation": {
    "public_vectors": "uv run --script evidence/generate-wire-format-vectors.py --check",
    "signature": "cargo run --quiet --manifest-path sdk/rust-compute-channel/Cargo.toml --example wire_signature",
    "vectors": "uv run --script scripts/generate_wire_format_vectors.py --check"
  },
  "negative_cases": [
    {
      "bytes_hex": "04",
      "expected": "reject",
      "id": "unknown_leaf_enum",
      "site": "SCALE decode"
    },
    {
      "bytes_hex": "02",
      "expected": "reject",
      "id": "unknown_retention_enum",
      "site": "SCALE decode"
    },
    {
      "bytes_hex": "464343343655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d280100000003ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff016666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff010000000000000094f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea72086",
      "expected": "reject",
      "id": "truncated_fcc4",
      "mutation": "drop final byte",
      "site": "TranscriptBlob.decode"
    },
    {
      "bytes_hex": "464343343655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d280100000003ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff016666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff010000000000000094f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea720860000",
      "expected": "reject",
      "id": "trailing_fcc4",
      "mutation": "append 00",
      "site": "TranscriptBlob.decode"
    },
    {
      "bytes_hex": "464343393655fa5a95712c31f0bd2380aa8193b30c78bd955e4e966abb0d9f49d66e8d280100000003ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff016666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff010000000000000094f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea7208600",
      "expected": "reject",
      "id": "unknown_fcc_version",
      "mutation": "FCC4 -> FCC9",
      "site": "TranscriptBlob.decode"
    },
    {
      "bytes_hex": "0803ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff6666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff010000000000000094f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea72086088ca5d489cec0a255a48a2e3c2149d8028597e03ea78628d9a3672ddb80df286900482735fe0838313af87270c7fa678a8fb6c3cf9d9e3af35b8c73ea39f279a92a0103ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff6666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff010000000000000094f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea72086088ca5d489cec0a255a48a2e3c2149d8028597e03ea78628d9a3672ddb80df286900482735fe0838313af87270c7fa678a8fb6c3cf9d9e3af35b8c73ea39f279a92a01",
      "expected": "reject DuplicateVerifiedTurn",
      "id": "duplicate_turn_index",
      "mutation": "repeat turn_index",
      "site": "verified_work_from_turns"
    },
    {
      "bytes_hex": "03ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff6666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff010000000000000094f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea72086088ca5d489cec0a255a48a2e3c2149d8028597e03ea78628d9a3672ddb80df286901482735fe0838313af87270c7fa678a8fb6c3cf9d9e3af35b8c73ea39f279a92a01",
      "expected": "reject LeafNotInRoot",
      "id": "wrong_path_orientation",
      "mutation": "flip sibling_is_left",
      "site": "verify_turn_proof/respond_dispute"
    },
    {
      "bytes_hex": "f7b859ec27672aa1bbe6dfc0b4c0fbeddf50dddc2d107a73a7dab0b5435e758b",
      "expected": "different channel_id",
      "id": "wrong_genesis_network",
      "mutation": "change genesis_hash",
      "site": "channel_id"
    },
    {
      "bytes_hex": "1dbc63e202e92143b6d8299f7da687b2a9d08d9554a1a8a3e9c3b0ce88247180",
      "expected": "different channel_id",
      "id": "wrong_session",
      "mutation": "change agent/miner/nonce",
      "site": "channel_id"
    },
    {
      "bytes_hex": "02ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff6666666666666666666666666666666666666666666666666666666666666666368e6eca01b76a510619dc2778d46860a9070c4a6ad73ef52e81c31dab5a404f7777777777777777777777777777777777777777777777777777777777777777fdfffffffffffffffeffffffffffffff010000000000000094f2f8b99c2080051b431786b410153a928c37eff5054d6e2ab5a109f4a69148d9113049764e517c2f9a1a8122a606a8366370f59440d3aabbfc289aeea72086088ca5d489cec0a255a48a2e3c2149d8028597e03ea78628d9a3672ddb80df286900482735fe0838313af87270c7fa678a8fb6c3cf9d9e3af35b8c73ea39f279a92a01",
      "expected": "reject LeafFieldsInconsistent",
      "id": "wrong_leaf_version",
      "mutation": "V3 fields with tag V2",
      "site": "verify_turn_proof/respond_dispute"
    },
    {
      "bytes_hex": "7903f98d0297c23f5df90f4bce093492de9658045d3d2296717a1e718e8bc40d891e60e517fdc459f59140b289d9fcba90809493875b5d8e77325b0ec9572683",
      "expected": "reject BadReceiptSignature",
      "id": "invalid_receipt_signature",
      "mutation": "flip signature byte",
      "site": "verify_receipt"
    },
    {
      "bytes_hex": "91cdb722faea5e0a46b6a4e4e332e14b5d80cd175c9293577c9a356bd8a98d0e774333666dc04cca932742e08a56e441aa4cdbadf4dabe3af0e8644e63e60b88",
      "expected": "reject BadValidatorSignature",
      "id": "invalid_validator_signature",
      "mutation": "flip signature byte",
      "site": "submit_validator_attestations/check_one"
    },
    {
      "bytes_hex": "01ffffffff33333333333333333333333333333333333333333333333333333333333333334444444444444444444444444444444444444444444444444444444444444444ffffffffffffffffffffffffffffffff000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000fdfffffffffffffffeffffffffffffff0100000000000000f0644a3f19b6ac702d30830163401c5a037010fa97231e19295de385acad4029ac534e04ed9fc181c0de77c5f10507ed1cd90dd3b1163a6fe24de2acca572986084a3632de6913f0502c6313499b29d0976b085a4612e14e017c5eaf065b1c6c2d005f0ff24a5b34ae51d68c9e76052c5aabc0b6715d0cf78b18383d56da2a6ff85200",
      "expected": "reject UnsupportedLeafVersion",
      "id": "legacy_leaf_current_channel",
      "mutation": "V0/V1 tag with pinned decode policy",
      "site": "verify_turn_proof/respond_dispute"
    },
    {
      "bytes_hex": "111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222222a000000000000000000000000000000e8030000000000000000000000000000a0f54ce7f97e6e8e76a4ddf6b8785ec5efd243b4a335b7954504a5c19faee620e881741ae3cfbb56cd503d17e91cd5406ffc1a8d7478108854cd781aade52687",
      "expected": "reject BadReceiptSignature",
      "id": "legacy_receipt_current_channel",
      "mutation": "remove receipt domain/version",
      "site": "verify_receipt"
    }
  ],
  "profile": "flop-wire-v1",
  "status": "public-canonical"
}
`;

const direct = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  if (process.argv[2] === "selftest") process.exit(selftest());
  console.error("usage: node deals/canal.mjs selftest");
  process.exit(1);
}
