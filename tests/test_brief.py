# -*- coding: utf-8 -*-
import json

import pytest

from agent import brief

R = {"room": "d-onchain-brief", "ns": "onchain-brief", "source": "public on-chain analytics, free tier", "url": ""}


def releve():
    return {"v": 1, "published": "2026-09-08T07:35Z", "asset": "BTC",
            "btc_price": {"usd": 79159.83, "date": "2026-09-07"},
            "readings": {
                "mvrv-z-score": {"name": "MVRV Z-Score", "value": 0.8753508901029321, "date": "2026-09-07"},
                "mvrv-classic": {"name": "MVRV", "value": 1.48135, "date": "2026-09-08"},
                "hash-rate": {"name": "Hash rate", "value": 7.98287253282e+20, "date": "2026-09-08"},
                "mempool-size": {"name": "Mempool", "value": 12298507.0, "date": "2026-09-08"},
                "price-drawdown-from-ath": {"name": "Drawdown", "value": -0.3650573531064331, "date": "2026-09-07"},
                "supply-profit-loss": {"name": "Supply in profit", "value": 69.06471846756932, "date": "2026-09-07"},
            },
            "source": "s", "reuse": "r", "disclaimer": "d", "skipped": []}


def test_ligne_humaine_units():
    l = brief.ligne_humaine(releve(), R)
    assert l.startswith("BTC on-chain readings 2026-09-08 (public on-chain analytics, free tier)")
    assert "BTC $79,160" in l and "MVRV 1.48" in l and "MVRV-Z 0.88" in l
    assert "Hash rate 798 EH/s" in l and "Mempool 12.3 MB" in l
    assert "Drawdown from ATH -36.5%" in l and "Supply in profit 69%" in l
    assert "JSON: /kv/onchain-brief/latest" in l
    assert l.endswith("Educational only, not investment advice.")


def test_reglages_viennent_de_l_environnement(monkeypatch):
    monkeypatch.setenv("BRIEF_ROOM", "d-x")
    monkeypatch.setenv("BRIEF_NS", "x")
    monkeypatch.setenv("BRIEF_SOURCE", "Source X, free tier")
    r = brief.reglages()
    assert (r["room"], r["ns"]) == ("d-x", "x")
    assert "Source X, free tier" in brief.ligne_humaine(releve(), r) and "/kv/x/latest" in brief.intro(r)


def test_jour_est_la_date_la_plus_recente_des_lectures():
    assert brief.jour(releve()) == "2026-09-08"


def test_ligne_refuse_un_mot_de_conseil():
    r = releve()
    r["readings"]["mvrv-classic"]["date"] = "2026-09-08 buy"  # la date entre dans la ligne
    with pytest.raises(ValueError):
        brief.ligne_humaine(r, R)


def test_json_compact_sous_le_plafond_et_relisible():
    s = brief.json_compact(releve())
    j = json.loads(s)
    assert j["reading_date"] == "2026-09-08" and "\n" not in s and len(s) < 7000


def test_json_trop_long_leve():
    r = releve()
    r["skipped"] = ["x" * 8000]
    r["source"] = "y" * 8000
    with pytest.raises(ValueError):
        brief.json_compact(r)
