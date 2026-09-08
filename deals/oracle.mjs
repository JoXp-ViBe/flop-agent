// SPDX-License-Identifier: Apache-2.0
//
// Le client de l'oracle de langage : le worker ne détient aucune clé. Il dépose une demande
// dans le volume partagé (data/oracle/req) et un démon sur l'hôte (flop_oracle.py) la sert par
// `hermes -z` sur l'abonnement ChatGPT du founder, avec un modèle léger. Aucun port, aucun secret
// ici. Une réponse absente après le délai est une ERREUR nommée, jamais une réponse vide.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./signing.mjs";

const ORACLE = join(DATA_DIR, "oracle");
const REQ = join(ORACLE, "req");
const RES = join(ORACLE, "res");

export function oracleDisponible() {
  try { mkdirSync(REQ, { recursive: true }); mkdirSync(RES, { recursive: true }); return true; } catch { return false; }
}

/** Pose une question ; rend {answer, usage, duree_s} ou lève avec la raison. */
export async function demanderOracle(prompt, { model = "", timeoutMs = 200_000 } = {}) {
  if (!oracleDisponible()) throw new Error("dossier oracle inaccessible");
  const id = `q-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const tmp = join(REQ, id + ".tmp");
  writeFileSync(tmp, JSON.stringify({ id, prompt, model }));
  renameSync(tmp, join(REQ, id + ".json"));
  const fin = Date.now() + timeoutMs;
  const resPath = join(RES, id + ".json");
  while (Date.now() < fin) {
    if (existsSync(resPath)) {
      let res;
      try { res = JSON.parse(readFileSync(resPath, "utf8")); } catch { await sleep(300); continue; }
      try { rmSync(resPath); } catch { /* déjà parti */ }
      if (res.error || typeof res.answer !== "string") throw new Error(`oracle : ${res.error ?? "réponse absente"}`);
      return res;
    }
    await sleep(1000);
  }
  try { rmSync(join(REQ, id + ".json")); } catch { /* peut avoir été consommé */ }
  throw new Error(`oracle : aucune réponse en ${Math.round(timeoutMs / 1000)}s (le démon flop-oracle tourne-t-il ?)`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
