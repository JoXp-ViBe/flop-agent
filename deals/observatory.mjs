// SPDX-License-Identifier: Apache-2.0
//
// Ce que le tableau tclk contient vraiment, mesuré sur son anneau d'export.
//
// Pourquoi : le 09/09/2026 nous avons découvert que près de la moitié des trames signées de la place
// étaient illisibles pour notre agent : un défaut de lecture chez nous, pas chez leurs auteurs. En le
// corrigeant nous avons vu un tableau différent de celui que nous croyions observer depuis deux jours.
// Un agent qui ne mesure pas ce qu'il rate croit mesurer tout. D'où cet observatoire.
//
//   node deals/observatory.mjs            mesure et écrit observatory/data.json
//   node deals/observatory.mjs selftest   les fonctions pures, sans réseau
//
// Aucun secret n'entre ici : la lecture du tableau est publique et anonyme, aucune clé n'est chargée.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalMessage, protegerNonce } from "./signing_public.mjs";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.TECHNOCORE_URL ?? "https://technocore.chat").replace(/\/$/, "");
const SALON = process.env.OBSERVATORY_ROOM ?? "tclk-offers";
// La page est servie par GitHub Pages depuis `docs/` : le nom du dossier est une convention
// de la plateforme, pas un choix editorial. L URL publique, elle, ne le montre pas.
const SORTIE = process.env.OBSERVATORY_OUT ?? join(RACINE, "docs", "data.json");
const HISTOIRE = process.env.OBSERVATORY_HISTORY ?? join(RACINE, "docs", "history.json");

// ----- lecture ---------------------------------------------------------------------------------

/** L'export brut, avec réessais. Sur un runner public, un hoquet réseau n'est pas un défaut de
 *  mesure. Mesuré le 10/09 : 8,5 Mo récupérés en 2 s depuis une machine saine, et pourtant un run
 *  a été abandonné à 60 s sur un runner GitHub. Un seul essai transformait donc un incident réseau
 *  en run rouge et en heure de mesure perdue. L'échec final nomme sa cause, parce que « pas de
 *  réponse » et « la place a refusé » ne sont pas le même état. */
async function exportBrut(salon, essais = 3) {
  const causes = [];
  for (let n = 1; n <= essais; n += 1) {
    try {
      const res = await fetch(`${BASE}/r/${salon}/export`, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`la place a refusé : HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      const message = String(e?.message ?? e);
      const cause = e?.name === "TimeoutError" || /timeout|abort/i.test(message) ? "pas de réponse dans les 90 s" : message;
      causes.push(`essai ${n} : ${cause}`);
      if (n < essais) await new Promise((r) => setTimeout(r, n * 5000));
    }
  }
  throw new Error(`export ${salon} : ${essais} essais sans succès (${causes.join(" ; ")})`);
}


/** L'anneau retenu du salon, en JSONL. Le nonce est protégé AVANT le parse (cf. §nonce). */
export async function lireAnneau(salon = SALON) {
  const lignes = (await exportBrut(salon)).split("\n");
  const naif = [];
  const exact = [];
  for (const l of lignes) {
    if (!l.trim()) continue;
    // deux lectures de la MÊME ligne : celle qu'un agent écrit naïvement obtient, et la bonne.
    try { naif.push(JSON.parse(l)); } catch { continue; }
    try { exact.push(JSON.parse(protegerNonce(l))); } catch { /* ligne tronquée en fin d'anneau */ }
  }
  return { naif, exact };
}

// ----- vérification de signature (Ed25519, did:key) ----------------------------------------------

/** Une trame porte-t-elle une signature valide de l'auteur qu'elle déclare ? */
export async function verifier(salon, rec, verifieur) {
  if (!rec || typeof rec.from !== "string" || rec.sig === undefined || rec.nonce === undefined) return false;
  if (typeof rec.text !== "string") return false;
  try {
    return await verifieur(rec.from, canonicalMessage(salon, String(rec.nonce), rec.text), rec.sig);
  } catch {
    return false;
  }
}

// ----- ce que les trames disent -------------------------------------------------------------------

/** Le type d'une trame tclk1, ou null si la ligne n'en est pas une. */
export function typeTrame(texte) {
  const t = String(texte ?? "");
  if (!t.startsWith("tclk1 ")) return null;
  try {
    const j = JSON.parse(t.slice(6));
    return typeof j.type === "string" ? { type: j.type, id: j.id ?? null, ref: j.ref ?? null, contract: j.contract ?? null, amount: j.amount ?? null, asset: j.asset ?? null } : null;
  } catch {
    return null;
  }
}

/** Longueur du nonce en chiffres : c'est elle qui décide si un lecteur naïf voit la trame. */
export function chiffresDuNonce(nonce) {
  const s = String(nonce ?? "");
  return /^-?\d+$/.test(s) ? s.replace("-", "").length : 0;
}

/**
 * Un entier survit-il à un aller-retour par le nombre JavaScript ?
 * Au-delà de 2^53 la plupart des valeurs sont arrondies, mais pas toutes, et c'est ce qui rend
 * le défaut si difficile à voir : quelques trames passent, et on croit à un problème d'auteur.
 */
export function survitAuNombre(nonce) {
  const s = String(nonce ?? "");
  if (!/^-?\d+$/.test(s)) return true;
  return String(Number(s)) === s;
}

// ----- l'agrégat ----------------------------------------------------------------------------------

/** Ce que l'on peut dire d'un anneau : volumes, signatures, parcours d'un contrat, lisibilité. */
export function agreger(exact, valides) {
  const parType = {};
  const auteurs = new Set();
  // Par auteur : combien de ses trames signees un lecteur naif perd. On ne garde que des
  // COMPTES ; aucun DID de tiers ne sort de cette fonction, et la page n en publie aucun.
  const parAuteur = new Map();
  const parLongueur = {};
  const offres = new Map();     // id -> {amount, asset, from}
  const accepts = new Map();    // ref d'offre -> Set(auteurs)
  const contrats = new Map();   // contract -> {lock, deliver, reveal, receipt}
  let signees = 0, lisiblesNaif = 0;

  for (let i = 0; i < exact.length; i += 1) {
    const r = exact[i];
    if (r.from) auteurs.add(r.from);
    if (r.sig !== undefined && r.nonce !== undefined) {
      signees += 1;
      const L = chiffresDuNonce(r.nonce);
      const cle = L === 0 ? "non numerique" : String(L);
      parLongueur[cle] = parLongueur[cle] ?? { total: 0, valides: 0, lisiblesNaif: 0 };
      parLongueur[cle].total += 1;
      if (valides[i]) parLongueur[cle].valides += 1;
      if (survitAuNombre(r.nonce)) { lisiblesNaif += 1; parLongueur[cle].lisiblesNaif += 1; }
      if (r.from) {
        const a = parAuteur.get(r.from) ?? { signees: 0, perdues: 0 };
        a.signees += 1;
        if (!survitAuNombre(r.nonce)) a.perdues += 1;
        parAuteur.set(r.from, a);
      }
    }
    const f = typeTrame(r.text);
    if (!f) continue;
    parType[f.type] = (parType[f.type] ?? 0) + 1;
    if (f.type === "offer" && f.id) offres.set(f.id, { amount: f.amount, asset: f.asset, from: r.from });
    if (f.type === "accept" && f.ref) {
      if (!accepts.has(f.ref)) accepts.set(f.ref, new Set());
      accepts.get(f.ref).add(r.from);
    }
    if (f.contract) {
      const c = contrats.get(f.contract) ?? {};
      c[f.type] = true;
      contrats.set(f.contract, c);
    }
  }

  // Le parcours d'un contrat. Un taux d'enchaînement se compte CONTRAT PAR CONTRAT : diviser
  // deux totaux mesurés sur des populations différentes donne des pourcentages au-dessus de 100
  // (416 quittances pour 391 verrous, parce que certaines quittances portent sur un contrat dont
  // le verrou a quitté l'anneau). Le dénominateur et le numérateur doivent porter sur les mêmes
  // contrats, sinon le nombre ne veut rien dire.
  let verrouilles = 0, reveles = 0, quittances = 0;
  let verrouEtQuittance = 0, verrouEtReveal = 0;
  for (const c of contrats.values()) {
    if (c.lock) verrouilles += 1;
    if (c.reveal) reveles += 1;
    if (c.receipt) quittances += 1;
    if (c.lock && c.receipt) verrouEtQuittance += 1;
    if (c.lock && c.reveal) verrouEtReveal += 1;
  }

  // La concurrence sur une offre. Attention : l'anneau retient environ une demi-heure, donc il
  // contient des accepts dont l'offre est déjà sortie de la fenêtre. Les compter ferait dire
  // « 110 % des offres acceptées », un nombre impossible qui doit arrêter net. On ne rapporte
  // donc que les offres RÉELLEMENT présentes dans l'anneau.
  const dansLAnneau = [...accepts.entries()].filter(([ref]) => offres.has(ref));
  const candidats = dansLAnneau.map(([, s]) => s.size);
  const offresAvecAccept = candidats.length;
  const total = candidats.reduce((a, b) => a + b, 0);
  const acceptsHorsFenetre = [...accepts.entries()].filter(([ref]) => !offres.has(ref)).reduce((n, [, s]) => n + s.size, 0);

  // Trois etats par auteur : entierement lisible, partiellement perdu, entierement muet.
  // « Muet » veut dire qu un lecteur naif ne recoit AUCUNE de ses trames signees : cet agent
  // n existe pas pour lui, et c est vrai dans les deux sens si l autre a le meme defaut.
  let auteursSignants = 0, auteursMuets = 0, auteursPartiels = 0;
  for (const a of parAuteur.values()) {
    if (!a.signees) continue;
    auteursSignants += 1;
    if (a.perdues === a.signees) auteursMuets += 1;
    else if (a.perdues > 0) auteursPartiels += 1;
  }

  // les montants annoncés
  const montants = [];
  for (const o of offres.values()) {
    const m = Number(o.amount);
    if (Number.isFinite(m) && String(o.asset ?? "").toUpperCase() === "FLOP") montants.push(m);
  }
  montants.sort((a, b) => a - b);

  return {
    lignes: exact.length,
    auteurs: auteurs.size,
    auteursSignants,
    auteursMuets,
    auteursPartiels,
    signees,
    valides: valides.filter(Boolean).length,
    lisiblesNaif,
    parLongueur,
    parType,
    offres: offres.size,
    offresAvecAccept,
    acceptsTotal: total,
    acceptsHorsFenetre,
    candidatsMoyen: offresAvecAccept ? Number((total / offresAvecAccept).toFixed(2)) : 0,
    candidatsMax: candidats.length ? Math.max(...candidats) : 0,
    contrats: contrats.size,
    verrouilles,
    reveles,
    quittances,
    verrouEtQuittance,
    verrouEtReveal,
    montant: montants.length
      ? { min: montants[0], median: montants[Math.floor(montants.length / 2)], max: montants[montants.length - 1], compte: montants.length }
      : null,
  };
}

/** Le pourcentage, arrondi à une décimale, ou null si le dénominateur est nul (jamais 0 par défaut). */
export function part(numerateur, denominateur) {
  if (!denominateur) return null;
  return Number(((100 * numerateur) / denominateur).toFixed(1));
}

// ----- l'historique -------------------------------------------------------------------------------

/** Les quelques chiffres qu'il vaut la peine de suivre dans le temps. */
export function pointDHistoire(donnees) {
  const s = donnees.signatures;
  const c = donnees.commerce;
  return {
    t: donnees.mesure_le,
    signees: s.trames_signees,
    perdues: s.invisibles_a_un_lecteur_naif,
    part_perdue: s.part_lisible_naivement === null ? null : Number((100 - s.part_lisible_naivement).toFixed(1)),
    auteurs_muets: s.auteurs_entierement_muets_pour_un_lecteur_naif,
    auteurs_signants: s.auteurs_qui_signent,
    offres: c.offres,
    candidats_moyen: c.candidats_par_offre_moyen,
    accepts_vers_verrou: c.part_des_accepts_qui_aboutissent_a_un_verrou,
  };
}

/**
 * La serie mise a jour. Deux regles : on n'ecrase jamais le passe, et deux mesures du meme
 * instant ne comptent qu'une fois (un workflow relance a la main ne doit pas doubler un point).
 * La serie est bornee : au-dela, les plus anciens points sortent, jamais les plus recents.
 */
export function serieMiseAJour(ancienne, point, max = 800) {
  const serie = Array.isArray(ancienne) ? ancienne.filter((p) => p && p.t !== point.t) : [];
  serie.push(point);
  serie.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  return serie.slice(-max);
}

// ----- self-test ------------------------------------------------------------------------------------

export function selftest() {
  const cas = [];
  const ok = (nom, cond) => cas.push([nom, !!cond]);

  ok("nonce : 19 chiffres comptés", chiffresDuNonce("1788976440077681234") === 19);
  ok("nonce : 13 chiffres comptés", chiffresDuNonce(1788950516570) === 13);
  ok("nonce : une chaîne non numérique vaut 0", chiffresDuNonce("f0131c09") === 0 && chiffresDuNonce(null) === 0);

  ok("survie : une valeur altérée ne survit pas", !survitAuNombre("1788976440077681234"));
  ok("survie : une valeur qui tombe pile survit", survitAuNombre("1788976440077681200"));
  ok("survie : 13 chiffres survivent toujours", survitAuNombre("1788950516570"));
  ok("survie : un nonce non numérique n'est pas concerné", survitAuNombre("f0131c092236ea40"));

  ok("trame : une offre est reconnue", typeTrame('tclk1 {"type":"offer","id":"0xa","amount":"400","asset":"FLOP"}')?.type === "offer");
  ok("trame : une ligne ordinaire n'en est pas une", typeTrame("bonjour") === null && typeTrame(null) === null);
  ok("trame : un JSON cassé ne lève pas", typeTrame("tclk1 {oups") === null);
  ok("trame : sans champ type, null", typeTrame('tclk1 {"id":"0xa"}') === null);

  ok("part : dénominateur nul rend null, jamais zéro", part(3, 0) === null);
  ok("part : arrondi à une décimale", part(1394, 1400) === 99.6);

  const exact = [
    { from: "did:A", sig: "s", nonce: "1788976440077681234", text: 'tclk1 {"type":"offer","id":"0x1","amount":"400","asset":"FLOP"}' },
    { from: "did:B", sig: "s", nonce: "1788950516570", text: 'tclk1 {"type":"accept","ref":"0x1","contract":"0xc"}' },
    { from: "did:A", sig: "s", nonce: "1788950516571", text: 'tclk1 {"type":"lock","contract":"0xc"}' },
    { from: "did:B", sig: "s", nonce: "1788950516572", text: 'tclk1 {"type":"deliver","contract":"0xc"}' },
    { from: "did:C", sig: "s", nonce: "1788950516573", text: "une ligne en clair" },
  ];
  const a = agreger(exact, [true, true, true, true, true]);
  ok("agrégat : lignes, auteurs, signées", a.lignes === 5 && a.auteurs === 3 && a.signees === 5);
  ok("agrégat : une seule trame illisible naïvement", a.lisiblesNaif === 4);
  ok("agrégat : les types comptés", a.parType.offer === 1 && a.parType.accept === 1 && a.parType.deliver === 1);
  // `deliver` n'existe pas comme trame tclk1 sur le tableau : la livraison est en clair dans le
  // salon du deal, non public. On ne compte donc que ce qui est réellement observable ici.
  ok("agrégat : le contrat suivi jusqu'au verrou", a.contrats === 1 && a.verrouilles === 1);
  ok("agrégat : un candidat sur l'unique offre", a.offresAvecAccept === 1 && a.candidatsMoyen === 1);
  // un accept dont l'offre est sortie de la fenêtre ne doit pas gonfler le taux au-dessus de 100 %
  const horsFenetre = agreger([
    { from: "did:A", sig: "s", nonce: "1", text: 'tclk1 {"type":"offer","id":"0x1","amount":"9","asset":"FLOP"}' },
    { from: "did:B", sig: "s", nonce: "2", text: 'tclk1 {"type":"accept","ref":"0x1"}' },
    { from: "did:C", sig: "s", nonce: "3", text: 'tclk1 {"type":"accept","ref":"0xABSENTE"}' },
  ], [true, true, true]);
  ok("agrégat : un accept dont l'offre a quitté l'anneau est compté à part", horsFenetre.offresAvecAccept === 1 && horsFenetre.acceptsHorsFenetre === 1);
  ok("agrégat : le taux ne peut donc pas dépasser 100 %", part(horsFenetre.offresAvecAccept, horsFenetre.offres) <= 100);
  // un enchaînement se compte contrat par contrat : une quittance dont le verrou a quitté
  // l'anneau ne doit pas faire monter le taux au-dessus de 100 %
  const enchaine = agreger([
    { from: "did:A", sig: "s", nonce: "1", text: 'tclk1 {"type":"lock","contract":"0xc1"}' },
    { from: "did:A", sig: "s", nonce: "2", text: 'tclk1 {"type":"receipt","contract":"0xc1"}' },
    { from: "did:B", sig: "s", nonce: "3", text: 'tclk1 {"type":"receipt","contract":"0xORPHELIN"}' },
  ], [true, true, true]);
  ok("agrégat : quittances 2, verrous 1, mais un seul contrat enchaîné", enchaine.quittances === 2 && enchaine.verrouilles === 1 && enchaine.verrouEtQuittance === 1);
  ok("agrégat : le taux d'enchaînement reste à 100 % au plus", part(enchaine.verrouEtQuittance, enchaine.verrouilles) === 100);
  ok("agrégat : le calcul naïf, lui, aurait donné 200 %", part(enchaine.quittances, enchaine.verrouilles) === 200);
  ok("agrégat : le montant relevé", a.montant && a.montant.min === 400 && a.montant.compte === 1);
  ok("agrégat : la longueur 19 isolée", a.parLongueur["19"].total === 1 && a.parLongueur["19"].lisiblesNaif === 0);
  // trois auteurs : A n émet que du 19 chiffres altéré (muet), B du 13 (lisible), C signe les deux
  const parA = agreger([
    { from: "did:A", sig: "s", nonce: "1788976440077681234", text: "x" },
    { from: "did:A", sig: "s", nonce: "1788976440077681235", text: "y" },
    { from: "did:B", sig: "s", nonce: "1788950516570", text: "z" },
    { from: "did:C", sig: "s", nonce: "1788976440077681236", text: "u" },
    { from: "did:C", sig: "s", nonce: "1788950516571", text: "v" },
  ], [true, true, true, true, true]);
  ok("auteurs : trois signataires comptés", parA.auteursSignants === 3);
  ok("auteurs : A est entièrement muet, B ne l'est pas", parA.auteursMuets === 1);
  ok("auteurs : C est partiellement perdu", parA.auteursPartiels === 1);
  ok("auteurs : la part des muets est bornée", part(parA.auteursMuets, parA.auteursSignants) === 33.3);
  ok("auteurs : aucun DID ne sort de l'agrégat", !JSON.stringify(parA).includes("did:A"));
  // l'historique
  const d1 = { mesure_le: "2026-09-10T01:00:00Z", signatures: { trames_signees: 10, invisibles_a_un_lecteur_naif: 4, part_lisible_naivement: 60, auteurs_entierement_muets_pour_un_lecteur_naif: 2, auteurs_qui_signent: 5 }, commerce: { offres: 3, candidats_par_offre_moyen: 2, part_des_accepts_qui_aboutissent_a_un_verrou: 5 } };
  const p1 = pointDHistoire(d1);
  ok("historique : le point retient la part perdue, calculée et non recopiée", p1.part_perdue === 40 && p1.perdues === 4);
  ok("historique : une part illisible reste null, jamais zéro", pointDHistoire({ ...d1, signatures: { ...d1.signatures, part_lisible_naivement: null } }).part_perdue === null);
  ok("historique : le premier point crée la série", serieMiseAJour(null, p1).length === 1);
  ok("historique : un second instant s'ajoute", serieMiseAJour([p1], { ...p1, t: "2026-09-10T02:00:00Z" }).length === 2);
  ok("historique : le même instant ne double pas", serieMiseAJour([p1], { ...p1, signees: 99 }).length === 1 && serieMiseAJour([p1], { ...p1, signees: 99 })[0].signees === 99);
  ok("historique : la série est triée dans le temps", serieMiseAJour([{ ...p1, t: "2026-09-10T03:00:00Z" }], { ...p1, t: "2026-09-10T02:00:00Z" }).map((x) => x.t)[0] === "2026-09-10T02:00:00Z");
  const longue = Array.from({ length: 12 }, (_, i) => ({ ...p1, t: `2026-09-1${i % 10}T0${i % 9}:00:00Z` }));
  ok("historique : bornée en gardant les plus RÉCENTS", serieMiseAJour(longue, { ...p1, t: "2026-09-30T00:00:00Z" }, 3).length === 3 && serieMiseAJour(longue, { ...p1, t: "2026-09-30T00:00:00Z" }, 3).at(-1).t === "2026-09-30T00:00:00Z");
  ok("historique : une entrée nulle dans l'ancienne série ne casse rien", serieMiseAJour([null, p1], { ...p1, t: "2026-09-11T00:00:00Z" }).length === 2);

  const b = agreger([], []);
  ok("agrégat : un anneau vide ne casse pas et n'invente rien", b.lignes === 0 && b.montant === null && b.candidatsMoyen === 0);

  const echecs = cas.filter(([, r]) => !r);
  for (const [n, r] of cas) console.log(`  ${r ? "ok   " : "ECHEC"} ${n}`);
  console.log(`selftest observatory : ${cas.length - echecs.length}/${cas.length}`);
  return echecs.length ? 1 : 0;
}

// ----- la mesure ---------------------------------------------------------------------------------------

async function mesurer() {
  const { naif, exact } = await lireAnneau();
  const { verifieurEd25519 } = await import("./signing_public.mjs");
  const valides = [];
  for (const r of exact) valides.push(await verifier(SALON, r, verifieurEd25519));

  const a = agreger(exact, valides);
  const donnees = {
    mesure_le: new Date().toISOString(),
    salon: SALON,
    venue: BASE,
    anneau: {
      lignes: a.lignes,
      lignes_lues_naivement: naif.length,
      auteurs_distincts: a.auteurs,
    },
    signatures: {
      trames_signees: a.signees,
      valides: a.valides,
      part_valide: part(a.valides, a.signees),
      lisibles_par_un_lecteur_naif: a.lisiblesNaif,
      part_lisible_naivement: part(a.lisiblesNaif, a.signees),
      invisibles_a_un_lecteur_naif: a.signees - a.lisiblesNaif,
      par_longueur_de_nonce: a.parLongueur,
      auteurs_qui_signent: a.auteursSignants,
      auteurs_entierement_muets_pour_un_lecteur_naif: a.auteursMuets,
      auteurs_partiellement_perdus: a.auteursPartiels,
      part_des_auteurs_muets: part(a.auteursMuets, a.auteursSignants),
    },
    commerce: {
      par_type_de_trame: a.parType,
      offres: a.offres,
      offres_avec_au_moins_un_accept: a.offresAvecAccept,
      part_des_offres_acceptees: part(a.offresAvecAccept, a.offres),
      accepts_sur_ces_offres: a.acceptsTotal,
      accepts_dont_l_offre_est_hors_fenetre: a.acceptsHorsFenetre,
      candidats_par_offre_moyen: a.candidatsMoyen,
      candidats_par_offre_max: a.candidatsMax,
      contrats_vus: a.contrats,
      verrouilles: a.verrouilles,
      part_des_accepts_qui_aboutissent_a_un_verrou: part(a.verrouilles, a.acceptsTotal + a.acceptsHorsFenetre),
      reveles: a.reveles,
      quittances: a.quittances,
      contrats_verrouilles_puis_reveles: a.verrouEtReveal,
      contrats_verrouilles_puis_quittances: a.verrouEtQuittance,
      part_verrouille_puis_quittance: part(a.verrouEtQuittance, a.verrouilles),
      note_livraison: "La livraison ne passe pas par une trame tclk1 : elle est écrite en clair dans le salon du deal, qui n'est pas public. Elle n'est donc pas mesurable depuis le tableau, et son absence ici ne veut pas dire qu'elle n'a pas lieu.",
      montant_flop: a.montant,
    },
  };

  mkdirSync(dirname(SORTIE), { recursive: true });
  writeFileSync(SORTIE, JSON.stringify(donnees, null, 2) + "\n");

  // l'historique : lu, complété, réécrit. Une lecture qui échoue ne doit pas faire perdre la mesure,
  // mais elle ne doit pas non plus faire repartir la série de zéro en silence : on le dit.
  let ancienne = [];
  if (existsSync(HISTOIRE)) {
    try {
      ancienne = JSON.parse(readFileSync(HISTOIRE, "utf8"));
    } catch (e) {
      console.error(`historique illisible (${String(e.message ?? e)}) : la série repart de cette mesure`);
    }
  }
  const serie = serieMiseAJour(ancienne, pointDHistoire(donnees));
  writeFileSync(HISTOIRE, JSON.stringify(serie) + "\n");
  console.log(`historique : ${serie.length} points, du ${serie[0]?.t?.slice(0, 16)} au ${serie[serie.length - 1]?.t?.slice(0, 16)}`);
  console.log(`observatoire : ${a.lignes} lignes, ${a.signees} signées, ${a.valides} valides, ${a.signees - a.lisiblesNaif} invisibles à un lecteur naïf`);
  console.log(`écrit dans ${SORTIE}`);
  return donnees;
}

const cmd = process.argv[2];
if (process.argv[1] && process.argv[1].endsWith("observatory.mjs")) {
  if (cmd === "selftest") process.exit(selftest());
  mesurer().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
}
