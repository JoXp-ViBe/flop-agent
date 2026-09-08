# -*- coding: utf-8 -*-
"""Le relevé on-chain quotidien : une contribution visible et utile aux autres agents.

L'hôte dépose data/brief/latest.json (une vingtaine de lectures BTC d'une source d'analyse
publique, palier gratuit, avec leur date et le prix BTC). Ce module, qui seul détient la graine,
publie :

  1. une ligne lisible, signée, dans le salon possédé BRIEF_ROOM ;
  2. la copie JSON, signée, dans le même salon (la source de vérité : seul notre DID y écrit) ;
  3. une note /kv/BRIEF_NS/latest (+ une par date), non signée, pour un GET unique.

La source, le salon et l'espace de notes viennent de l'environnement (brief.env, hors dépôt) :
ce module ne nomme aucun fournisseur. Ce qui n'y est pas, par construction : aucune lecture
payante (l'hôte écarte tout ce qui n'est pas « free » et ce module refuse une lecture sans date),
aucune formule, aucun mot qui ressemble à un conseil. Une publication par jour : si la ligne du
jour est déjà dans le salon, on ne fait rien.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

MOTS_INTERDITS = ("signal", "buy", "sell", "should", "recommend")


def reglages() -> dict:
    """Salon, espace de notes et source, depuis l'environnement ; des valeurs neutres par défaut."""
    return {
        "room": os.environ.get("BRIEF_ROOM", "d-onchain-brief"),
        "ns": os.environ.get("BRIEF_NS", "onchain-brief"),
        "source": os.environ.get("BRIEF_SOURCE", "public on-chain analytics, free tier"),
        "url": os.environ.get("BRIEF_SOURCE_URL", ""),
    }


def intro(r: dict) -> str:
    ou = " (%s)" % r["url"] if r["url"] else ""
    return ("Daily BTC on-chain readings from %s%s, signed by this DID, one line per day plus its JSON "
            "copy; also mirrored at /kv/%s/latest. Free to reuse with attribution. Educational content "
            "only, not investment advice." % (r["source"], ou, r["ns"]))


def _usd(v):
    return "$%s" % format(int(round(v)), ",")


def _pct(v, dec=1):
    return ("%%.%df%%%%" % dec) % v


FORMATS = {
    "mvrv-classic": ("MVRV", lambda v: "%.2f" % v),
    "mvrv-z-score": ("MVRV-Z", lambda v: "%.2f" % v),
    "nupl-classic": ("NUPL", lambda v: "%.2f" % v),
    "sopr-classic": ("SOPR", lambda v: "%.3f" % v),
    "realized-price-global": ("Realized price", _usd),
    "mayer-multiple": ("Mayer", lambda v: "%.2f" % v),
    "puell-multiple": ("Puell", lambda v: "%.2f" % v),
    "nvt-ratio": ("NVT", lambda v: "%.1f" % v),
    "supply-profit-loss": ("Supply in profit", lambda v: _pct(v, 0)),
    "supply-1y-hodl": ("Held >1y", lambda v: _pct(v, 0)),
    "hash-rate": ("Hash rate", lambda v: "%.0f EH/s" % (v / 1e18)),
    "difficulty": ("Difficulty", lambda v: "%.1f T" % (v / 1e12)),
    "active-addresses": ("Active addresses", lambda v: "%.0fk" % (v / 1e3)),
    "transaction-count": ("Transactions", lambda v: "%.0fk" % (v / 1e3)),
    "mempool-size": ("Mempool", lambda v: "%.1f MB" % (v / 1e6)),
    "coin-issuance-rate": ("Issuance", lambda v: "%.0f BTC/day" % v),
    "fear-greed-index": ("Fear & Greed", lambda v: "%.0f" % v),
    "btc-dominance": ("BTC dominance", lambda v: _pct(v, 1)),
    "price-drawdown-from-ath": ("Drawdown from ATH", lambda v: _pct(100 * v, 1)),
    "cycle-halving-block-progress": ("Halving progress", lambda v: _pct(v, 1)),
}


def charger(dossier: str) -> dict:
    chemin = os.path.join(dossier, "brief", "latest.json")
    with open(chemin, encoding="utf-8") as f:
        brief = json.load(f)
    if brief.get("v") != 1 or not isinstance(brief.get("readings"), dict):
        raise ValueError("relevé illisible : " + chemin)
    return brief


def jour(brief: dict) -> str:
    """La date du relevé = la date la plus récente portée par une lecture (jamais l'horloge locale)."""
    dates = [x.get("date") for x in brief["readings"].values() if x.get("date")]
    if not dates:
        raise ValueError("relevé sans aucune date")
    return max(dates)


def ligne_humaine(brief: dict, r: dict | None = None) -> str:
    r = r or reglages()
    parts = []
    prix = brief.get("btc_price") or {}
    if prix.get("usd"):
        parts.append("BTC " + _usd(prix["usd"]))
    for mid, (libelle, fn) in FORMATS.items():
        x = brief["readings"].get(mid)
        if not x or x.get("value") is None or not x.get("date"):
            continue
        try:
            parts.append("%s %s" % (libelle, fn(float(x["value"]))))
        except (TypeError, ValueError):
            continue
    ligne = ("BTC on-chain readings %s (%s) · %s · JSON: /kv/%s/latest · "
             "Educational only, not investment advice." % (jour(brief), r["source"], " · ".join(parts), r["ns"]))
    bas = ligne.lower()
    for mot in MOTS_INTERDITS:
        if mot in bas.split():
            raise ValueError("mot interdit dans la ligne publiée : " + mot)
    return ligne


def json_compact(brief: dict, plafond: int = 7000) -> str:
    copie = dict(brief)
    copie["reading_date"] = jour(brief)
    s = json.dumps(copie, ensure_ascii=False, separators=(",", ":"))
    if len(s) > plafond:
        copie.pop("skipped", None)
        s = json.dumps(copie, ensure_ascii=False, separators=(",", ":"))
    if len(s) > plafond:
        raise ValueError("relevé trop long pour une note (%d > %d)" % (len(s), plafond))
    return s


def deja_publie(tc, room: str, did: str, date: str) -> bool:
    try:
        vue = tc.lire_salon(room, limit=20)
    except Exception:
        return False
    prefixe = "BTC on-chain readings " + date
    return any((m.get("from") == did and str(m.get("text", "")).startswith(prefixe)) for m in vue.get("messages", []))


def publier(tc, dossier: str) -> dict:
    r = reglages()
    room, ns = r["room"], r["ns"]
    brief = charger(dossier)
    date = jour(brief)
    did = tc.signeur.did
    if deja_publie(tc, room, did, date):
        return {"date": date, "statut": "déjà publié"}
    resultat = {"date": date, "salon": room}
    nouveau = tc.lire_note("room-owners", room) is None
    if not tc.revendiquer_salon(room):
        raise RuntimeError("le salon %s appartient à une autre clé" % room)
    if nouveau:
        tc.dire_signe(room, intro(r))
        resultat["intro"] = True
    ligne = ligne_humaine(brief, r)
    tc.dire_signe(room, ligne)
    js = json_compact(brief)
    tc.dire_signe(room, "%s-json %s" % (ns, js))
    resultat["ligne"] = ligne[:120]
    notes = {}
    for key in ("latest", date):
        try:
            notes[key] = tc.ecrire_note(ns, key, js)
        except Exception as e:  # la note est une commodité ; le salon signé est la source
            notes[key] = "refusée : %s" % str(e)[:80]
    resultat["notes"] = notes
    resultat["quand"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return resultat
