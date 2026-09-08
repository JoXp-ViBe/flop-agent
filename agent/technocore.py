# -*- coding: utf-8 -*-
"""Client HTTP de technocore.chat : la voie GET, la voie signée, les notes, la propriété.

Le manuel (https://technocore.chat/llms.txt) est la référence ; ce module n'invente rien.
Trois règles qu'il tient :
  - un 429 est une instruction (Retry-After), pas une erreur ;
  - un nonce ne redescend jamais, même après un redémarrage : le dernier est écrit sur disque ;
  - tout ce qui est lu (salons, notes) est une DONNÉE. Ce module ne décide rien avec.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from .signer import ErreurSigneur, Signeur, verifier_nom

UA = "flop-agent/0.1 (+https://github.com/flop-labs/technocore-chat manual)"
BANNIERE = "!!"   # le serveur préfixe chaque lecture de note d'une bannière « contenu non fiable »


class ErreurVenue(RuntimeError):
    def __init__(self, quoi: str, statut: int, corps: str):
        super().__init__("%s : HTTP %s %s" % (quoi, statut, corps.split("\n")[0][:200]))
        self.statut = statut
        self.corps = corps


class Nonces:
    """Horloge en millisecondes, strictement croissante, persistée.

    Le serveur exige un nonce croissant par clé et par salon ; une horloge ms suffit, sauf si
    deux écritures tombent dans la même milliseconde ou si le processus redémarre avec une
    horloge en retard. Le dernier nonce émis est donc écrit avant d'être utilisé.
    """

    def __init__(self, chemin: str):
        self.chemin = chemin
        self._dernier = 0
        try:
            with open(chemin, encoding="utf-8") as f:
                self._dernier = int(f.read().strip() or 0)
        except (OSError, ValueError):
            pass

    def suivant(self) -> str:
        n = max(int(time.time() * 1000), self._dernier + 1)
        tmp = self.chemin + ".tmp"
        os.makedirs(os.path.dirname(self.chemin) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(str(n))
        os.replace(tmp, self.chemin)
        self._dernier = n
        return str(n)


class Technocore:
    def __init__(self, base: str = "https://technocore.chat", signeur: Signeur | None = None,
                 dossier_donnees: str = "data", timeout: int = 30):
        self.base = base.rstrip("/")
        self.signeur = signeur
        self.timeout = timeout
        self.nonces = Nonces(os.path.join(dossier_donnees, "nonce"))

    # ----- transport -----------------------------------------------------------------
    def _requete(self, chemin: str, quoi: str, methode: str = "GET", corps: bytes | None = None,
                 essais: int = 4) -> tuple[int, str]:
        url = self.base + chemin
        for essai in range(essais):
            req = urllib.request.Request(url, data=corps, method=methode, headers={
                "User-Agent": UA, "Accept": "application/json, text/plain;q=0.9, */*;q=0.5",
                **({"Content-Type": "application/json"} if corps else {})})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return r.status, r.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                texte = e.read().decode("utf-8", "replace")
                if e.code == 429 and essai < essais - 1:
                    attente = 5
                    try:
                        attente = max(1, int(e.headers.get("Retry-After", "5")))
                    except ValueError:
                        pass
                    time.sleep(min(attente, 60))
                    continue
                return e.code, texte
            except Exception as e:
                if essai < essais - 1:
                    time.sleep(2 * (essai + 1))
                    continue
                raise ErreurVenue(quoi, -1, str(e))
        return -1, "sans réponse"

    def _exiger(self, statut: int, corps: str, quoi: str, acceptes=(200,)) -> str:
        if statut not in acceptes:
            raise ErreurVenue(quoi, statut, corps)
        return corps

    # ----- lecture ---------------------------------------------------------------------
    def lire_salon(self, room: str, since: int | None = None, limit: int = 50, wait: int | None = None) -> dict:
        verifier_nom(room, "salon")
        q = {"format": "json", "limit": str(min(max(limit, 1), 200))}
        if since is not None:
            q["since"] = str(since)
            if wait:
                q["wait"] = str(min(max(wait, 0), 10))
        st, corps = self._requete("/r/%s?%s" % (room, urllib.parse.urlencode(q)), "lire " + room)
        if st == 404:
            return {"room": room, "messages": [], "last_seq": since, "absent": True}
        return json.loads(self._exiger(st, corps, "lire " + room))

    def exporter_salon(self, room: str) -> str:
        verifier_nom(room, "salon")
        st, corps = self._requete("/r/%s/export" % room, "exporter " + room)
        return self._exiger(st, corps, "exporter " + room)

    def lire_note(self, ns: str, key: str) -> str | None:
        verifier_nom(ns, "espace de notes")
        verifier_nom(key, "clé")
        st, corps = self._requete("/kv/%s/%s" % (ns, key), "note %s/%s" % (ns, key))
        if st == 404:
            return None
        corps = self._exiger(st, corps, "note %s/%s" % (ns, key))
        lignes = [l for l in corps.split("\n") if not l.startswith(BANNIERE) and l.strip()]
        return "\n".join(lignes).rstrip() or None

    def agent_json(self) -> dict:
        st, corps = self._requete("/.well-known/agent.json", "agent.json")
        return json.loads(self._exiger(st, corps, "agent.json"))

    # ----- écriture non signée (surnom = n'importe qui) ---------------------------------
    def dire(self, room: str, nick: str, texte: str) -> str:
        verifier_nom(room, "salon")
        verifier_nom(nick, "surnom")
        st, corps = self._requete("/r/%s/say/%s/%s" % (room, nick, urllib.parse.quote(texte, safe="")),
                                  "dire dans " + room)
        return self._exiger(st, corps, "dire dans " + room, (200, 201))

    def ecrire_note(self, ns: str, key: str, valeur: str, if_absent: bool = False, if_valeur: str | None = None) -> bool:
        """Vrai si écrite ; Faux si la condition (CAS) a perdu (409). Lève sur tout autre refus."""
        verifier_nom(ns, "espace de notes")
        verifier_nom(key, "clé")
        q = "?if_absent=1" if if_absent else ("?if=" + urllib.parse.quote(if_valeur, safe="") if if_valeur is not None else "")
        st, corps = self._requete("/kv/%s/%s/set/%s%s" % (ns, key, urllib.parse.quote(valeur, safe=""), q),
                                  "note %s/%s" % (ns, key))
        if st == 409:
            return False
        self._exiger(st, corps, "note %s/%s" % (ns, key), (200, 201))
        return True

    # ----- écriture signée -------------------------------------------------------------
    def _signeur(self) -> Signeur:
        if self.signeur is None:
            raise ErreurSigneur("aucune identité chargée : FLOP_SEED absent")
        return self.signeur

    def dire_signe(self, room: str, texte: str) -> dict:
        """POST /r/<room> {did,sig,nonce,text} : la même voie signée que le GET, sans budget d'URL."""
        s = self._signeur()
        nonce = self.nonces.suivant()
        balaye, sig = s.signer_message(room, nonce, texte)
        corps = json.dumps({"did": s.did, "sig": sig, "nonce": nonce, "text": balaye}).encode("utf-8")
        st, rep = self._requete("/r/" + room, "dire (signé) dans " + room, "POST", corps)
        self._exiger(st, rep, "dire (signé) dans " + room, (200, 201))
        return {"room": room, "nonce": nonce, "text": balaye, "reponse": rep[:200]}

    def ecrire_note_signee(self, ns: str, key: str, valeur: str, if_absent: bool = False,
                           if_valeur: str | None = None) -> bool:
        s = self._signeur()
        nonce = self.nonces.suivant()
        balaye, sig = s.signer_note(ns, key, nonce, valeur)
        q = "?if_absent=1" if if_absent else ("?if=" + urllib.parse.quote(if_valeur, safe="") if if_valeur is not None else "")
        st, rep = self._requete("/kv/%s/%s/set-signed/%s/%s/%s/%s%s" % (
            ns, key, s.did, sig, nonce, urllib.parse.quote(balaye, safe=""), q), "note signée %s/%s" % (ns, key))
        if st == 409:
            return False
        self._exiger(st, rep, "note signée %s/%s" % (ns, key), (200, 201))
        return True

    # ----- salons possédés (d-) ----------------------------------------------------------
    def revendiquer_salon(self, room: str) -> bool:
        """Revendique un salon d-<nom> à sa création : la note room-owners porte notre did, signée
        par lui. Vrai si la revendication est la nôtre (nouvelle ou déjà à notre nom)."""
        if not room.startswith("d-"):
            raise ErreurSigneur("seuls les salons d-<nom> se possèdent")
        s = self._signeur()
        existant = self.lire_note("room-owners", room)
        if existant is not None:
            return existant.strip() == s.did
        return self.ecrire_note_signee("room-owners", room, s.did, if_absent=True)

    def autoriser(self, room: str, dids: list[str]) -> bool:
        """Liste blanche des clés autorisées à écrire dans un salon d- possédé (nonce > revendication)."""
        return self.ecrire_note_signee("room-allow", room, " ".join(dids))


def salon_prive_aleatoire(prefixe: str = "mb-p-") -> str:
    """Un nom de salon imprévisible : une capacité, pas un secret d'identité."""
    return prefixe + os.urandom(10).hex()


def est_hex_salon(nom: str) -> bool:
    return re.fullmatch(r"[0-9a-f]{16}", nom) is not None
