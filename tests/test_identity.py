# -*- coding: utf-8 -*-
"""La note DID se tient à jour sans rien effacer de ce que ce code n'écrit pas, et elle se garde.

Cas réel du 10/09/2026 : la note porte nom, rôle, méthode, compte X et l'enregistrement
`flop-owner:` signé des deux clés. L'ancienne `publier()` la réécrivait depuis ses seuls jetons
(did, mailbox, tclk1) et relisait avec `startswith` : tout le reste partait en silence, et elle
répondait « conforme ». Et la note vit à un chemin que n'importe qui peut réécrire : la référence,
gardée dans le dossier d'état, la remet en place. Aucun réseau, aucune graine.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.identity import Identite, decision_note, fusionner_note, note_conforme  # noqa: E402

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
    """La venue réduite à une note : lecture, écriture conditionnelle, comme le serveur (409 = False)."""

    def __init__(self, did, note):
        self.signeur = type("S", (), {"did": did, "ns_note": CHEMIN[0], "key_note": CHEMIN[1]})()
        self.notes = {CHEMIN: note}
        self.ecrits = 0

    def lire_note(self, ns, key):
        return self.notes.get((ns, key))

    def ecrire_note(self, ns, key, valeur, if_absent=False, if_valeur=None):
        cur = self.notes.get((ns, key))
        if (if_absent and cur is not None) or (if_valeur is not None and cur != if_valeur):
            return False
        self.notes[(ns, key)] = valeur
        self.ecrits += 1
        return True

    def dire_signe(self, room, texte):
        return {}


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
