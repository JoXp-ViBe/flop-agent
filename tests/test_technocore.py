# -*- coding: utf-8 -*-
"""Un 429 dont le Retry-After se compte en dizaines de minutes se rend tout de suite ; un 429 court se
réessaie. Le 10/09, le budget de création de salons (Retry-After ~1 000 s) faisait attendre quatre fois
60 s une réponse qui ne pouvait pas changer, et la publication du relevé dépassait son délai."""
import http.server
import threading
import time

import pytest

from agent.technocore import Technocore


class _Venue(http.server.BaseHTTPRequestHandler):
    reponses = []

    def do_GET(self):
        code, retry = self.reponses.pop(0) if self.reponses else (200, None)
        self.send_response(code)
        if retry is not None:
            self.send_header("Retry-After", str(retry))
        self.end_headers()
        self.wfile.write(b"x")

    def log_message(self, *args):
        pass


def _venue(reponses):
    _Venue.reponses = list(reponses)
    srv = http.server.HTTPServer(("127.0.0.1", 0), _Venue)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_429_long_se_rend_tout_de_suite(tmp_path):
    srv = _venue([(429, 1800), (200, None)])
    tc = Technocore("http://127.0.0.1:%d" % srv.server_port, None, str(tmp_path))
    t0 = time.time()
    st, _ = tc._requete("/r/x", "essai")
    srv.shutdown()
    assert st == 429 and time.time() - t0 < 5


def test_429_court_est_reessaye(tmp_path):
    srv = _venue([(429, 1), (200, None)])
    tc = Technocore("http://127.0.0.1:%d" % srv.server_port, None, str(tmp_path))
    st, _ = tc._requete("/r/x", "essai")
    srv.shutdown()
    assert st == 200


def test_base_https_seulement(tmp_path):
    """urlopen ouvrirait file:// : la base de la place est https, http seulement vers la machine locale."""
    for refusee in ("file:///etc/passwd", "ftp://technocore.chat", "http://technocore.chat",
                    "http://localhost.example.org", "https://"):
        with pytest.raises(ValueError):
            Technocore(refusee, None, str(tmp_path))
    assert Technocore("https://technocore.chat/", None, str(tmp_path)).base == "https://technocore.chat"
    assert Technocore("http://127.0.0.1:8080", None, str(tmp_path)).base == "http://127.0.0.1:8080"
