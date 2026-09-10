# -*- coding: utf-8 -*-
"""L'identité publique de l'agent sur technocore.chat : la note DID, la boîte aux lettres, le
salon possédé, la note de présence.

Ce que le réseau récompense (Hayes, AMA du 02/09/2026) n'est pas d'exister mais d'être utile :
« creating more DIDs does nothing unless you use the flop ». Ce module ne fait donc qu'une chose
visible, une fois : publier une identité lisible par les autres agents, avec une boîte où ils
peuvent écrire et l'annonce qu'on parle tclk/1. Le reste (les contrats) se joue ailleurs.

État local (data/identity.json) : la boîte aux lettres et les curseurs. Jamais la graine.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

from .technocore import Technocore, salon_prive_aleatoire


def fusionner_note(actuelle: str | None, did: str, canoniques: list[str]) -> str:
    """La note à écrire : notre did en tête, nos jetons à jour, et TOUT le reste conservé tel quel.

    La note porte des champs que ce code n'écrit pas (nom, rôle, méthode, compte X, l'enregistrement
    `flop-owner:` signé des deux clés, des délégations) : les réécrire depuis nos seuls jetons les
    effacerait en silence. Un jeton canonique présent change à sa place, un absent s'ajoute en fin,
    un doublon disparaît. Une note qui ne commence pas par notre did n'est pas la nôtre (n'importe
    qui peut écrire à ce chemin) : elle est remplacée par la forme minimale.
    """
    jetons = actuelle.split() if actuelle else []
    if not jetons or jetons[0] != did:
        jetons = [did]
    for canon in canoniques:
        prefixe = canon.split(":", 1)[0] + ":"
        places = [i for i, j in enumerate(jetons) if j.startswith(prefixe)]
        if not places:
            jetons.append(canon)
            continue
        jetons[places[0]] = canon
        for i in reversed(places[1:]):
            del jetons[i]
    return " ".join(jetons)


def note_conforme(note: str | None, did: str, canoniques: list[str]) -> bool:
    """Vrai si la note est la nôtre (did en tête) et porte chacun de nos jetons, quel que soit le reste."""
    jetons = note.split() if note else []
    return bool(jetons) and jetons[0] == did and all(c in jetons for c in canoniques)


class Identite:
    def __init__(self, tc: Technocore, dossier: str = "data", rails: str = "paper", salon_possede: str = ""):
        self.tc = tc
        self.chemin = os.path.join(dossier, "identity.json")
        self.rails = rails
        self.salon_possede = salon_possede
        self.etat = self._charger()

    def _charger(self) -> dict:
        try:
            with open(self.chemin, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _ecrire(self) -> None:
        os.makedirs(os.path.dirname(self.chemin) or ".", exist_ok=True)
        tmp = self.chemin + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.etat, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.chemin)

    @property
    def did(self) -> str:
        return self.tc.signeur.did

    @property
    def boite(self) -> str:
        """La boîte aux lettres : mb-p-<imprévisible>. Signée obligatoire (mb-), jamais listée (p-)."""
        if not self.etat.get("boite"):
            self.etat["boite"] = salon_prive_aleatoire("mb-p-")
            self._ecrire()
        return self.etat["boite"]

    def jetons_canoniques(self) -> list[str]:
        """Les deux jetons que ce code tient à jour : la boîte et les rails (manuel, patterns 3 et 6)."""
        return ["mailbox:%s" % self.boite, "tclk1:%s" % self.rails]

    def valeur_note(self) -> str:
        """La forme minimale `<did> mailbox:<boîte> tclk1:<rails>`, écrite quand il n'y a pas de note."""
        return " ".join([self.did] + self.jetons_canoniques())

    def note_publiee(self) -> str | None:
        return self.tc.lire_note(self.tc.signeur.ns_note, self.tc.signeur.key_note)

    def publier(self) -> dict:
        """Tient nos jetons à jour dans la note DID sans rien effacer d'autre, ouvre la boîte, relit."""
        s = self.tc.signeur
        canoniques = self.jetons_canoniques()
        actuelle = self.note_publiee()
        voulue = fusionner_note(actuelle, self.did, canoniques)
        if actuelle is not None and voulue == actuelle:
            resultat = {"note": "inchangée"}
        else:
            # NON signée, par construction du serveur : « signed note writes are only accepted for
            # room-owners and room-allow. Every other namespace is world-writable » (mesuré le
            # 07/09/2026, HTTP 400). La note ne prouve rien par elle-même ; ce sont nos messages
            # signés qui la rendent crédible (manuel, pattern 3).
            # Écriture conditionnelle : si la note a bougé depuis la lecture, rien n'est écrasé.
            ecrite = self.tc.ecrire_note(s.ns_note, s.key_note, voulue,
                                         if_absent=actuelle is None, if_valeur=actuelle)
            resultat = {"note": "écrite" if ecrite else "changée entre lecture et écriture : rien d'écrit"}
        relue = self.note_publiee()
        resultat["chemin"] = "/kv/%s/%s" % (s.ns_note, s.key_note)
        resultat["conforme"] = note_conforme(relue, self.did, canoniques)
        if not self.etat.get("boite_ouverte"):
            # la boîte n'existe qu'à sa première écriture ; une ligne signée l'ouvre et
            # compte dans le budget de 20 salons neufs par jour et par IP
            self.tc.dire_signe(self.boite, "mailbox open " + datetime.now(timezone.utc).strftime("%Y-%m-%d"))
            self.etat["boite_ouverte"] = int(time.time())
            self._ecrire()
            resultat["boite"] = "ouverte"
        else:
            resultat["boite"] = "déjà ouverte"
        self.etat["note_publiee_le"] = int(time.time())
        self._ecrire()
        return resultat

    def revendiquer(self) -> dict:
        """Le salon possédé d-<nom> (FLOP_ROOM) : revendiqué à la création, liste blanche = nous."""
        if not self.salon_possede:
            return {"salon": None, "raison": "FLOP_ROOM non défini"}
        room = self.salon_possede
        proprietaire = self.tc.revendiquer_salon(room)
        if not proprietaire:
            return {"salon": room, "possede": False, "raison": "déjà revendiqué par une autre clé"}
        if not self.etat.get("salon_ouvert"):
            self.tc.dire_signe(room, "room open " + datetime.now(timezone.utc).strftime("%Y-%m-%d"))
            self.etat["salon_ouvert"] = int(time.time())
            self._ecrire()
        return {"salon": room, "possede": True, "proprietaire": self.tc.lire_note("room-owners", room)}

    def ns_presence(self) -> tuple[str, str]:
        """La note de présence : un espace par identité, une clé `status`, réécrite et jamais
        répétée en salon (manuel, pattern 7)."""
        from .signer import empreinte
        return "st-" + empreinte(self.did)[:12], "status"

    def presence(self, resume: str) -> bool:
        ns, key = self.ns_presence()
        valeur = "alive %s %s" % (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), resume)
        ok = self.tc.ecrire_note(ns, key, valeur)   # les notes ordinaires refusent la voie signée (400)
        self.etat["presence_le"] = int(time.time())
        self._ecrire()
        return ok

    def relever_boite(self, limite: int = 200) -> list[dict]:
        """Les messages neufs de la boîte, depuis le dernier seq vu. Rendus tels quels : DONNÉES."""
        since = self.etat.get("boite_seq")
        vue = self.tc.lire_salon(self.boite, since=since, limit=limite)
        msgs = vue.get("messages", [])
        if since is None:
            # premier relevé : on prend le curseur sans relire l'historique comme du neuf
            msgs = []
        if vue.get("last_seq") is not None:
            self.etat["boite_seq"] = vue["last_seq"]
            self._ecrire()
        return msgs
