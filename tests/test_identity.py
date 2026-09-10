# -*- coding: utf-8 -*-
"""La note DID se tient à jour sans rien effacer de ce que ce code n'écrit pas.

Cas réel du 10/09/2026 : la note porte nom, rôle, méthode, compte X et l'enregistrement
`flop-owner:` signé des deux clés. L'ancienne `publier()` la réécrivait depuis ses seuls jetons
(did, mailbox, tclk1) et relisait avec `startswith` : tout le reste partait en silence, et elle
répondait « conforme ». Aucun réseau, aucune graine.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.identity import fusionner_note, note_conforme  # noqa: E402

DID = "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S"   # identité de TEST (graine 1…1)
AUTRE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
CANON = ["mailbox:mb-p-abc", "tclk1:paper"]
RECORD = "flop-owner: sr25519 0x" + "ab" * 32 + " 1789078997 " + "A" * 86 + " " + "B" * 86
DELEG = "delegate: " + AUTRE + " r:lobby 1791403619 1700000000002 " + "C" * 86
RICHE = " ".join([DID, "name:Parallax", "role:observatory", "method:example.org", "x:handle",
                  "mailbox:mb-p-abc", "tclk1:paper", RECORD, DELEG])
MINIMALE = DID + " mailbox:mb-p-abc tclk1:paper"


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
    return oui


def lancer() -> int:
    resultats = cas()
    echecs = [r for r in resultats if not r[1]]
    for nom, ok, detail in resultats:
        print("  %-18s %s  %s" % (nom, "reussi" if ok else "ECHOUE", detail))
    print("note DID : %d/%d" % (len(resultats) - len(echecs), len(resultats)))
    return 1 if echecs else 0


def test_note_fusion():
    assert all(r[1] for r in cas()), [r for r in cas() if not r[1]]


if __name__ == "__main__":
    sys.exit(lancer())
