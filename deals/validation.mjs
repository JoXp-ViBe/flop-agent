// SPDX-License-Identifier: Apache-2.0
//
// La famille « validation » : juger le livrable d'un autre agent contre la référence privée
// que le posteur nous confie. « Validators are the scarce role » (programme blockrewards) :
// +6 par verdict juste, −6 par verdict faux, scoré comme calibration. Ces offres restent
// ouvertes une dizaine de minutes et sont moins disputées : on peut se permettre de réfléchir
// AVANT d'accepter : l'oracle (un modèle léger, sans outils) rend PASS ou FAIL avec sa phrase, et
// l'offre n'est acceptée que si ce verdict a une forme exacte. Un budget serré mesure la
// justesse avant d'ouvrir plus grand.

import { demanderOracle } from "./oracle.mjs";
import { analyserDocs, lireDocument, extrait, urlAutorisee } from "./docs.mjs";

const entier = (nom, defaut) => { const v = Number(process.env[nom]); return Number.isFinite(v) && v >= 0 ? v : defaut; };
export const PLAFONDS_VALIDATION = { heure: entier("VALIDATION_MAX_PER_HOUR", 6), jour: entier("VALIDATION_MAX_PER_DAY", 30) };

/** L'ask d'une validation → {task, reference, deliverable}, ou null si la forme n'est pas celle attendue. */
export function analyserValidation(ask) {
  const a = String(ask ?? "");
  if (!/^Validate a deliverable\./.test(a)) return null;
  const mt = /TASK that was posted:\s*"([\s\S]*?)"\.\s*REFERENCE ANSWER/.exec(a);
  const mr = /REFERENCE ANSWER[^:]*:\s*"([\s\S]*?)"\.\s*DELIVERABLE/.exec(a);
  const md = /DELIVERABLE submitted by a worker:\s*"([\s\S]*?)"\.\s*Does the deliverable/.exec(a);
  if (!mt || !mr || !md) return null;
  return { task: mt[1].trim(), reference: mr[1].trim(), deliverable: md[1].trim() };
}

export function promptValidation({ task, reference, deliverable }, documentExtrait) {
  return "You are the validator of a task marketplace. Judge whether the DELIVERABLE gives the REFERENCE answer: " +
    "same values, order where order is asked, nothing invented. Formatting differences, quoting, extra explanation or a cited source line do not matter; a different value, a missing value or an invented value does.\n" +
    "TASK: " + task + "\n" +
    "REFERENCE ANSWER (private): " + reference + "\n" +
    "DELIVERABLE: " + deliverable + "\n" +
    (documentExtrait ? "DOCUMENT EXCERPT (the cited source, to resolve the reference if it is described rather than stated):\n" + documentExtrait + "\n" : "") +
    "Reply on ONE line, exactly in one of these two forms and nothing else:\n" +
    "PASS: <one sentence naming the exact match>\n" +
    "FAIL: <one sentence naming the exact discrepancy>";
}

/** « PASS: phrase » / « FAIL: phrase » normalisé, ou null. */
export function parseVerdict(texte) {
  const m = /^\s*(PASS|FAIL)\s*[\u2014\u2013:-]+\s*(.+?)\s*$/is.exec(String(texte ?? "").split("\n").filter((l) => l.trim())[0] ?? "");
  if (!m) return null;
  const phrase = m[2].replace(/\s+/g, " ").trim();
  if (phrase.length < 8 || phrase.length > 300) return null;
  return `${m[1].toUpperCase()}: ${phrase}`;
}

const compteurs = { heure: "", nHeure: 0, jour: "", nJour: 0 };
function fenetres() {
  const iso = new Date().toISOString();
  if (compteurs.heure !== iso.slice(0, 13)) { compteurs.heure = iso.slice(0, 13); compteurs.nHeure = 0; }
  if (compteurs.jour !== iso.slice(0, 10)) { compteurs.jour = iso.slice(0, 10); compteurs.nJour = 0; }
}
export function budgetValidation() {
  fenetres();
  return compteurs.nHeure < PLAFONDS_VALIDATION.heure && compteurs.nJour < PLAFONDS_VALIDATION.jour;
}

/** Le verdict à livrer, calculé AVANT d'accepter (l'oracle prend 12-20 s). Lève si l'oracle ne répond pas. */
export async function jugerValidation(spec) {
  const v = analyserValidation(spec.ask);
  if (!v || !budgetValidation()) return null;
  let doc = "";
  const d = analyserDocs(v.task);
  if (d && urlAutorisee(d.url)) {
    try { doc = extrait(await lireDocument(d.url), v.reference + " " + v.task); } catch { doc = ""; }
  }
  fenetres();
  compteurs.nHeure += 1; compteurs.nJour += 1;
  const r = await demanderOracle(promptValidation(v, doc));
  const verdict = parseVerdict(r.answer);
  return verdict ? { genre: "validation", reponse: verdict, tokens: r.usage?.total_tokens ?? null } : null;
}

export function selftest() {
  const cas = [];
  const ok = (nom, cond) => cas.push([nom, !!cond]);
  const ask = 'Validate a deliverable. TASK that was posted: "From https://raw.githubusercontent.com/flop-labs/technocore-chat/main/README.md: What is the default maximum wait time for long-polling in seconds?". REFERENCE ANSWER the task\'s author holds (private to you as validator): "The exact number stated as default for CHAT_MAX_WAIT". DELIVERABLE submitted by a worker: "1. "`CHAT_MAX_WAIT` | `10` | ceiling on `?wait=` seconds" (https://raw.githubusercontent.com/flop-labs/technocore-chat/main/README.md) ⏎ 2. 10". Does the deliverable give the reference answer (same values, order where order is asked, nothing invented)? Reply PASS or FAIL, then one sentence naming the exact match or the exact discrepancy.';
  const v = analyserValidation(ask);
  ok("analyser : les trois champs", v && v.task.startsWith("From https://raw") && v.reference.startsWith("The exact number") && v.deliverable.endsWith("2. 10"));
  ok("analyser : autre forme → null", analyserValidation("Validate this: is 2+2=4?") === null);
  ok("verdict PASS normalisé", parseVerdict("PASS \u2014 the deliverable states 10, the default of CHAT_MAX_WAIT.") === "PASS: the deliverable states 10, the default of CHAT_MAX_WAIT.");
  ok("verdict FAIL avec tiret simple", parseVerdict("FAIL - deliverable says 12 where the reference is 10") === "FAIL: deliverable says 12 where the reference is 10");
  ok("verdict sans phrase → null", parseVerdict("PASS") === null);
  ok("verdict bavard → null", parseVerdict("Sure! The answer is PASS because…") === null);
  ok("prompt porte les trois champs", promptValidation(v, "").includes("REFERENCE ANSWER (private): The exact number") && promptValidation(v, "").includes("DELIVERABLE: 1."));
  for (const [nom, res] of cas) console.log(`  ${nom.padEnd(40)} ${res ? "reussi" : "ECHOUE"}`);
  const echecs = cas.filter(([, r]) => !r).length;
  console.log(`selftest validation : ${cas.length - echecs}/${cas.length}`);
  return echecs ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("validation.mjs") && process.argv[2] === "selftest") process.exit(selftest());
