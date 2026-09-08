# -*- coding: utf-8 -*-
"""Signeur Ed25519 did:key pour la voie signée de technocore.chat.

Port fidèle de `scripts/sign.py` du dépôt officiel flop-labs/technocore-chat (Apache-2.0),
réduit à ce qu'un agent en service utilise : la chaîne canonique, le did:key, le chemin de la
note d'identité, la délégation. Les vecteurs de `tests/test_signer.py` sont produits par le
script officiel lui-même : si ce port dérive, le test le dit avant le serveur (403).

CE QUI EST PLUS STRICT QUE L'OFFICIEL, ET POURQUOI
  La graine doit être 64 caractères hexadécimaux. Le script officiel accepte aussi une phrase
  et la hache : pratique pour une démo, mauvais pour une identité qui vaut un airdrop. Ici une
  identité vient de `sign.py keygen`, rangée dans Bitwarden, injectée par FLOP_SEED. Jamais
  générée par ce code, jamais écrite sur le disque, jamais dans un journal.

CHAÎNES CANONIQUES (ce que le serveur vérifie, sur le texte APRÈS balayage)
  message   <room>|<nonce>|<texte balayé>
  note      <ns>|<key>|<nonce>|<valeur balayée>
  délégation delegate|<root-did>|<agent-did>|<scope>|<expires>|<nonce>   (jamais vérifiée par le serveur)
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import time
import unicodedata

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

PREFIX = "did:key:z6Mk"
MULTICODEC_ED25519 = b"\xed\x01"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
INVISIBLE_CATEGORIES = ("Cc", "Cf", "Cs", "Co", "Zl", "Zp")
MAX_TEXT_CHARS = 4096
MAX_VALUE_CHARS = 8192
NAME_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}")
NONCE_RE = re.compile(r"[0-9]{1,19}")
SCOPE_RE = re.compile(r"\*|r:[a-z0-9][a-z0-9_-]{0,47}|kv:[a-z0-9][a-z0-9_-]{0,47}")
DELEGATE_TOKEN = "delegate:"


class ErreurSigneur(ValueError):
    """Ce que le serveur refuserait de toute façon, dit ici avant le réseau."""


def balayer(texte: str, limite: int) -> str:
    """Le texte tel que le serveur le stocke : invisibles → espace, extrémités rognées."""
    propre = "".join(" " if unicodedata.category(c) in INVISIBLE_CATEGORIES else c for c in texte).strip()
    if not propre:
        raise ErreurSigneur("rien de visible après le balayage : le serveur refuse cette écriture")
    if len(propre) > limite:
        raise ErreurSigneur("%d caractères après balayage, au-dessus du plafond de %d" % (len(propre), limite))
    return propre


def multibase(brut: bytes) -> str:
    n = int.from_bytes(brut, "big")
    out = ""
    while n:
        n, reste = divmod(n, 58)
        out = B58[reste] + out
    return out


def unbase58(brut: str) -> bytes:
    n = 0
    for ch in brut:
        d = B58.find(ch)
        if d < 0:
            raise ErreurSigneur("did:key invalide : %r n'est pas du base58btc" % ch)
        n = n * 58 + d
    return n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""


def did_of(cle: Ed25519PrivateKey) -> str:
    # public_bytes(Raw, Raw) plutôt que public_bytes_raw() : cette dernière n'existe qu'à partir
    # de cryptography 40, et l'image Debian bookworm embarque la 38 (mesuré le 07/09 dans le conteneur)
    brut = cle.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    mb = "z" + multibase(MULTICODEC_ED25519 + brut)
    if len(mb) != 48:
        raise ErreurSigneur("longueur multibase inattendue %d" % len(mb))
    return "did:key:" + mb


def cle_publique(did: str) -> Ed25519PublicKey:
    if not did.startswith("did:key:z"):
        raise ErreurSigneur("did:key attendu (did:key:z6Mk...), reçu %r" % did[:24])
    mb = did[len("did:key:"):]
    if len(mb) != 48:
        raise ErreurSigneur("did:key : 48 caractères multibase attendus, %d reçus" % len(mb))
    decode = unbase58(mb[1:])
    if len(decode) != 34 or not decode.startswith(MULTICODEC_ED25519):
        raise ErreurSigneur("did:key : seules les clés ed25519-pub (z6Mk...) sont acceptées")
    return Ed25519PublicKey.from_public_bytes(decode[2:])


def empreinte(did: str) -> str:
    """16 premiers hex de SHA-256 de la CHAÎNE did:key (pas des octets de la clé)."""
    cle_publique(did)
    return hashlib.sha256(did.encode()).hexdigest()[:16]


def chemin_note(did: str) -> tuple[str, str]:
    """(ns, key) de la note d'identité : /kv/did-<2 hex>/<14 hex>."""
    e = empreinte(did)
    return "did-" + e[:2], e[2:]


def signature_b64url(cle: Ed25519PrivateKey, message: str) -> str:
    """86 caractères base64url sans remplissage, ce que SIG_RE du serveur attend."""
    return base64.urlsafe_b64encode(cle.sign(message.encode("utf-8"))).decode().rstrip("=")


def canonique_message(room: str, nonce: str, texte_balaye: str) -> str:
    return "%s|%s|%s" % (room, nonce, texte_balaye)


def canonique_note(ns: str, key: str, nonce: str, valeur_balayee: str) -> str:
    return "%s|%s|%s|%s" % (ns, key, nonce, valeur_balayee)


def canonique_delegation(root: str, agent: str, scope: str, expires: str, nonce: str) -> str:
    return "delegate|%s|%s|%s|%s|%s" % (root, agent, scope, expires, nonce)


def verifier_nom(nom: str, quoi: str = "nom") -> str:
    if not NAME_RE.fullmatch(nom):
        raise ErreurSigneur("%s invalide %r : attendu ^[a-z0-9][a-z0-9_-]{0,47}$" % (quoi, nom))
    return nom


def verifier_nonce(nonce: str) -> str:
    if not NONCE_RE.fullmatch(nonce):
        raise ErreurSigneur("nonce : 1 à 19 chiffres ASCII attendus, reçu %r" % nonce)
    return nonce


class Signeur:
    """Une identité en mémoire. La graine n'est lue qu'ici et n'en ressort jamais."""

    def __init__(self, seed_hex: str):
        if not re.fullmatch(r"[0-9a-fA-F]{64}", seed_hex or ""):
            raise ErreurSigneur("FLOP_SEED doit être 64 caractères hexadécimaux (sortie de `sign.py keygen`)")
        self._cle = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed_hex))
        self.did = did_of(self._cle)
        self.ns_note, self.key_note = chemin_note(self.did)

    @classmethod
    def depuis_env(cls, variable: str = "FLOP_SEED") -> "Signeur":
        seed = os.environ.get(variable, "")
        if not seed:
            raise ErreurSigneur("%s absent : aucune identité chargée" % variable)
        return cls(seed)

    def __repr__(self) -> str:
        return "Signeur(%s)" % self.did   # jamais la graine

    def signer_message(self, room: str, nonce: str, texte: str) -> tuple[str, str]:
        """(texte balayé, signature) pour /r/<room>/say-signed/<did>/<sig>/<nonce>/<texte>."""
        verifier_nom(room, "salon")
        verifier_nonce(nonce)
        balaye = balayer(texte, MAX_TEXT_CHARS)
        return balaye, signature_b64url(self._cle, canonique_message(room, nonce, balaye))

    def signer_note(self, ns: str, key: str, nonce: str, valeur: str) -> tuple[str, str]:
        """(valeur balayée, signature) pour /kv/<ns>/<key>/set-signed/<did>/<sig>/<nonce>/<valeur>."""
        verifier_nom(ns, "espace de notes")
        verifier_nom(key, "clé")
        verifier_nonce(nonce)
        balaye = balayer(valeur, MAX_VALUE_CHARS)
        return balaye, signature_b64url(self._cle, canonique_note(ns, key, nonce, balaye))

    def deleguer(self, agent_did: str, scope: str, jours: int, nonce: str | None = None) -> str:
        """Une ligne `delegate: ...` à ajouter à sa propre note d'identité."""
        if not SCOPE_RE.fullmatch(scope):
            raise ErreurSigneur("scope invalide %r : '*', 'r:<salon>' ou 'kv:<ns>'" % scope)
        if not 1 <= int(jours) <= 3650:
            raise ErreurSigneur("jours : 1 à 3650")
        cle_publique(agent_did)
        if agent_did == self.did:
            raise ErreurSigneur("une clé ne se délègue pas à elle-même")
        nonce = verifier_nonce(nonce or str(int(time.time() * 1000)))
        expires = str(int(time.time()) + int(jours) * 86400)
        sig = signature_b64url(self._cle, canonique_delegation(self.did, agent_did, scope, expires, nonce))
        return "%s %s %s %s %s %s" % (DELEGATE_TOKEN, agent_did, scope, expires, nonce, sig)


def verifier_signature(did: str, message: str, sig_b64url: str) -> bool:
    """Vrai si `sig` signe `message` par la clé de `did`. Ne lève jamais : du faux est attendu."""
    try:
        cle_publique(did).verify(base64.urlsafe_b64decode(sig_b64url + "=="), message.encode("utf-8"))
        return True
    except Exception:
        return False
