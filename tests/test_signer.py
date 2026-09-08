# -*- coding: utf-8 -*-
"""Le port du signeur rend-il exactement ce que le script officiel rend ?

Les vecteurs ci-dessous ont été produits le 07/09/2026 par `scripts/sign.py` (dépôt
flop-labs/technocore-chat, commit de la v0.13.0) avec une graine de TEST :
    1111…1111 (64 fois « 1 »). Ce n'est l'identité de personne.

Si un vecteur casse, c'est le port qui a dérivé (ou l'officiel qui a changé de convention) :
dans les deux cas le serveur répondrait 403 et l'agent serait muet sans le savoir.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.signer import (ErreurSigneur, Signeur, balayer, canonique_message, chemin_note,  # noqa: E402
                          verifier_signature)

GRAINE_TEST = "1" * 64
DID_ATTENDU = "did:key:z6MktULudTtAsAhRegYPiZ6631RV3viv12qd4GQF8z1xB22S"
SIG_SAY = "mZWG1pXWqK_yrnnqGbx-rzoLF-OvQDR1mEqz2oy_IluQwu4VEvnZteiTWFEt4SDiYhyimaP7aeYpFPogEl3eCA"
SIG_SET = "1Lr3ZZQLzhZT9bYvdMUoc7GQYWaBNTvhnCLWYsdc8EcEeJOjFcCJVDAVstMMlSa6En82MKyi9ciJnE6LlKf2AQ"
SIG_DELEGATE = "e4_kGNJBZX_1RK9H0XN7dhLy-JGOefxJM4NQaebq3h3KrRNog0iyc47uCmFFuNxCt8Ra4aZ4BSNfT_xvH1dfCg"
AGENT_TEST = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"


def cas():
    s = Signeur(GRAINE_TEST)
    oui = []
    oui.append(("did", s.did == DID_ATTENDU, s.did))
    oui.append(("note", chemin_note(s.did) == ("did-d4", "1be86df874313a"), str(chemin_note(s.did))))
    texte, sig = s.signer_message("lobby", "1700000000000", "hello  world")
    oui.append(("say", sig == SIG_SAY and texte == "hello  world", sig[:20]))
    val, sig = s.signer_note("did-ab", "cdef01234567890", "1700000000001", "did:key:z6Mk mailbox:mb-p-x tclk1:paper")
    oui.append(("set", sig == SIG_SET, sig[:20]))
    # la délégation officielle a été émise avec expires = now+30j au moment du vecteur ; on
    # vérifie ici la SIGNATURE sur la chaîne canonique reconstruite, pas la date
    from agent.signer import canonique_delegation
    oui.append(("delegate", verifier_signature(s.did, canonique_delegation(s.did, AGENT_TEST, "r:lobby", "1791403619", "1700000000002"), SIG_DELEGATE), "vérifiée"))
    # balayage : un saut de ligne devient un espace, les extrémités sont rognées
    # « \n » (Cc) et U+200B (Cf) deviennent chacun un espace, puis les extrémités sont rognées
    oui.append(("balayage", balayer("  a\nb​ ", 10) == "a b", repr(balayer("  a\nb​ ", 10))))
    # dans l'autre sens : une signature sur le texte NON balayé ne vérifie pas le canonique
    _, sig_brut = s.signer_message("lobby", "1", "x y")
    oui.append(("negatif_texte", not verifier_signature(s.did, canonique_message("lobby", "1", "x  y"), sig_brut), "faux attendu"))
    oui.append(("negatif_salon", not verifier_signature(s.did, canonique_message("lobbx", "1", "x y"), sig_brut), "faux attendu"))
    for mauvais in ("", "abc", "1" * 63, "g" * 64):
        try:
            Signeur(mauvais)
            oui.append(("refus_graine", False, repr(mauvais[:8])))
        except ErreurSigneur:
            oui.append(("refus_graine", True, repr(mauvais[:8])))
    try:
        s.signer_message("Lobby", "1", "x")
        oui.append(("refus_salon", False, "Lobby accepté"))
    except ErreurSigneur:
        oui.append(("refus_salon", True, "Lobby refusé"))
    try:
        s.signer_message("lobby", "12a", "x")
        oui.append(("refus_nonce", False, "12a accepté"))
    except ErreurSigneur:
        oui.append(("refus_nonce", True, "12a refusé"))
    try:
        balayer("​\n", 10)
        oui.append(("refus_vide", False, "vide accepté"))
    except ErreurSigneur:
        oui.append(("refus_vide", True, "vide refusé"))
    return oui


def lancer() -> int:
    resultats = cas()
    echecs = [r for r in resultats if not r[1]]
    for nom, ok, detail in resultats:
        print("  %-14s %s  %s" % (nom, "reussi" if ok else "ECHOUE", detail))
    print("signeur : %d/%d" % (len(resultats) - len(echecs), len(resultats)))
    return 1 if echecs else 0


def test_vecteurs_officiels():
    assert all(r[1] for r in cas()), [r for r in cas() if not r[1]]


if __name__ == "__main__":
    sys.exit(lancer())
