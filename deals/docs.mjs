// SPDX-License-Identifier: Apache-2.0
//
// La famille « docs » : « From <url>: <question> » — répondre en citant la valeur ou la phrase
// exacte du document (llms.txt, openapi.json, README du dépôt tclk…). Mesuré le 07/09/2026 :
// ~290 offres par demi-heure, sous des étiquettes variées (extraction, document, review,
// status, documentation, packages…, et même « protocol »), une trentaine de questions qui
// reviennent sans cesse.
//
// La règle qui gouverne tout : ON N'ACCEPTE QUE CE QU'ON SAIT DÉJÀ. Une réponse est demandée à
// l'oracle en ARRIÈRE-PLAN, hors de toute offre, vérifiée comme sous-chaîne littérale du
// document, puis mise en cache. Une offre n'est acceptée que si sa question est en cache et
// vérifiée : l'accept part en moins d'une seconde (le payeur verrouille le premier acceptant),
// une mauvaise réponse ne peut pas être livrée (elle coûterait −5), et chaque question distincte
// ne coûte qu'UN appel à l'abonnement, jamais un par tâche.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./signing.mjs";
import { journal } from "./venue.mjs";
import { demanderOracle } from "./oracle.mjs";

const CACHE = join(DATA_DIR, "oracle_cache.json");
const TTL_DOC_MS = 30 * 60_000;
const MAX_DOC = 400_000;
const MAX_EXTRAIT = 7000;
const entier = (nom, defaut) => { const v = Number(process.env[nom]); return Number.isFinite(v) && v >= 0 ? v : defaut; };
export const PLAFONDS = { heure: entier("ORACLE_MAX_PER_HOUR", 20), jour: entier("ORACLE_MAX_PER_DAY", 80), essais: 3 };

/** Les seuls hôtes dont on va lire un document : la venue et les dépôts du réseau. */
export function urlAutorisee(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "https:") return false;
  const h = url.hostname.toLowerCase();
  if (h === "technocore.chat" || h === "flop.finance" || h === "flop-market.pages.dev") return true;
  if (h === "raw.githubusercontent.com" || h === "github.com") return /^\/flop-labs\//.test(url.pathname);
  return false;
}

/** « From <url>: <question> » → {url, question}, ou null. */
export function analyserDocs(ask) {
  const m = /^From\s+(https?:\/\/\S+?):?\s+(\S.*?)\s*$/s.exec(ask ?? "");
  if (!m) return null;
  const url = m[1].replace(/[),.;]+$/, "");
  const question = m[2].replace(/\s+/g, " ").trim();
  if (!urlAutorisee(url) || question.length < 8 || question.length > 400) return null;
  return { url, question };
}

export const normaliser = (s) => String(s ?? "").toLowerCase().replace(/[`"'“”‘’]/g, "").replace(/\s+/g, " ").trim().replace(/[.;:?!]+$/, "");
export const cle = (url, question) => url + "\n" + normaliser(question);

// ----- cache persistant des réponses vérifiées -------------------------------------------------
let cache = null;
function chargerCache() {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(CACHE, "utf8")); } catch { cache = {}; }
  return cache;
}
function sauverCache() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CACHE + ".tmp", JSON.stringify(cache));
  renameSync(CACHE + ".tmp", CACHE);
}
export function reponseVerifiee(url, question) {
  const e = chargerCache()[cle(url, question)];
  return e && e.verified && typeof e.answer === "string" ? e.answer : null;
}

// ----- documents -------------------------------------------------------------------------------
const docs = new Map();
export async function lireDocument(url) {
  const d = docs.get(url);
  if (d && Date.now() - d.ts < TTL_DOC_MS) return d.text;
  const res = await fetch(url, { headers: { "user-agent": "flop-agent docs/0.1" } });
  if (!res.ok) throw new Error(`document ${url} : HTTP ${res.status}`);
  const text = (await res.text()).slice(0, MAX_DOC);
  docs.set(url, { text, ts: Date.now() });
  return text;
}

const VIDES = new Set(["what", "which", "does", "from", "that", "this", "with", "have", "your", "into", "when", "where", "there", "their", "about", "many", "much", "value", "default", "maximum", "minimum", "number", "allowed"]);
/** Les lignes du document qui portent les mots de la question, avec une ligne de contexte. */
export function extrait(doc, question) {
  if (doc.length <= MAX_EXTRAIT) return doc;
  const mots = [...new Set(normaliser(question).replace(/[^a-z0-9_ .-]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !VIDES.has(w)))];
  const lignes = doc.split("\n");
  const score = lignes.map((l) => { const n = l.toLowerCase(); return mots.reduce((s, w) => s + (n.includes(w) ? 1 : 0), 0); });
  const idx = score.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, 30).map(([, i]) => i);
  const garder = new Set();
  for (const i of idx) { garder.add(i); if (i > 0) garder.add(i - 1); if (i + 1 < lignes.length) garder.add(i + 1); }
  let out = "";
  for (const i of [...garder].sort((a, b) => a - b)) {
    const l = lignes[i].slice(0, 400);
    if (out.length + l.length + 1 > MAX_EXTRAIT) break;
    out += l + "\n";
  }
  return out || doc.slice(0, MAX_EXTRAIT);
}

export function prompt(url, question, texte) {
  return "You answer from the DOCUMENT only. Question: " + question + "\n" +
    "Reply with exactly the value or phrase as written in the document, on one line, nothing else — no quotes, no explanation. " +
    "If the document does not contain the answer, reply exactly: NOT FOUND.\n" +
    "DOCUMENT (excerpt of " + url + "):\n" + texte;
}

/** La réponse est-elle littéralement dans le document ? Rend le texte original du document, ou null. */
export function verifier(answer, doc) {
  const a = normaliser(answer);
  if (!a || a.length > 200 || a === "not found" || /^not found/.test(a)) return null;
  const motif = a.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const m = new RegExp(motif, "i").exec(doc.replace(/[`"'“”‘’]/g, ""));
  if (!m) return null;
  return m[0].replace(/\s+/g, " ").trim();
}

// ----- la file d'arrière-plan -----------------------------------------------------------------
const file = new Map();          // clé → {url, question}
let enCours = false;
let pauseJusqua = 0;             // le démon a dit « plafond » : on se tait jusqu'à l'heure suivante, sans brûler d'essai
const compteurs = { heure: "", nHeure: 0, jour: "", nJour: 0 };

export function demanderPlusTard(url, question) {
  const k = cle(url, question);
  const c = chargerCache()[k];
  if (c && (c.verified || (c.tries ?? 0) >= PLAFONDS.essais)) return false;
  if (!file.has(k)) file.set(k, { url, question });
  return true;
}

export function planDocs(spec) {
  const d = analyserDocs(spec.ask);
  if (!d) return null;
  const reponse = reponseVerifiee(d.url, d.question);
  if (reponse !== null) return { genre: "docs", reponse, url: d.url };
  demanderPlusTard(d.url, d.question);
  return null;
}

function fenetres() {
  const iso = new Date().toISOString();
  if (compteurs.heure !== iso.slice(0, 13)) { compteurs.heure = iso.slice(0, 13); compteurs.nHeure = 0; }
  if (compteurs.jour !== iso.slice(0, 10)) { compteurs.jour = iso.slice(0, 10); compteurs.nJour = 0; }
}

/** Une question à la fois, hors du chemin des offres. Appelée à chaque tour de boucle, sans await. */
export async function traiterFile(stats) {
  if (enCours || file.size === 0 || Date.now() < pauseJusqua) return;
  fenetres();
  if (compteurs.nHeure >= PLAFONDS.heure || compteurs.nJour >= PLAFONDS.jour) return;
  enCours = true;
  const [k, { url, question }] = file.entries().next().value;
  file.delete(k);
  const c = chargerCache();
  const entree = c[k] ?? { answer: null, verified: false, tries: 0 };
  try {
    const doc = await lireDocument(url);
    compteurs.nHeure += 1; compteurs.nJour += 1;
    entree.tries = (entree.tries ?? 0) + 1;
    let r = await demanderOracle(prompt(url, question, extrait(doc, question)));
    let original = verifier(r.answer, doc);
    // l'extrait pouvait manquer la ligne utile : une seconde lecture sur le document entier, s'il tient
    if (original === null && doc.length > MAX_EXTRAIT && doc.length <= 40000) {
      compteurs.nHeure += 1; compteurs.nJour += 1;
      r = await demanderOracle(prompt(url, question, doc));
      original = verifier(r.answer, doc);
    }
    entree.answer = original ?? r.answer;
    entree.verified = original !== null;
    entree.ts = new Date().toISOString();
    entree.usage = r.usage?.total_tokens ?? null;
    if (stats) { stats.oracle_questions = (stats.oracle_questions ?? 0) + 1; if (entree.verified) stats.oracle_verifiees = (stats.oracle_verifiees ?? 0) + 1; }
    journal("oracle", { url, question: question.slice(0, 120), answer: String(r.answer).slice(0, 160), verified: entree.verified, tokens: entree.usage, duree_s: r.duree_s ?? null });
  } catch (e) {
    const detail = String(e.message ?? e).slice(0, 200);
    if (/plafond/.test(detail)) {
      // pas un échec de la question : on la remet en file et on attend l'heure suivante
      entree.tries = Math.max(0, (entree.tries ?? 1) - 1);
      file.set(k, { url, question });
      pauseJusqua = Math.ceil(Date.now() / 3600_000) * 3600_000 + 30_000;
      journal("oracle_pause", { detail, jusqua: new Date(pauseJusqua).toISOString() });
    } else {
      entree.tries = (entree.tries ?? 0) + 1;
      entree.error = detail;
      journal("oracle_error", { url, question: question.slice(0, 120), detail });
    }
  } finally {
    c[k] = entree;
    sauverCache();
    enCours = false;
  }
}

export function etatDocs() {
  const c = chargerCache();
  const v = Object.values(c);
  return { questions: v.length, verifiees: v.filter((e) => e.verified).length, en_attente: file.size, heure: compteurs.nHeure, jour: compteurs.nJour };
}

// ----- self-test (sans réseau) ----------------------------------------------------------------
export function selftest() {
  const cas = [];
  const ok = (nom, cond) => cas.push([nom, !!cond]);
  const d = analyserDocs("From https://technocore.chat/openapi.json: What is the maximum length allowed for a room name?");
  ok("analyser : url + question", d && d.url === "https://technocore.chat/openapi.json" && d.question.startsWith("What is the maximum"));
  ok("analyser : hôte étranger refusé", analyserDocs("From https://evil.example/x: What is the license?") === null);
  ok("analyser : github hors flop-labs refusé", analyserDocs("From https://raw.githubusercontent.com/autre/repo/main/README.md: What?") === null);
  ok("analyser : dépôt flop-labs accepté", analyserDocs("From https://raw.githubusercontent.com/flop-labs/tclk/main/README.md: What is the license of the project?") !== null);
  ok("analyser : pas une question doc", analyserDocs("Compute gcd(4, 6) and lcm(4, 6).") === null);
  const doc = "ROOM NAMES: names must match ^[a-z0-9][a-z0-9_-]{0,47}$ (48 characters max).\nRETENTION: rooms are a ring.\nlicense: Apache-2.0";
  ok("verifier : sous-chaîne exacte", verifier("48 characters max", doc) === "48 characters max");
  ok("verifier : casse et guillemets tolérés", verifier("“Apache-2.0”", doc) === "Apache-2.0");
  ok("verifier : invention refusée", verifier("64 characters", doc) === null);
  ok("verifier : NOT FOUND refusé", verifier("NOT FOUND", doc) === null);
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} filler text without the answer`).join("\n") + "\nThe maximum length allowed for a room name is 48.\n";
  const ex = extrait(long, "What is the maximum length allowed for a room name?");
  ok("extrait : la ligne utile survit au découpage", ex.includes("room name is 48") && ex.length <= 7000);
  ok("clé : normalisée", cle("u", "What IS  the license?") === cle("u", "what is the license"));
  for (const [nom, res] of cas) console.log(`  ${nom.padEnd(44)} ${res ? "reussi" : "ECHOUE"}`);
  const echecs = cas.filter(([, r]) => !r).length;
  console.log(`selftest docs : ${cas.length - echecs}/${cas.length}`);
  return echecs ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("docs.mjs") && process.argv[2] === "selftest") process.exit(selftest());
