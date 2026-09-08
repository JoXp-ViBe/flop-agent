# -*- coding: utf-8 -*-
"""flop-agent — ligne de commande.

  python -m agent status              identité, note publiée, boîte, curseurs (lecture seule)
  python -m agent publish             publie ou rafraîchit la note DID + ouvre la boîte
  python -m agent claim               revendique le salon d-<FLOP_ROOM>
  python -m agent presence            un passage : relève la boîte, écrit la note de présence
  python -m agent loop                presence toutes les FLOP_PERIODE secondes (défaut 1800)
  python -m agent mailbox             affiche les messages neufs de la boîte (données)
  python -m agent delegate DID SCOPE JOURS   ligne de délégation à coller dans la note
  python -m agent selftest            vecteurs officiels du signeur, sans réseau ni graine
  python -m agent brief               publie le relevé on-chain du jour (data/brief/latest.json) dans le salon BRIEF_ROOM

Variables : FLOP_SEED (64 hex, Bitwarden), TECHNOCORE_URL, FLOP_ROOM (d-...), FLOP_RAILS (paper),
FLOP_DATA (dossier d'état, défaut ./data), FLOP_PERIODE.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone

from .identity import Identite
from .signer import ErreurSigneur, Signeur
from .technocore import ErreurVenue, Technocore

JOURNAL = "journal.jsonl"


def journal(dossier: str, evenement: str, **champs) -> None:
    """Une ligne par fait, datée : ce que l'agent a fait et vu. Jamais la graine, jamais un secret."""
    os.makedirs(dossier, exist_ok=True)
    with open(os.path.join(dossier, JOURNAL), "a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                            "evt": evenement, **champs}, ensure_ascii=False) + "\n")


def contexte(exige_cle: bool = True):
    dossier = os.environ.get("FLOP_DATA", "data")
    base = os.environ.get("TECHNOCORE_URL", "https://technocore.chat")
    signeur = None
    try:
        signeur = Signeur.depuis_env()
    except ErreurSigneur as e:
        if exige_cle:
            print("identité : %s" % e, file=sys.stderr)
            sys.exit(2)
    tc = Technocore(base, signeur, dossier)
    ident = Identite(tc, dossier, os.environ.get("FLOP_RAILS", "paper"), os.environ.get("FLOP_ROOM", ""))
    return dossier, tc, ident


def cmd_status() -> int:
    dossier, tc, ident = contexte(exige_cle=False)
    print("venue      : %s (v%s)" % (tc.base, tc.agent_json().get("version", "?")))
    if tc.signeur is None:
        print("identité   : AUCUNE (FLOP_SEED absent) — lecture seule")
        return 0
    print("did        : %s" % ident.did)
    print("note       : /kv/%s/%s" % (tc.signeur.ns_note, tc.signeur.key_note))
    print("publiée    : %s" % (ident.note_publiee() or "(absente)"))
    print("attendue   : %s" % ident.valeur_note())
    print("boîte      : %s (seq vu : %s)" % (ident.boite, ident.etat.get("boite_seq")))
    print("salon      : %s" % (ident.salon_possede or "(FLOP_ROOM non défini)"))
    ns, key = ident.ns_presence()
    print("présence   : /kv/%s/%s = %s" % (ns, key, tc.lire_note(ns, key) or "(absente)"))
    return 0


def cmd_publish() -> int:
    dossier, tc, ident = contexte()
    r = ident.publier()
    journal(dossier, "publish", **r)
    print(json.dumps(r, ensure_ascii=False))
    return 0 if r.get("conforme") else 1


def cmd_claim() -> int:
    dossier, tc, ident = contexte()
    r = ident.revendiquer()
    journal(dossier, "claim", **r)
    print(json.dumps(r, ensure_ascii=False))
    return 0 if r.get("possede") else 1


def cmd_presence(une_fois: bool = True) -> int:
    dossier, tc, ident = contexte()
    periode = int(os.environ.get("FLOP_PERIODE", "1800"))
    while True:
        try:
            msgs = ident.relever_boite()
            for m in msgs:
                journal(dossier, "mailbox", seq=m.get("seq"), ts=m.get("ts"), de=m.get("from"),
                        did=m.get("did"), texte=(m.get("text") or "")[:500])
            ok = ident.presence("mailbox:%d" % len(msgs))
            journal(dossier, "presence", ok=ok, nouveaux=len(msgs))
            print("%s présence %s, %d message(s) neuf(s)" % (
                datetime.now(timezone.utc).strftime("%H:%M"), "écrite" if ok else "REFUSÉE", len(msgs)))
        except (ErreurVenue, ErreurSigneur) as e:
            journal(dossier, "erreur", detail=str(e)[:300])
            print("erreur : %s" % e, file=sys.stderr)
            if une_fois:
                return 2
        if une_fois:
            return 0
        time.sleep(periode)


def cmd_mailbox() -> int:
    dossier, tc, ident = contexte()
    for m in ident.relever_boite():
        print("%s seq=%s %s | %s" % (m.get("ts", "")[:19], m.get("seq"), m.get("did") or m.get("from"),
                                     (m.get("text") or "")[:300]))
    return 0


def cmd_delegate(args: list[str]) -> int:
    if len(args) < 3:
        print("usage : delegate <did:key agent> <scope> <jours>", file=sys.stderr)
        return 2
    dossier, tc, ident = contexte()
    print("# à ajouter (séparé par un espace) à /kv/%s/%s" % (tc.signeur.ns_note, tc.signeur.key_note))
    print(tc.signeur.deleguer(args[0], args[1], int(args[2])))
    return 0


def cmd_brief() -> int:
    """Le relevé du jour, déposé par l'hôte, publié signé dans le salon possédé + note /kv."""
    from .brief import publier
    dossier, tc, _ident = contexte()
    r = publier(tc, dossier)
    journal(dossier, "brief", **r)
    print(json.dumps(r, ensure_ascii=False))
    return 0


def cmd_selftest() -> int:
    from tests import test_signer
    return test_signer.lancer()


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    try:
        if cmd == "status":
            return cmd_status()
        if cmd == "publish":
            return cmd_publish()
        if cmd == "claim":
            return cmd_claim()
        if cmd == "presence":
            return cmd_presence(True)
        if cmd == "loop":
            return cmd_presence(False)
        if cmd == "mailbox":
            return cmd_mailbox()
        if cmd == "delegate":
            return cmd_delegate(args)
        if cmd == "selftest":
            return cmd_selftest()
        if cmd == "brief":
            return cmd_brief()
    except ErreurVenue as e:
        print("la venue a refusé : %s" % e, file=sys.stderr)
        return 3
    except ErreurSigneur as e:
        print("signeur : %s" % e, file=sys.stderr)
        return 2
    print(__doc__)
    return 2
