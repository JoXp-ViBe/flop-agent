# -*- coding: utf-8 -*-
"""La note DID se tient à jour sans rien effacer de ce que ce code n'écrit pas, et elle se garde.

Cas réel du 10/09/2026 : la note porte nom, rôle, méthode, compte X et l'enregistrement
`flop-owner:` signé des deux clés. L'ancienne `publier()` la réécrivait depuis ses seuls jetons
(did, mailbox, tclk1) et relisait avec `startswith` : tout le reste partait en silence, et elle
répondait « conforme ». Et la note vit à un chemin que n'importe qui peut réécrire : la référence,
gardée dans le dossier d'état, la remet en place. Et la place efface ce qu'on n'écrit plus depuis
7 jours : l'entretien réécrit la note et ranime la boîte avant (cas entretien_*). Aucun réseau,
aucune graine.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.identity import Identite, _epoch, decision_note, fusionner_note, note_conforme  # noqa: E402
from agent.technocore import ErreurVenue  # noqa: E402

DID = "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S"   # identité de TEST (graine 1…1)
AUTRE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
CANON = ["mailbox:mb-p-abc", "tclk1:paper"]
RECORD = "flop-owner: sr25519 0x" + "ab" * 32 + " 1789078997 " + "A" * 86 + " " + "B" * 86
DELEG = "delegate: " + AUTRE + " r:lobby 1791403619 1700000000002 " + "C" * 86
RICHE = " ".join([DID, "name:Parallax", "role:observatory", "method:example.org", "x:handle",
                  "mailbox:mb-p-abc", "tclk1:paper", RECORD, DELEG])
MINIMALE = DID + " mailbox:mb-p-abc tclk1:paper"
CHEMIN = ("did-t0", "k")


class FauxTC:
    """La venue réduite à une note et à des salons : lecture, écriture conditionnelle (409 = False),
    lecture de salon comme le serveur (sans since : les derniers ; seq à partir de 1 ; 404 = absent)."""

    def __init__(self, did, note):
        self.signeur = type("S", (), {"did": did, "ns_note": CHEMIN[0], "key_note": CHEMIN[1]})()
        self.notes = {CHEMIN: note}
        self.ecrits = 0
        self.salons = {}        # salon -> messages {seq, ts, from, text}
        self.absents = set()    # salons effacés par la place
        self.dits = []
        self.lectures = 0
        self.refuse = False     # la place refuse d'écrire (plafond global de salons)
        self.note_en_panne = False

    def lire_note(self, ns, key):
        return self.notes.get((ns, key))

    def ecrire_note(self, ns, key, valeur, if_absent=False, if_valeur=None):
        if self.note_en_panne:
            raise ErreurVenue("note %s/%s" % (ns, key), 503, "503 unavailable")
        cur = self.notes.get((ns, key))
        if (if_absent and cur is not None) or (if_valeur is not None and cur != if_valeur):
            return False
        self.notes[(ns, key)] = valeur
        self.ecrits += 1
        return True

    def lire_salon(self, room, since=None, limit=50, wait=None):
        self.lectures += 1
        if room in self.absents:
            return {"room": room, "messages": [], "last_seq": since, "absent": True}
        msgs = self.salons.get(room, [])
        neufs = msgs if since is None else [m for m in msgs if m["seq"] > since]
        return {"room": room, "messages": neufs[-limit:], "last_seq": msgs[-1]["seq"] if msgs else since}

    def dire_signe(self, room, texte):
        if self.refuse:
            raise ErreurVenue("dire (signé) dans " + room, 400, "400 room limit reached")
        if room in self.absents:
            self.absents.discard(room)
            self.salons[room] = []      # un salon recréé repart de seq 1
        msgs = self.salons.setdefault(room, [])
        msgs.append({"seq": len(msgs) + 1, "ts": "2026-09-12T08:00:00Z", "from": self.signeur.did, "text": texte})
        self.dits.append((room, texte))
        return {}


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def message(seq, t, de):
    return {"seq": seq, "ts": iso(t), "from": de, "text": "x"}


def essai(f):
    """Une exception qui s'échappe est l'échec du cas, pas un plantage du lanceur."""
    try:
        return f()
    except Exception as e:  # noqa: BLE001
        return {"exception": repr(e)[:120]}


def identite(note, reference=None):
    dossier = tempfile.mkdtemp(prefix="ident-")
    with open(os.path.join(dossier, "identity.json"), "w", encoding="utf-8") as f:
        json.dump({"boite": "mb-p-abc", "boite_ouverte": 1}, f)
    if reference is not None:
        with open(os.path.join(dossier, "note_reference.txt"), "w", encoding="utf-8") as f:
            f.write(reference)
    tc = FauxTC(DID, note)
    return Identite(tc, dossier, "paper"), tc


def cas():
    oui = []
    # la note réelle, déjà à jour : rien à écrire, rien de perdu
    oui.append(("riche_intacte", fusionner_note(RICHE, DID, CANON) == RICHE, "égale"))
    # aucune note : la forme minimale
    oui.append(("absente", fusionner_note(None, DID, CANON) == MINIMALE, "minimale"))
    # nouvelle boîte : le jeton change À SA PLACE, tout le reste reste dans l'ordre
    neuve = fusionner_note(RICHE, DID, ["mailbox:mb-p-new", "tclk1:paper"])
    oui.append(("boite_remplacee", neuve == RICHE.replace("mailbox:mb-p-abc", "mailbox:mb-p-new"), "à sa place"))
    oui.append(("records_conserves", RECORD in neuve and DELEG in neuve, "flop-owner + delegate"))
    # un jeton absent s'ajoute en fin, sans rien déplacer
    sans_rail = RICHE.replace(" tclk1:paper", "")
    oui.append(("rail_ajoute", fusionner_note(sans_rail, DID, CANON) == sans_rail + " tclk1:paper", "en fin"))
    # un jeton en double se réduit à un
    oui.append(("doublon_retire", fusionner_note(RICHE + " mailbox:mb-p-old", DID, CANON) == RICHE, "un seul"))
    # la note d'un autre did (n'importe qui peut écrire ici) n'est pas la nôtre : forme minimale
    oui.append(("autre_did", fusionner_note(AUTRE + " name:x mailbox:mb-p-z", DID, CANON) == MINIMALE, "remplacée"))
    # conformité : notre did en tête et nos jetons présents, quel que soit le reste
    oui.append(("conforme_riche", note_conforme(RICHE, DID, CANON), "vrai attendu"))
    oui.append(("non_conforme_vide", not note_conforme(None, DID, CANON), "faux attendu"))
    oui.append(("non_conforme_autre", not note_conforme(AUTRE + " mailbox:mb-p-abc tclk1:paper", DID, CANON), "faux attendu"))
    oui.append(("non_conforme_boite", not note_conforme(RICHE, DID, ["mailbox:mb-p-new", "tclk1:paper"]), "faux attendu"))
    # décision face à la référence
    oui.append(("decision_sans_ref", decision_note(RICHE, None, DID) == "sans_reference", "sans_reference"))
    oui.append(("decision_ref_autre", decision_note(RICHE, AUTRE + " x", DID) == "sans_reference", "sans_reference"))
    oui.append(("decision_ok", decision_note(RICHE, RICHE, DID) == "ok", "ok"))
    oui.append(("decision_restaurer", decision_note(DID + " name:evil", RICHE, DID) == "restaurer"
                and decision_note(None, RICHE, DID) == "restaurer", "restaurer"))
    # garder : une note vandalisée revient telle que nous l'avons voulue, puis silence
    ident, tc = identite(DID + " name:evil", RICHE)
    g = ident.garder_note()
    oui.append(("garde_restaure", g.get("restauree") is True and tc.notes[CHEMIN] == RICHE
                and "avant" not in g, str(g.get("note"))))
    g2 = ident.garder_note()
    oui.append(("garde_silence_sur_intacte", g2.get("note") == "ok" and tc.ecrits == 1, str(g2.get("note"))))
    # plafond : on ne se bat pas sans fin contre un tiers qui réécrit
    ident, tc = identite(DID + " x", RICHE)
    ident.garder_note(max_jour=1)
    tc.notes[CHEMIN] = DID + " y"
    g3 = ident.garder_note(max_jour=1)
    oui.append(("garde_plafond", g3.get("restauree") is False and tc.notes[CHEMIN] == DID + " y", str(g3.get("raison"))))
    # sans référence : la garde ne touche à rien
    ident, tc = identite(DID + " x", None)
    oui.append(("garde_sans_ref", ident.garder_note().get("note") == "sans_reference" and tc.ecrits == 0, "rien"))
    # publier avec une référence : la note vandalisée revient, jetons à jour, référence rafraîchie
    ident, tc = identite(AUTRE + " name:evil", RICHE)
    r = ident.publier()
    oui.append(("publier_restaure", tc.notes[CHEMIN] == RICHE and r.get("conforme") is True
                and ident.lire_reference() == RICHE, str(r.get("note"))))
    # figer : seule une note conforme devient la référence
    ident, tc = identite(RICHE, None)
    oui.append(("figer_conforme", ident.figer_reference().get("figee") is True and ident.lire_reference() == RICHE, "figée"))
    ident, tc = identite(AUTRE + " x", None)
    oui.append(("figer_refuse", ident.figer_reference().get("figee") is False and ident.lire_reference() is None, "refusée"))
    # entretien : la place efface ce qui n'a pas été écrit depuis 7 jours ; au-delà de 3 jours on écrit
    T, J = 1789200000, 86400
    ident, tc = identite(RICHE, RICHE)
    ident.etat.update({"note_ecrite_le": T - J, "boite_ecrite_le": T - J, "boite_seq": 5})
    e = essai(lambda: ident.entretenir(maintenant=T))
    oui.append(("entretien_rien_si_recent", e == {} and tc.ecrits == 0 and not tc.dits and tc.lectures == 0, str(e)))
    ident.etat["note_ecrite_le"] = T - 4 * J
    e = essai(lambda: ident.entretenir(maintenant=T))
    oui.append(("entretien_note_reecrite", e == {"note": "reecrite"} and tc.ecrits == 1 and tc.notes[CHEMIN] == RICHE
                and ident.etat["note_ecrite_le"] == T and not tc.dits, str(e)))
    # une note altérée : c'est la garde qui la remet, l'entretien n'y touche pas
    ident, tc = identite(DID + " name:evil", RICHE)
    ident.etat.update({"note_ecrite_le": T - 4 * J, "boite_ecrite_le": T - J, "boite_seq": 5})
    e = essai(lambda: ident.entretenir(maintenant=T))
    oui.append(("entretien_laisse_la_garde", e == {} and tc.ecrits == 0, str(e)))
    # une panne de la place sur la note n'empêche pas l'entretien de la boîte
    ident, tc = identite(RICHE, RICHE)
    ident.etat.update({"note_ecrite_le": T - 4 * J, "boite_ecrite_le": T - 4 * J, "boite_seq": 5})
    tc.salons["mb-p-abc"] = [message(i, T - 5 * J, AUTRE) for i in range(1, 6)]
    tc.note_en_panne = True
    e = essai(lambda: ident.entretenir(maintenant=T))
    oui.append(("entretien_panne_note_isolee", e.get("note") == "echec" and e.get("boite") == "entretenue", str(e)))
    # boîte ancienne : une seule ligne, puis silence
    ident, tc = identite(RICHE, RICHE)
    ident.etat.update({"note_ecrite_le": T - J, "boite_ecrite_le": T - 4 * J, "boite_seq": 5})
    tc.salons["mb-p-abc"] = [message(i, T - 5 * J, AUTRE) for i in range(1, 6)]
    e = essai(lambda: ident.entretenir(maintenant=T))
    e2 = essai(lambda: ident.entretenir(maintenant=T + 60))
    oui.append(("entretien_boite_une_ligne", e.get("boite") == "entretenue" and e2 == {}
                and [x[1].split()[1] for x in tc.dits] == ["alive"], str(e)))
    # date inconnue mais dernier message récent : on lit, on retient, on n'écrit pas
    ident, tc = identite(RICHE, RICHE)
    ident.etat.update({"note_ecrite_le": T - J, "boite_seq": 5})
    tc.salons["mb-p-abc"] = [message(i, T - 3600, AUTRE) for i in range(1, 6)]
    e = essai(lambda: ident.entretenir(maintenant=T))
    oui.append(("entretien_boite_lue_recente", e == {} and not tc.dits
                and ident.etat.get("boite_ecrite_le") == T - 3600, str(e)))
    # la place refuse : l'échec se voit et la date ne bouge pas (nouvel essai au passage suivant)
    ident, tc = identite(RICHE, RICHE)
    ident.etat.update({"note_ecrite_le": T - J, "boite_ecrite_le": T - 4 * J, "boite_seq": 5})
    tc.salons["mb-p-abc"] = [message(i, T - 5 * J, AUTRE) for i in range(1, 6)]
    tc.refuse = True
    e = essai(lambda: ident.entretenir(maintenant=T))
    oui.append(("entretien_boite_refusee", e.get("boite") == "echec" and e.get("statut") == 400
                and ident.etat["boite_ecrite_le"] == T - 4 * J, str(e)))
    # boîte effacée, vue au relevé : recréée avec DEUX lignes (un salon sur son seul message part en 12 h)
    ident, tc = identite(RICHE, RICHE)
    ident.etat.update({"note_ecrite_le": T - J, "boite_ecrite_le": T - J, "boite_seq": 70})
    tc.absents.add("mb-p-abc")
    ident.relever_boite()
    e = essai(lambda: ident.entretenir(maintenant=T))
    oui.append(("entretien_boite_recreee", e.get("boite") == "recreee" and len(tc.salons.get("mb-p-abc", [])) == 2
                and ident.etat.get("boite_absente") is False, str(e)))
    # un salon resté sur son seul message, même récent, reçoit une seconde ligne
    ident, tc = identite(RICHE, RICHE)
    ident.etat.update({"note_ecrite_le": T - J, "boite_ecrite_le": T - 3600, "boite_seq": 1})
    tc.salons["mb-p-abc"] = [message(1, T - 3600, DID)]
    e = essai(lambda: ident.entretenir(maintenant=T))
    oui.append(("entretien_boite_seul_message", e.get("boite") == "entretenue" and len(tc.salons["mb-p-abc"]) == 2, str(e)))
    # le relevé date la boîte avec toute ligne neuve, et ne rend pas nos propres lignes comme du courrier
    ident, tc = identite(RICHE, RICHE)
    ident.etat.update({"boite_seq": 3})
    tc.salons["mb-p-abc"] = [message(1, T - 9 * J, AUTRE), message(2, T - 8 * J, AUTRE), message(3, T - 7 * J, AUTRE),
                              message(4, T - 7200, AUTRE), message(5, T - 60, DID)]
    neufs = essai(lambda: ident.relever_boite(sans_nous=True))
    vus = [m.get("seq") for m in neufs] if isinstance(neufs, list) else neufs
    oui.append(("releve_sans_nous", vus == [4] and ident.etat.get("boite_ecrite_le") == T - 60
                and ident.etat.get("boite_seq") == 5, str(vus)))
    # la garde date sa propre écriture : l'entretien ne réécrit pas derrière elle
    ident, tc = identite(DID + " name:evil", RICHE)
    ident.garder_note()
    oui.append(("garde_date_l_ecriture", (ident.etat.get("note_ecrite_le") or 0) > 0, "note_ecrite_le"))
    # la boucle relit l'état : les clés écrites par un autre processus ne s'effacent plus
    ident, tc = identite(RICHE, RICHE)
    autre = Identite(tc, os.path.dirname(ident.chemin), "paper")
    autre.etat["note_publiee_le"] = 7
    autre._ecrire()
    ident.recharger()
    ident.etat["presence_le"] = 8
    ident._ecrire()
    with open(ident.chemin, encoding="utf-8") as f:
        disque = json.load(f)
    oui.append(("recharger_garde_les_cles", disque.get("note_publiee_le") == 7 and disque.get("presence_le") == 8,
                str(sorted(disque))))
    # une lecture ratée ne fait pas perdre la boîte (une boîte neuve, c'est l'ancienne adresse morte)
    os.remove(ident.chemin)
    oui.append(("recharger_lecture_ratee", ident.recharger() is False and ident.etat.get("boite") == "mb-p-abc",
                "boîte gardée"))
    # l'horodatage de la place, au format réel (microsecondes, suffixe Z)
    oui.append(("epoch_format_reel", _epoch("2026-09-10T22:32:53.085797Z") == 1789079573
                and _epoch("n'importe quoi") is None and _epoch(None) is None,
                str(_epoch("2026-09-10T22:32:53.085797Z"))))
    return oui


def lancer() -> int:
    resultats = cas()
    echecs = [r for r in resultats if not r[1]]
    for nom, ok, detail in resultats:
        print("  %-26s %s  %s" % (nom, "reussi" if ok else "ECHOUE", detail))
    print("note DID : %d/%d" % (len(resultats) - len(echecs), len(resultats)))
    return 1 if echecs else 0


def test_note_fusion():
    assert all(r[1] for r in cas()), [r for r in cas() if not r[1]]


if __name__ == "__main__":
    sys.exit(lancer())
