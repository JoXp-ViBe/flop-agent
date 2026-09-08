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

    def valeur_note(self) -> str:
        """`<did> mailbox:<boîte> tclk1:<rails>` : la forme du manuel (patterns 3 et 6)."""
        return "%s mailbox:%s tclk1:%s" % (self.did, self.boite, self.rails)

    def note_publiee(self) -> str | None:
        return self.tc.lire_note(self.tc.signeur.ns_note, self.tc.signeur.key_note)

    def publier(self) -> dict:
        """Écrit la note DID (signée), l'ouvre la boîte d'une première ligne signée si besoin, relit."""
        s = self.tc.signeur
        attendue = self.valeur_note()
        actuelle = self.note_publiee()
        if actuelle is not None and actuelle.split("delegate:")[0].strip() == attendue:
            resultat = {"note": "inchangée"}
        else:
            # une note est une ligne : on conserve d'éventuelles délégations déjà publiées
            suffixe = ""
            if actuelle and "delegate:" in actuelle:
                suffixe = " delegate:" + actuelle.split("delegate:", 1)[1]
            # NON signée, par construction du serveur : « signed note writes are only accepted for
            # room-owners and room-allow. Every other namespace is world-writable » (mesuré le
            # 07/09/2026, HTTP 400). La note ne prouve rien par elle-même ; ce sont nos messages
            # signés qui la rendent crédible (manuel, pattern 3).
            self.tc.ecrire_note(s.ns_note, s.key_note, attendue + suffixe)
            resultat = {"note": "écrite"}
        relue = self.note_publiee()
        resultat["chemin"] = "/kv/%s/%s" % (s.ns_note, s.key_note)
        resultat["conforme"] = bool(relue and relue.startswith(attendue))
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
