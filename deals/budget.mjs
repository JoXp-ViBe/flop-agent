#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Budget de l'agent pour le testnet FLOP : planificateur de depense, simulateur, calendrier des cles
// de session. Parametres : yellowpaper FLOP v0.5, page web relevee le 10/09/2026 au soir (le miroir
// GitHub synchronise le meme jour donne les memes valeurs pour tout ce qui est lu ici).
//
// Le testnet dure 90 jours et sa date d'ouverture n'est pas connue : tout se compte en blocs depuis
// l'ouverture (jour 0), les dates ne sont que des estimations au rythme cible d'un bloc par seconde.
//
// Fonctions pures : aucun reseau, aucune cle, aucun fichier. Les montants circulent en BigInt, en
// unites de base de 10^-18 FLOP (R6.5b : 18 decimales), pour que la conservation d'un canal se
// verifie a l'unite pres et non a un arrondi flottant pres.
//
// Ce que le texte laisse ouvert n'est jamais tranche en silence. Chaque lecture possible devient un
// parametre de scenario : unite du tarif de R12.1d (issue #33), liberation d'une reservation apres
// une fermeture unilaterale, sequestre compte avant ou apres l'ouverture (R12.2). Le cas P > E est
// signale et reste visible dans les montants.
//
// Commandes :
//   node deals/budget.mjs simulate [--days 90] [--budget X] [--seed N]
//   node deals/budget.mjs selftest

export class ErreurParametre extends Error {
  constructor(message) {
    super(message);
    this.name = "ErreurParametre";
  }
}

// ------------------------------------------------------------------------------------------------
// Montants : BigInt en unites de base (10^-18 FLOP)
// ------------------------------------------------------------------------------------------------

export const UNITES_PAR_FLOP = 10n ** 18n;
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

// Un nombre ou une chaine decimale est un montant en FLOP ; un BigInt est deja en unites de base.
export function versBase(x, nom = "amount") {
  if (typeof x === "bigint") return x;
  let s;
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new ErreurParametre(`${nom} is not a finite number`);
    s = String(x);
  } else if (typeof x === "string") {
    s = x.trim();
  } else {
    throw new ErreurParametre(`${nom} must be a FLOP amount (number or decimal string) or a BigInt in base units`);
  }
  const m = DECIMAL.exec(s);
  if (!m) throw new ErreurParametre(`${nom} is not a decimal FLOP amount: "${s}"`);
  const [, signe, ent, frac = "", exp = "0"] = m;
  const e = Number(exp);
  if (!Number.isSafeInteger(e) || Math.abs(e) > 40) throw new ErreurParametre(`${nom} exponent out of range: "${s}"`);
  const chiffres = BigInt(ent + frac);
  const echelle = 18 + e - frac.length;
  let r;
  if (echelle >= 0) {
    r = chiffres * 10n ** BigInt(echelle);
  } else {
    const div = 10n ** BigInt(-echelle);
    if (chiffres % div !== 0n) throw new ErreurParametre(`${nom} has more than 18 decimals: "${s}"`);
    r = chiffres / div;
  }
  return signe === "-" ? -r : r;
}

// Ecriture exacte, sans zero inutile.
export function enFlop(b) {
  const neg = b < 0n;
  const a = neg ? -b : b;
  const ent = a / UNITES_PAR_FLOP;
  const frac = a % UNITES_PAR_FLOP;
  const s = frac === 0n ? ent.toString() : `${ent}.${frac.toString().padStart(18, "0").replace(/0+$/, "")}`;
  return neg ? `-${s}` : s;
}

// Affichage : six decimales au plus, une troncature est marquee "~" ; une poussiere reste ecrite en
// entier, pour ne jamais passer pour un zero.
function lisible(b) {
  const exact = enFlop(b);
  const signe = exact.startsWith("-") ? "-" : "";
  const [ent, frac = ""] = exact.slice(signe.length).split(".");
  if (frac.length <= 6 || (ent === "0" && frac.startsWith("000000"))) return exact;
  return `~${signe}${ent}.${frac.slice(0, 6)}`;
}

const groupe = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const minBig = (...xs) => xs.reduce((m, x) => (x < m ? x : m));

function entier(v, nom, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(v) || v < min || v > max) {
    throw new ErreurParametre(`${nom} must be an integer in [${min}, ${max}], got ${String(v)}`);
  }
  return v;
}

function entierPositifBig(v, nom) {
  if (typeof v === "bigint") {
    if (v < 0n) throw new ErreurParametre(`${nom} must be at least 0, got ${v}`);
    return v;
  }
  return BigInt(entier(v, nom));
}

function montant(v, nom, { strict = false } = {}) {
  const b = versBase(v, nom);
  if (b < 0n || (strict && b === 0n)) {
    throw new ErreurParametre(`${nom} must be ${strict ? "above" : "at least"} 0 FLOP, got ${enFlop(b)}`);
  }
  return b;
}

// ------------------------------------------------------------------------------------------------
// Parametres du texte, chacun avec sa citation
// ------------------------------------------------------------------------------------------------
//
// statut :
//   "enforced"        table "Enforced parameters" de l'Appendix A : valeur recopiee dans le code du
//                     reseau et controlee par scripts/check_params.py
//   "reference-only"  table "Reference-only" de l'Appendix A (enforce: false) : valeur documentee,
//                     pas controlee entre langages ; le mecanisme peut exister (Appendix H le dit
//                     LIVE) avec une autre valeur, fixee par exemple par le proprietaire du delegue
//   "prose"           exigence ecrite dans le corps du texte, sans ligne a elle dans l'Appendix A
//   "exemple"         exemple chiffre du texte, pas un parametre du protocole
//
// Les citations sont recopiees de la page web ; un tiret long du texte y est remplace par "...".

export const PARAMS = Object.freeze({
  agent_identity_min_stake: {
    valeur: "10", type: "flop", unite: "FLOP", statut: "enforced",
    citation: 'Appendix A, table "Agent wallet / session keys": "agent_identity_min_stake 10 FLOP §6.2 Anti-Sybil minimum stake to register an agent identity."',
  },
  max_active_reservations_base: {
    valeur: 4, type: "entier", unite: "reservations", statut: "enforced",
    citation: 'Appendix A, table "Sessions / capacity reservations (A1 anti-spam)": "max_active_reservations_base 4 count §12.2 Base number of concurrent active capacity reservations per agent identity."',
  },
  escrow_per_reservation_slot: {
    valeur: "50", type: "flop", strict: true, unite: "FLOP", statut: "enforced",
    citation: 'Appendix A, same table: "escrow_per_reservation_slot 50 FLOP §12.2 Escrow (in FLOP) that grants +1 additional active reservation slot beyond base." R12.2: "The session per-identity in-flight reservation cap MUST be enforced at open/force_open: base max_active_reservations_base plus one slot per escrow_per_reservation_slot escrowed; freed on settle/expire/timeout/fraud."',
  },
  refund_penalty_phi_percent: {
    valeur: 20, type: "entier", max: 100, unite: "percent", statut: "enforced",
    citation: 'Appendix A, table "Compute-channel settlement": "refund_penalty_phi_percent 20 percent §12.1 D-0422 Static D-0422 penalty fraction phi on unused escrow for ambiguous early close; penalty routes 100% to burn/Foundation, never miner." R12.1d: "the penalty φ·(E−P) ( refund_penalty_phi_percent = 20%) MUST be burned/routed to the Foundation ... never the miner."',
  },
  channel_base_per_turn: {
    valeur: 1, type: "entier", unite: "channel pay unit (unit ambiguous, issue #33)", statut: "enforced",
    citation: 'Appendix A, table "Compute-channel settlement": "channel_base_per_turn 1 base-units §12.1 Per-turn flat fee of the two-part tariff (#719 option A): turn_pay = BasePerTurn + G_n (rate=1 in channel pay units)." R12.1d: "channel_base_per_turn = 1, so P is bounded below by the converted work term".',
    note: "Le base unit vaut 10^-18 FLOP (unite de Balance du runtime) ou 1 FLOP (R6.5b : 1 VFY = 1 FLOP) : parametre de scenario uniteTarif, jamais tranche ici.",
  },
  channel_rate_g: {
    valeur: 1, type: "entier", unite: "channel pay unit per G_n", statut: "prose",
    citation: 'R12.1d: "the current conversion is exactly one channel pay unit per stored G_n unit; this is a tariff constant, not an assertion that one G_n equals one FLOP base unit." No Appendix A row of its own.',
  },
  circuit_breaker_window: {
    valeur: 60, type: "entier", min: 1, unite: "blocks", statut: "reference-only",
    citation: 'Appendix A, table "Reference-only ... single-site or not yet wired for cross-language enforcement ( enforce: false )": "circuit_breaker_window 60 blocks", with no section, decision or description.',
  },
  circuit_breaker_tx_count: {
    valeur: 100, type: "entier", min: 2, unite: "transactions", statut: "enforced",
    citation: 'Appendix A, table "Agent wallet / session keys" (runtime name SessionKeysCircuitBreakerMaxTxs): "circuit_breaker_tx_count 100 count §6.2 Agent session-key circuit-breaker trip on 100 txs within the window (with circuit_breaker_flop_cap = 250 FLOP)."',
  },
  circuit_breaker_flop_cap: {
    valeur: "250", type: "flop", strict: true, unite: "FLOP", statut: "enforced",
    citation: 'Appendix A, same table (runtime name SessionKeysCircuitBreakerMaxSpend): "circuit_breaker_flop_cap 250 FLOP §6.2 Agent session-key circuit-breaker max spend per window (60 blk / 100 tx / 250 FLOP triple)."',
  },
  agent_per_tx_limit: {
    valeur: "100", type: "flop", strict: true, unite: "FLOP", statut: "reference-only",
    citation: 'Appendix A, reference-only table: "agent_per_tx_limit 100 FLOP", with no section or description. §6.2 names "per-tx and daily caps (epoch-reset)"; R6.2b blocks spending "at the session cap (§11 INV-02), the daily cap, and the circuit breaker", a list without the per-tx cap.',
  },
  agent_daily_cap_autonomous: {
    valeur: "500", type: "flop", strict: true, unite: "FLOP", statut: "reference-only",
    citation: 'Appendix A, reference-only table: "agent_daily_cap_autonomous 500 FLOP", with no section or description. R6.2b: "Spending MUST be blocked at the session cap (§11 INV-02), the daily cap, and the circuit breaker; a captured session key MUST be bounded by these caps."',
    note: "§6.2 dit daily caps (epoch-reset), et l'epoque du §1.2 dure 1 h (EpochDurationInBlocks) : le plan compte le plafond par jour, la lecture la plus stricte.",
  },
  session_keys_max_duration_blocks: {
    valeur: 864000, type: "entier", min: 1, unite: "blocks", statut: "prose",
    citation: '§6.2: "The session-key lifetime MUST be ≤ 864,000 blocks ( SessionKeysMaxDuration ). This is approximately 10 elapsed days only at uninterrupted 1 s target cadence; missed or delayed blocks extend the elapsed lifetime." §1.2: "Session key lifetime ≤ 864,000 blocks". Reference-only row: "session_key_expiry_days 10 days §6.2". No enforced Appendix A row.',
  },
  block_time_seconds: {
    valeur: 1, type: "reel", unite: "seconds", statut: "prose",
    citation: '§1.2: "Block time 1 s (BABE authoring)"; §2.2: "Block interval 1 second (fixed)"; R9.8: "1 s block time". No Appendix A row.',
  },
  channel_dispute_window_blocks: {
    valeur: 604800, type: "entier", unite: "blocks", statut: "enforced",
    citation: 'Appendix A, table "Compute-channel settlement": "channel_dispute_window_blocks 604_800 blocks §12.1 D-0403 Session dispute/challenge window (7 d); integrity_test enforces <= DaEphemeralRetention (14 d)."',
  },
  existential_deposit: {
    valeur: "0.01", type: "flop", unite: "FLOP", statut: "prose",
    citation: 'R6.5b: "An account MUST hold ≥ the existential deposit ( EXISTENTIAL_DEPOSIT = 0.01 FLOP) or be reaped." Also §6.1 and R9.8. No Appendix A row.',
  },
  agent_share_ppt: {
    valeur: 100, type: "entier", max: 1000, unite: "parts per thousand", statut: "enforced",
    citation: 'Appendix A, table "Emission & Rewards": "agent_share_ppt 100 parts-per-thousand §2.1 D-0435 Agent/broker rebate share of each block reward (10%)." R9.12: onward distribution "MUST NOT occur until its distribution policy is ratified ( E.40 )".',
    note: "Aucun revenu d'agent n'est compte : la jambe s'accumule dans un pool et n'est pas distribuee.",
  },
  channel_max_settlement_turns: {
    valeur: 1024, type: "entier", min: 1, unite: "turns", statut: "enforced",
    citation: 'Appendix A, table "Compute-channel settlement": "channel_max_settlement_turns 1_024 count §12.1 Hard cap on VerifiedTurns per settle/force_settle bundle, and the ceiling on an SLA\'s max_turns at open."',
  },
  epoch_duration_blocks: {
    valeur: 3600, type: "entier", min: 1, unite: "blocks", statut: "prose",
    citation: '§1.2: "Epoch / committee rotation 1 h prod ( EpochDurationInBlocks ; 1 min fast-dev)" and "PoUI rate-limit epoch 1 day ( poui_max_submissions_epoch window)". 3,600 blocks is 1 h at 1 s, derived here.',
  },
  gn_par_jeton_reference: {
    valeur: 16, type: "entier", unite: "G_n per token", statut: "exemple",
    citation: '§4.2: "Llama-3-8B → 16, Llama-3-70B → 140 G_n /token", a reference example, not a protocol parameter.',
  },
});

// Ce que le planificateur doit connaitre et que le texte ne donne pas. Une entree obligatoire est
// exigee en argument : aucune valeur n'est inventee a sa place.
export const PARAMS_ABSENTS = Object.freeze([
  { nom: "plafond de vie (lifetime cap) d'une cle deleguee", statut: "non trouve", obligatoire: true,
    ou: "§6.2 lifetime cap, §11 INV-02 the session cap : aucune valeur", entree: "planJour : plafondSessionRestant" },
  { nom: "max_duration d'un canal (borne du timeout)", statut: "non trouve", obligatoire: true,
    ou: "Appendix G timeout : not past max_duration ; R12.1h D_max", entree: "planJour : dureeSessionBlocs" },
  { nom: "prix d'une reservation", statut: "non trouve", obligatoire: true,
    ou: "R12.1a : le sequestre est le prix, sans regle de formation (issue #12)", entree: "planJour : sequestreCible" },
  { nom: "frais de transaction", statut: "non trouve", obligatoire: false,
    ou: "§6.1 : dynamic fees", entree: "non modelises" },
  { nom: "arrondi de phi(E-P) en unites de base", statut: "non trouve", obligatoire: false,
    ou: "R12.1d donne la formule en reels", entree: "la jambe agent absorbe le reste : conservation exacte" },
  { nom: "epoque de remise du plafond quotidien", statut: "ambigu", obligatoire: false,
    ou: "§6.2 daily caps (epoch-reset) ; §1.2 : epoque 1 h, epoque PoUI 1 jour", entree: "plafond compte par jour (lecture stricte)" },
  { nom: "liberation d'une reservation apres fermeture unilaterale", statut: "ambigu", obligatoire: false,
    ou: "R12.2 : freed on settle/expire/timeout/fraud, sans force_settle ni finalize", entree: "simuler : liberationUnilaterale (defaut finalize, hypothese)" },
  { nom: "sequestre compte pour les creneaux, avant ou apres l'ouverture", statut: "ambigu", obligatoire: false,
    ou: "R12.2 : one slot per escrow_per_reservation_slot escrowed", entree: "lectureCreneaux (defaut avant, la plus stricte)" },
  { nom: "unite du tarif P", statut: "ambigu", obligatoire: true,
    ou: "R12.1d ; Appendix A channel_base_per_turn en base-units ; issue #33", entree: "uniteTarif : base | flop" },
]);

const VALIDE = Symbol("valeurs validees");

// Valeurs du texte, eventuellement surchargees pour un scenario, controlees une a une. Les montants
// en FLOP sortent en BigInt (unites de base), les comptes et les blocs en entiers.
export function valeurs(surcharges = {}) {
  if (surcharges === null || typeof surcharges !== "object" || Array.isArray(surcharges)) {
    throw new ErreurParametre("parameter overrides must be an object");
  }
  for (const k of Object.keys(surcharges)) {
    if (!Object.hasOwn(PARAMS, k)) throw new ErreurParametre(`unknown parameter: ${k}`);
  }
  const p = {};
  for (const [k, d] of Object.entries(PARAMS)) {
    const v = Object.hasOwn(surcharges, k) ? surcharges[k] : d.valeur;
    if (d.type === "flop") p[k] = montant(v, k, { strict: d.strict === true });
    else if (d.type === "entier") p[k] = entier(v, k, d.min ?? 0, d.max ?? Number.MAX_SAFE_INTEGER);
    else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 86400) {
      throw new ErreurParametre(`${k} must be a number of seconds in (0, 86400], got ${String(v)}`);
    } else p[k] = v;
  }
  Object.defineProperty(p, VALIDE, { value: true });
  return Object.freeze(p);
}

function exiger(p) {
  if (p === undefined) return valeurs();
  if (p !== null && typeof p === "object" && p[VALIDE] === true) return p;
  throw new ErreurParametre("parameters must come from valeurs()");
}

export const blocsParJour = (p) => Math.floor(86400 / p.block_time_seconds);

// ------------------------------------------------------------------------------------------------
// Issue d'un canal
// ------------------------------------------------------------------------------------------------

// Deux lectures du base unit de channel_base_per_turn (issue #33) : 10^-18 FLOP (l'unite de
// Balance du runtime) ou 1 FLOP (R6.5b : "the base unit is VFY (1 VFY = 1 FLOP)"). Le texte ne
// tranche pas ; chaque fonction qui en depend exige que l'appelant choisisse.
export const UNITES_TARIF = Object.freeze({ base: 1n, flop: UNITES_PAR_FLOP });

function uniteTarif(unite) {
  if (!Object.hasOwn(UNITES_TARIF, unite)) {
    throw new ErreurParametre(`the pay-unit reading is a scenario, not a fact (issue #33): pass "base" or "flop", got ${String(unite)}`);
  }
  return UNITES_TARIF[unite];
}

// R12.1d : P = BasePerTurn*n + rate_G*G_claimed, en unites de paie, rendu en unites de base.
export function tarifP({ n, G, unite }, params) {
  const p = exiger(params);
  const facteur = uniteTarif(unite);
  const tours = entierPositifBig(n, "n (turns)");
  const gn = entierPositifBig(G, "G_claimed");
  return (BigInt(p.channel_base_per_turn) * tours + BigInt(p.channel_rate_g) * gn) * facteur;
}

// R12.1a et M9 : le reglement cooperatif paie le sequestre reserve en entier au mineur ; la
// sous-utilisation n'est pas remboursee.
export function issueCooperative(E) {
  const e = montant(E, "E (escrow)", { strict: true });
  return { chemin: "cooperative", E: e, P: null, mineur: e, agent: 0n, brule: 0n, depassement: false, note: null };
}

// R12.1d et Appendix G finalize : mineur P, agent (1-phi)(E-P), phi(E-P) brule ou verse a la
// Fondation, jamais au mineur. Le texte ecrit la formule en reels ; en unites de base la penalite
// est tronquee vers zero et la jambe agent prend le reste, pour que P + agent + brule = E exactement.
// Si P > E, les deux dernieres jambes sont negatives : le resultat les montre telles quelles et le
// signale, car le texte ne dit pas ce que fait finalize dans ce cas (plafonner P, ou refuser).
export function issueUnilaterale({ E, n, G, unite }, params) {
  const p = exiger(params);
  const e = montant(E, "E (escrow)", { strict: true });
  const P = tarifP({ n, G, unite }, p);
  const reste = e - P;
  const brule = (reste * BigInt(p.refund_penalty_phi_percent)) / 100n;
  const depassement = P > e;
  return {
    chemin: "unilateral", unite, E: e, P, mineur: P, agent: reste - brule, brule, depassement,
    note: depassement ? "P > E: finalize has no stated outcome (clamp P to E, or reject); the legs are the formula's" : null,
  };
}

// R12.1d : "A miner-fault non-delivery uses φ = 0 (full refund)" ; Appendix G timeout :
// "non-delivery → full refund ( φ=0 )". Rien n'a ete livre : P = 0, l'agent recupere E.
export function issueNonLivraison(E) {
  const e = montant(E, "E (escrow)", { strict: true });
  return { chemin: "non-delivery", E: e, P: 0n, mineur: 0n, agent: e, brule: 0n, depassement: false, note: null };
}

export const conserve = (i) => i.mineur + i.agent + i.brule === i.E;

// ------------------------------------------------------------------------------------------------
// Reservations (R12.2)
// ------------------------------------------------------------------------------------------------

const LECTURES_CRENEAUX = ["avant", "apres"];

// base + un creneau par tranche entiere de escrow_per_reservation_slot sequestree
export function creneauxPermis(sequestre, params) {
  const p = exiger(params);
  const s = montant(sequestre, "escrowed amount");
  return p.max_active_reservations_base + Number(s / p.escrow_per_reservation_slot);
}

// Le texte ne dit pas si le sequestre du canal qu'on ouvre compte deja : "avant" l'exclut (la
// lecture la plus stricte, par defaut), "apres" l'inclut.
export function ouverturePermise(tenus, sequestreNouveau, params, lecture) {
  const p = exiger(params);
  if (!LECTURES_CRENEAUX.includes(lecture)) {
    throw new ErreurParametre(`lectureCreneaux must be "avant" or "apres", got ${String(lecture)}`);
  }
  const compte = lecture === "apres" ? tenus.sequestre + sequestreNouveau : tenus.sequestre;
  const permis = creneauxPermis(compte, p);
  return { permis, necessaires: tenus.nombre + 1, ok: tenus.nombre + 1 <= permis };
}

// Rejoue des evenements (ouvre, libere, vide = creneau garde sans sequestre) et refuse toute
// ouverture au-dela du permis. A bloc egal, l'ouverture passe avant la liberation : un creneau
// libere au bloc b ne sert qu'a partir du bloc b + 1.
export function verifierCreneaux(evenements, params, lecture, initiaux = []) {
  const p = exiger(params);
  const rang = { ouvre: 0, libere: 1, vide: 1 };
  for (const e of evenements) {
    if (!Object.hasOwn(rang, e.type)) throw new ErreurParametre(`unknown reservation event: ${String(e.type)}`);
  }
  const ev = [...evenements].sort((a, b) => a.bloc - b.bloc || rang[a.type] - rang[b.type]);
  const actifs = new Map(initiaux.map((x) => [x.id, x.sequestre]));
  const violations = [];
  let pic = actifs.size;
  for (const x of ev) {
    if (x.type === "ouvre") {
      let seq = 0n;
      for (const s of actifs.values()) seq += s;
      const t = ouverturePermise({ nombre: actifs.size, sequestre: seq }, x.sequestre, p, lecture);
      if (!t.ok) {
        violations.push({ bloc: x.bloc, id: x.id, permis: t.permis, necessaires: t.necessaires });
        continue;
      }
      actifs.set(x.id, x.sequestre);
      if (actifs.size > pic) pic = actifs.size;
    } else if (x.type === "libere") {
      actifs.delete(x.id);
    } else if (actifs.has(x.id)) {
      actifs.set(x.id, 0n);
    }
  }
  return { ok: violations.length === 0, violations, pic };
}

// ------------------------------------------------------------------------------------------------
// Disjoncteur de la cle de session (§6.2)
// ------------------------------------------------------------------------------------------------
//
// Fenetre glissante de circuit_breaker_window blocs, (b - W, b] : plus stricte qu'une fenetre
// alignee, donc un plan qui la respecte respecte les deux lectures. La 100e transaction dans la
// fenetre declenche ("trip on 100 txs within the window"), donc au plus 99 ; la depense ne depasse
// pas circuit_breaker_flop_cap. Une seule transaction de l'agent par bloc : le nonce serialise (§6.3,
// "one in-flight"). Seules les depenses de l'agent sont cadencees (open_channel, top_up_escrow) ;
// timeout et finalize ("anyone (signed)", sans depense) ne le sont pas.

// Place chaque transaction au premier bloc qui tient dans la fenetre (garde active), sinon au
// premier bloc libre (garde coupee, pour montrer ce que ferait une rafale).
export function cadencer(txs, params, { debut = 0, garde = true, historique = [] } = {}) {
  const p = exiger(params);
  const W = p.circuit_breaker_window;
  const N = p.circuit_breaker_tx_count;
  const S = p.circuit_breaker_flop_cap;
  for (const x of historique) {
    if (!Number.isSafeInteger(x.bloc) || typeof x.montant !== "bigint") {
      throw new ErreurParametre("history entries need an integer bloc and a BigInt montant");
    }
  }
  const tous = [...historique].sort((a, b) => a.bloc - b.bloc);
  const occupes = new Set(tous.map((x) => x.bloc));
  const places = [];
  let dernier = debut - 1;
  for (const t of txs) {
    if (typeof t.montant !== "bigint" || t.montant < 0n) throw new ErreurParametre("transaction montant must be a BigInt >= 0");
    if (garde && t.montant > S) {
      throw new ErreurParametre(`a single transaction of ${enFlop(t.montant)} FLOP is above circuit_breaker_flop_cap`);
    }
    let b = Math.max(dernier + 1, t.auPlusTot ?? debut);
    for (;;) {
      while (occupes.has(b)) b++;
      if (!garde) break;
      let nb = 1;
      let dep = t.montant;
      let plusAncien = null;
      for (let i = tous.length - 1; i >= 0 && tous[i].bloc > b - W; i--) {
        if (tous[i].bloc > b) continue;
        nb++;
        dep += tous[i].montant;
        plusAncien = tous[i].bloc;
      }
      if (nb < N && dep <= S) break;
      b = plusAncien + W;          // attendre que la plus ancienne sorte de la fenetre
    }
    const place = { ...t, bloc: b };
    places.push(place);
    tous.push(place);
    occupes.add(b);
    dernier = b;
  }
  return places;
}

// Controle independant du cadencement : rejoue les transactions dans l'ordre des blocs ; une
// transaction qui ferait sauter le disjoncteur est comptee et refusee (lecture "budget par
// fenetre"). premierDeclenchement donne le bloc ou une lecture "verrou" arreterait la cle.
export function verifierDisjoncteur(transactions, params) {
  const p = exiger(params);
  const W = p.circuit_breaker_window;
  const N = p.circuit_breaker_tx_count;
  const S = p.circuit_breaker_flop_cap;
  const t = [...transactions].sort((a, b) => a.bloc - b.bloc);
  const acceptes = [];
  let debut = 0;
  let somme = 0n;
  let refus = 0;
  let premier = null;
  let pireNb = 0;
  let pireDepense = 0n;
  for (const x of t) {
    while (debut < acceptes.length && acceptes[debut].bloc <= x.bloc - W) {
      somme -= acceptes[debut].montant;
      debut++;
    }
    const nb = acceptes.length - debut + 1;
    const dep = somme + x.montant;
    if (nb >= N || dep > S) {
      refus++;
      if (premier === null) premier = x.bloc;
      continue;
    }
    acceptes.push(x);
    somme = dep;
    if (nb > pireNb) pireNb = nb;
    if (dep > pireDepense) pireDepense = dep;
  }
  return { ok: refus === 0, declenchements: refus, premierDeclenchement: premier, pireNb, pireDepense };
}

// ------------------------------------------------------------------------------------------------
// Plan d'une journee
// ------------------------------------------------------------------------------------------------

const HYPOTHESES_JOUR = new Set([
  "sequestreCible", "sessionsVoulues", "simultanees", "tenues", "plafondSessionRestant", "depenseDuJour",
  "dureeSessionBlocs", "debutBloc", "finOuvertures", "finSessions", "historique", "lectureCreneaux",
  "appliquerReference", "garde",
]);

const RAISON_REQUISE = {
  sequestreCible: "the text sets no reservation price (R12.1a: the escrow is the price)",
  sessionsVoulues: "the agent's own demand",
  plafondSessionRestant: "the text gives no session cap value (section 6.2 lifetime cap, INV-02); the owner sets it",
  dureeSessionBlocs: "the text gives no channel max_duration value",
};

function hypothesesJour(hyp, p) {
  if (hyp === null || typeof hyp !== "object" || Array.isArray(hyp)) throw new ErreurParametre("planning assumptions must be an object");
  for (const k of Object.keys(hyp)) {
    if (!HYPOTHESES_JOUR.has(k)) throw new ErreurParametre(`unknown planning assumption: ${k}`);
  }
  for (const k of Object.keys(RAISON_REQUISE)) {
    if (hyp[k] === undefined || hyp[k] === null) throw new ErreurParametre(`planning assumption required: ${k} (${RAISON_REQUISE[k]})`);
  }
  const debutBloc = entier(hyp.debutBloc ?? 0, "debutBloc");
  const bpj = blocsParJour(p);
  const h = {
    sequestreCible: montant(hyp.sequestreCible, "sequestreCible", { strict: true }),
    sessionsVoulues: entier(hyp.sessionsVoulues, "sessionsVoulues", 0, 10_000),
    simultanees: entier(hyp.simultanees ?? 1, "simultanees", 1, 1_000),
    tenues: {
      nombre: entier(hyp.tenues?.nombre ?? 0, "tenues.nombre"),
      sequestre: montant(hyp.tenues?.sequestre ?? 0n, "tenues.sequestre"),
    },
    plafondSessionRestant: montant(hyp.plafondSessionRestant, "plafondSessionRestant"),
    depenseDuJour: montant(hyp.depenseDuJour ?? 0n, "depenseDuJour"),
    dureeSessionBlocs: entier(hyp.dureeSessionBlocs, "dureeSessionBlocs", 1),
    debutBloc,
    finOuvertures: entier(hyp.finOuvertures ?? debutBloc + bpj, "finOuvertures", debutBloc),
    finSessions: entier(hyp.finSessions ?? debutBloc + bpj, "finSessions", debutBloc),
    historique: hyp.historique ?? [],
    lectureCreneaux: hyp.lectureCreneaux ?? "avant",
    appliquerReference: hyp.appliquerReference ?? true,
    garde: hyp.garde ?? true,
  };
  if (!Array.isArray(h.historique)) throw new ErreurParametre("historique must be an array of placed transactions");
  if (!LECTURES_CRENEAUX.includes(h.lectureCreneaux)) {
    throw new ErreurParametre(`lectureCreneaux must be "avant" or "apres", got ${String(h.lectureCreneaux)}`);
  }
  if (typeof h.appliquerReference !== "boolean") throw new ErreurParametre("appliquerReference must be a boolean");
  if (typeof h.garde !== "boolean") throw new ErreurParametre("garde must be a boolean");
  // un sequestre n'est tenu que par une reservation : sans reservation tenue, il n'y en a pas
  if (h.tenues.nombre === 0 && h.tenues.sequestre > 0n) {
    throw new ErreurParametre("tenues.sequestre is escrow held by reservations, so it needs tenues.nombre above 0");
  }
  return h;
}

// Plan d'une journee (ou d'une tranche de journee, entre deux rotations de cle) :
//   - nombre de canaux et sequestre par canal, sous le budget, le plafond quotidien, le plafond de
//     la cle en service ;
//   - creneaux de reservation (R12.2), en comptant ceux deja tenus, d'ou la simultaneite ;
//   - recharges : une transaction ne depose pas plus que le plafond par transaction (valeur
//     reference-only, appliquee par prudence) ni que le plafond du disjoncteur ; le reste du
//     sequestre passe en top_up_escrow (R12.1e, Appendix C.7) ;
//   - cadencement sous le disjoncteur, en vagues : une vague s'ouvre quand la precedente est close.
// Le plan suppose des fermetures cooperatives ; l'executant (simuler) reverifie chaque ouverture.
export function planJour(budget, params, hypotheses = {}) {
  const p = exiger(params);
  const B = montant(budget, "budget");
  const h = hypothesesJour(hypotheses, p);
  const W = p.circuit_breaker_window;
  const S = p.circuit_breaker_flop_cap;
  const alertes = [];

  const parTx = h.appliquerReference ? p.agent_per_tx_limit : null;
  const tranche = parTx !== null && parTx < S ? parTx : S;
  let restantJour = null;
  if (h.appliquerReference) {
    restantJour = p.agent_daily_cap_autonomous - h.depenseDuJour;
    if (restantJour < 0n) {
      alertes.push("daily cap already exceeded before this plan");
      restantJour = 0n;
    }
  }
  const depenseMax = minBig(B, h.plafondSessionRestant, ...(restantJour === null ? [] : [restantJour]));
  const e = h.sequestreCible;
  let voulus = h.sessionsVoulues;
  const parBudget = depenseMax / e;
  if (BigInt(voulus) > parBudget) {
    alertes.push(`spend ceiling ${enFlop(depenseMax)} FLOP allows ${parBudget} channel(s) of ${enFlop(e)} FLOP, ${voulus} wanted`);
    voulus = Number(parBudget);
  }

  let c = 0;
  for (let k = 0; k < Math.min(h.simultanees, voulus); k++) {
    const t = ouverturePermise({ nombre: h.tenues.nombre + k, sequestre: h.tenues.sequestre + BigInt(k) * e }, e, p, h.lectureCreneaux);
    if (!t.ok) break;
    c = k + 1;
  }
  let refusCreneaux = 0;
  if (voulus > 0 && c === 0) {
    alertes.push(`no reservation slot: ${h.tenues.nombre} held, ${creneauxPermis(h.tenues.sequestre, p)} permitted`);
    refusCreneaux = voulus;
    voulus = 0;
  } else if (c < Math.min(h.simultanees, voulus)) {
    alertes.push(`reservations allow ${c} channel(s) at once, ${Math.min(h.simultanees, voulus)} wanted`);
  }

  const nbTx = Number((e + tranche - 1n) / tranche);
  const sessions = [];
  const transactions = [];
  let debutVague = h.debutBloc;
  while (sessions.length < voulus) {
    const taille = Math.min(c, voulus - sessions.length);
    const aPlacer = [];
    for (let i = 0; i < taille; i++) {
      const id = sessions.length + i;
      let reste = e;
      for (let j = 0; j < nbTx; j++) {
        const m = reste < tranche ? reste : tranche;
        reste -= m;
        aPlacer.push({ type: j === 0 ? "open_channel" : "top_up_escrow", canal: id, montant: m, auPlusTot: debutVague });
      }
    }
    const recents = [...h.historique, ...transactions].filter((x) => x.bloc > debutVague - W);
    const places = cadencer(aPlacer, p, { debut: debutVague, garde: h.garde, historique: recents });
    const vague = [];
    for (let i = 0; i < taille; i++) {
      const id = sessions.length + i;
      const siennes = places.filter((x) => x.canal === id);
      const pret = siennes[siennes.length - 1].bloc;
      vague.push({ id, ouverture: siennes[0].bloc, pret, fin: pret + h.dureeSessionBlocs, sequestre: e });
    }
    const derniereOuverture = Math.max(...vague.map((v) => v.ouverture));
    const derniereFin = Math.max(...vague.map((v) => v.fin));
    if (derniereOuverture >= h.finOuvertures || derniereFin >= h.finSessions) {
      alertes.push(`window full after ${sessions.length} channel(s), ${voulus} planned`);
      break;
    }
    sessions.push(...vague);
    transactions.push(...places);
    debutVague = derniereFin + 1;
  }

  // controles du plan par des fonctions qui ne reutilisent pas la logique qui l'a construit
  const depense = e * BigInt(sessions.length);
  const disj = verifierDisjoncteur([...h.historique.filter((x) => x.bloc > h.debutBloc - W), ...transactions], p);
  const initiaux = Array.from({ length: h.tenues.nombre }, (_, i) => ({ id: `tenu${i}`, sequestre: i === 0 ? h.tenues.sequestre : 0n }));
  const evenements = sessions.flatMap((s) => [
    { bloc: s.ouverture, type: "ouvre", id: s.id, sequestre: s.sequestre },
    { bloc: s.fin, type: "libere", id: s.id },
  ]);
  const cr = verifierCreneaux(evenements, p, h.lectureCreneaux, initiaux);
  return {
    canaux: sessions.length,
    sequestreParCanal: e,
    depense,
    recharges: { parCanal: nbTx - 1, total: (nbTx - 1) * sessions.length },
    transactions,
    sessions,
    creneaux: {
      base: p.max_active_reservations_base, tenus: h.tenues.nombre, simultanees: c, pic: cr.pic,
      lecture: h.lectureCreneaux, refusCreneaux, respecte: cr.ok,
    },
    plafonds: {
      budget: { valeur: B, respecte: depense <= B },
      session: { restant: h.plafondSessionRestant, respecte: depense <= h.plafondSessionRestant },
      quotidien: {
        valeur: h.appliquerReference ? p.agent_daily_cap_autonomous : null, statut: "reference-only",
        respecte: restantJour === null || depense <= restantJour,
      },
      parTransaction: {
        valeur: parTx, statut: "reference-only",
        respecte: parTx === null || transactions.every((x) => x.montant <= parTx),
      },
      disjoncteur: {
        fenetre: W, transactionsMax: p.circuit_breaker_tx_count - 1, depenseMax: S,
        pireNb: disj.pireNb, pireDepense: disj.pireDepense, respecte: disj.ok,
      },
    },
    alertes,
  };
}

// ------------------------------------------------------------------------------------------------
// Calendrier des cles de session (§6.2)
// ------------------------------------------------------------------------------------------------

function dateMs(debut) {
  if (debut === null || debut === undefined) return null;
  let ms = NaN;
  if (debut instanceof Date) ms = debut.getTime();
  else if (typeof debut === "number") ms = debut;
  else if (typeof debut === "string") ms = Date.parse(debut);
  if (!Number.isFinite(ms)) throw new ErreurParametre(`debut is not a valid date: ${String(debut)}`);
  return ms;
}

// Une cle enregistree au bloc b vaut jusqu'au bloc b + dureeMaxBlocs (exclu). Elle sert de b a
// b + dureeMaxBlocs - marge, puis la suivante prend le relais. La duree est un nombre de blocs :
// les dates, calculees au rythme cible, sont les plus tot possibles, un bloc manque ne fait que
// les retarder (§6.2), d'ou la rotation a la hauteur de bloc et non a la date.
export function calendrierCles(debut, dureeMaxBlocs, tempsBloc, marge, horizonBlocs) {
  entier(dureeMaxBlocs, "dureeMaxBlocs", 1);
  if (typeof tempsBloc !== "number" || !Number.isFinite(tempsBloc) || tempsBloc <= 0) {
    throw new ErreurParametre(`tempsBloc must be a positive number of seconds, got ${String(tempsBloc)}`);
  }
  entier(marge, "marge", 0, dureeMaxBlocs - 1);
  const horizon = horizonBlocs === undefined ? Math.floor((90 * 86400) / tempsBloc) : entier(horizonBlocs, "horizonBlocs", 1);
  const t0 = dateMs(debut);
  const jour = (b) => (b * tempsBloc) / 86400;
  const date = (b) => (t0 === null ? null : new Date(t0 + b * tempsBloc * 1000).toISOString());
  const usage = dureeMaxBlocs - marge;
  const cles = [];
  for (let b = 0; b < horizon;) {
    const rotation = Math.min(b + usage, horizon);
    cles.push({
      index: cles.length, blocDebut: b, blocRotation: rotation, blocExpiration: b + dureeMaxBlocs,
      jourDebut: jour(b), jourRotation: jour(rotation), dateDebut: date(b), dateRotation: date(rotation),
    });
    b = rotation;
  }
  return { cles, rotations: cles.length - 1, dureeMaxBlocs, tempsBloc, marge, horizonBlocs: horizon };
}

// Recalcule chaque borne a partir de dureeMaxBlocs plutot que de croire les champs du calendrier.
export function verifierCalendrier(cal) {
  const { cles, dureeMaxBlocs, marge, horizonBlocs } = cal;
  const erreurs = [];
  if (!cles.length || cles[0].blocDebut !== 0) erreurs.push("the first key does not start at block 0");
  cles.forEach((k, i) => {
    const usage = k.blocRotation - k.blocDebut;
    if (usage <= 0) erreurs.push(`key ${i} is never used`);
    if (usage > dureeMaxBlocs - marge) erreurs.push(`key ${i} is used ${usage} blocks, above ${dureeMaxBlocs - marge}`);
    if (usage > dureeMaxBlocs) erreurs.push(`key ${i} is used past its lifetime`);
    if (i > 0 && k.blocDebut !== cles[i - 1].blocRotation) erreurs.push(`gap or overlap before key ${i}`);
  });
  if (cles.length && cles[cles.length - 1].blocRotation < horizonBlocs) erreurs.push("the calendar stops before the horizon");
  return { ok: erreurs.length === 0, erreurs };
}

export function cleAuBloc(cal, b) {
  return cal.cles.find((k) => b >= k.blocDebut && b < k.blocRotation) ?? null;
}

// ------------------------------------------------------------------------------------------------
// Tirages deterministes
// ------------------------------------------------------------------------------------------------

function fmix32(x) {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Une graine par (graine, jour, rang) : la k-ieme session d'un jour tire les memes valeurs quelle
// que soit la lecture simulee, et deux lectures se comparent sur les memes tirages.
export function derive(...nombres) {
  let h = 0x9e3779b9;
  for (const x of nombres) h = fmix32(((h ^ fmix32(x)) + 0x6a09e667) >>> 0);
  return h;
}

// mulberry32 : arithmetique entiere 32 bits, meme suite sur toute machine
export function generateur(graine) {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const entre = (g, a, b) => a + (g() % (b - a + 1));

// ------------------------------------------------------------------------------------------------
// Simulation du testnet
// ------------------------------------------------------------------------------------------------

// Hypotheses de la simulation, pas des valeurs du texte. uniteTarif n'a pas de defaut (issue #33).
export const HYPOTHESES_SIMULATION = Object.freeze({
  uniteTarif: undefined,
  budget: null,                  // FLOP verses une fois ; defaut : jours x sequestreCible
  sequestreCible: "50",          // un creneau plein (escrow_per_reservation_slot) par canal
  sessionsParJour: [1, 5],
  simultanees: 2,
  issues: { cooperatif: 85, unilateral: 10, nonLivraison: 5 },   // pourcentages
  tours: [5, 50],
  jetonsParTour: [200, 2000],
  gnParJeton: null,              // defaut : l'exemple Llama-3-8B du §4.2
  dureeSessionBlocs: 3600,       // aussi la borne du timeout (max_duration absent du texte)
  margeRotationBlocs: 86400,
  plafondSessionParCle: null,    // defaut : la part du budget qui correspond a la duree de la cle
  lectureCreneaux: "avant",
  liberationUnilaterale: "finalize",
  appliquerReference: true,
  garde: true,
  parametres: {},
});

const LIBERATIONS = ["force_settle", "finalize", "jamais"];

function hypothesesSimulation(hyp, p, jours) {
  for (const k of Object.keys(hyp)) {
    if (!Object.hasOwn(HYPOTHESES_SIMULATION, k)) throw new ErreurParametre(`unknown simulation assumption: ${k}`);
  }
  const h = { ...HYPOTHESES_SIMULATION, ...hyp };
  uniteTarif(h.uniteTarif);
  const plage = (v, nom, min, max) => {
    if (!Array.isArray(v) || v.length !== 2) throw new ErreurParametre(`${nom} must be a [min, max] pair`);
    entier(v[0], `${nom}[0]`, min, max);
    entier(v[1], `${nom}[1]`, v[0], max);
    return [v[0], v[1]];
  };
  const sequestreCible = montant(h.sequestreCible, "sequestreCible", { strict: true });
  const r = {
    parametres: h.parametres ?? {},
    uniteTarif: h.uniteTarif,
    budget: h.budget === null || h.budget === undefined ? sequestreCible * BigInt(jours) : montant(h.budget, "budget"),
    sequestreCible,
    sessionsParJour: plage(h.sessionsParJour, "sessionsParJour", 0, 1_000),
    simultanees: entier(h.simultanees, "simultanees", 1, 1_000),
    tours: plage(h.tours, "tours", 1, p.channel_max_settlement_turns),
    jetonsParTour: plage(h.jetonsParTour, "jetonsParTour", 1, 10_000_000),
    gnParJeton: entier(h.gnParJeton ?? p.gn_par_jeton_reference, "gnParJeton", 0, 1_000_000),
    dureeSessionBlocs: entier(h.dureeSessionBlocs, "dureeSessionBlocs", 1, blocsParJour(p) - 1),
    margeRotationBlocs: entier(h.margeRotationBlocs, "margeRotationBlocs", 0, p.session_keys_max_duration_blocks - 1),
    plafondSessionParCle: h.plafondSessionParCle === null || h.plafondSessionParCle === undefined
      ? null : montant(h.plafondSessionParCle, "plafondSessionParCle"),
    lectureCreneaux: h.lectureCreneaux,
    liberationUnilaterale: h.liberationUnilaterale,
    appliquerReference: h.appliquerReference,
    garde: h.garde,
  };
  const iss = h.issues;
  if (iss === null || typeof iss !== "object") throw new ErreurParametre("issues must be an object of percentages");
  r.issues = {
    cooperatif: entier(iss.cooperatif, "issues.cooperatif", 0, 100),
    unilateral: entier(iss.unilateral, "issues.unilateral", 0, 100),
    nonLivraison: entier(iss.nonLivraison, "issues.nonLivraison", 0, 100),
  };
  if (r.issues.cooperatif + r.issues.unilateral + r.issues.nonLivraison !== 100) {
    throw new ErreurParametre("outcome shares (issues) must sum to 100");
  }
  if (!LECTURES_CRENEAUX.includes(r.lectureCreneaux)) {
    throw new ErreurParametre(`lectureCreneaux must be "avant" or "apres", got ${String(r.lectureCreneaux)}`);
  }
  if (!LIBERATIONS.includes(r.liberationUnilaterale)) {
    throw new ErreurParametre(`liberationUnilaterale must be one of ${LIBERATIONS.join(", ")}, got ${String(r.liberationUnilaterale)}`);
  }
  if (typeof r.appliquerReference !== "boolean" || typeof r.garde !== "boolean") {
    throw new ErreurParametre("appliquerReference and garde must be booleans");
  }
  if (r.budget < p.agent_identity_min_stake + p.existential_deposit) {
    throw new ErreurParametre(`budget ${enFlop(r.budget)} FLOP is below the identity stake plus the existential deposit`);
  }
  return r;
}

// Le budget est verse une fois sur le portefeuille de l'agent ; l'identite est enregistree (stake
// verrouille) et le depot existentiel est garde. Chaque jour, le libre est etale sur les jours
// restants, planJour fait le plan, puis l'executant ouvre les canaux un par un en reverifiant le
// permis de reservation, tire l'issue de chaque session et programme sa cloture. Une fermeture
// unilaterale ouvre la fenetre de contestation ; finalize tombe channel_dispute_window_blocks plus
// tard. Chaque jour est coupe aux rotations de cle : une session se termine avant la rotation.
export function simuler(jours, graine, hypotheses = {}) {
  entier(jours, "days", 1, 3650);
  entier(graine, "seed", 0, 0xffffffff);
  if (hypotheses === null || typeof hypotheses !== "object" || Array.isArray(hypotheses)) {
    throw new ErreurParametre("simulation assumptions must be an object");
  }
  const p = valeurs(hypotheses.parametres ?? {});
  const h = hypothesesSimulation(hypotheses, p, jours);
  const bpj = blocsParJour(p);
  const horizon = jours * bpj;
  const W = p.circuit_breaker_window;
  const fenetreLitige = p.channel_dispute_window_blocks;
  const cal = calendrierCles(null, p.session_keys_max_duration_blocks, p.block_time_seconds, h.margeRotationBlocs, horizon);
  const plafondCle = cal.cles.map((k) => h.plafondSessionParCle
    ?? (h.budget * BigInt(k.blocRotation - k.blocDebut) + BigInt(horizon) - 1n) / BigInt(horizon));
  const depenseCle = cal.cles.map(() => 0n);

  const verrouille = p.agent_identity_min_stake;
  const reserve = p.existential_deposit;
  let libre = h.budget - verrouille - reserve;
  const m = { depose: 0n, payeMineurs: 0n, payeTarif: 0n, rembourse: 0n, brule: 0n, indefini: 0n, enVol: 0n };
  const n = { voulus: 0, ouverts: 0, cooperatifs: 0, unilateraux: 0, nonLivres: 0, sautes: 0, depassements: 0, recharges: 0 };
  const canaux = [];
  const transactions = [];
  const depenseJour = [];
  const journal = [];
  const actifs = new Map();      // canal -> sequestre compte pour les creneaux, tant que le creneau est tenu
  const echeances = [];          // clotures et finalize a venir
  let premierSaut = null;
  const sequestreTenu = () => {
    let s = 0n;
    for (const v of actifs.values()) s += v;
    return s;
  };

  const appliquer = (ev) => {
    const c = ev.canal;
    const i = c.issue;
    if (ev.type === "cloture") {
      if (i.chemin === "cooperative") {
        m.enVol -= c.E;
        m.payeMineurs += c.E;
        actifs.delete(c.id);
      } else if (i.chemin === "non-delivery") {
        m.enVol -= c.E;
        libre += c.E;
        m.rembourse += c.E;
        actifs.delete(c.id);
      } else {
        // force_settle en fin de session (A2, A7) : la fenetre de contestation s'ouvre
        if (h.liberationUnilaterale === "force_settle") actifs.delete(c.id);
        echeances.push({ bloc: c.fin + fenetreLitige, type: "finalize", canal: c });
      }
      return;
    }
    m.enVol -= c.E;
    if (i.depassement) {
      m.indefini += c.E;         // P > E : issue non definie, rien n'est compte comme rendu
    } else {
      m.payeMineurs += i.mineur;
      m.payeTarif += i.mineur;
      m.brule += i.brule;
      libre += i.agent;
      m.rembourse += i.agent;
    }
    if (h.liberationUnilaterale === "finalize") actifs.delete(c.id);
    else if (h.liberationUnilaterale === "jamais" && actifs.has(c.id)) actifs.set(c.id, 0n);
  };
  // echeances de bloc strictement anterieur, dans l'ordre des blocs (a bloc egal, l'ordre d'arrivee)
  const traiter = (avant) => {
    for (;;) {
      let k = -1;
      for (let j = 0; j < echeances.length; j++) {
        if (echeances[j].bloc < avant && (k < 0 || echeances[j].bloc < echeances[k].bloc)) k = j;
      }
      if (k < 0) return;
      appliquer(echeances.splice(k, 1)[0]);
    }
  };
  const noterSaut = (d, combien) => {
    n.sautes += combien;
    if (combien > 0 && premierSaut === null) premierSaut = d;
  };

  for (let d = 0; d < jours; d++) {
    const debutJour = d * bpj;
    const finJour = debutJour + bpj;
    traiter(debutJour);
    const voulus = entre(generateur(derive(graine, d, 0x5eed)), h.sessionsParJour[0], h.sessionsParJour[1]);
    n.voulus += voulus;
    const allocation = libre > 0n ? libre / BigInt(jours - d) : 0n;
    let depense = 0n;
    let ouverts = 0;
    let sautes = 0;
    let rang = 0;
    const bornes = [debutJour, ...cal.cles.map((k) => k.blocRotation).filter((b) => b > debutJour && b < finJour), finJour];
    for (let s = 0; s + 1 < bornes.length; s++) {
      const debutSeg = bornes[s];
      const finSeg = bornes[s + 1];
      traiter(debutSeg);
      const cle = cleAuBloc(cal, debutSeg);
      const budgetSeg = minBig(allocation - depense, libre);
      const plan = planJour(budgetSeg > 0n ? budgetSeg : 0n, p, {
        sequestreCible: h.sequestreCible,
        sessionsVoulues: Math.max(0, voulus - ouverts),
        simultanees: h.simultanees,
        tenues: { nombre: actifs.size, sequestre: sequestreTenu() },
        plafondSessionRestant: plafondCle[cle.index] > depenseCle[cle.index] ? plafondCle[cle.index] - depenseCle[cle.index] : 0n,
        depenseDuJour: depense,
        dureeSessionBlocs: h.dureeSessionBlocs,
        debutBloc: debutSeg,
        finOuvertures: finSeg,
        finSessions: finSeg,
        historique: transactions.filter((x) => x.bloc > debutSeg - W),
        lectureCreneaux: h.lectureCreneaux,
        appliquerReference: h.appliquerReference,
        garde: h.garde,
      });
      sautes += plan.creneaux.refusCreneaux;
      noterSaut(d, plan.creneaux.refusCreneaux);
      for (const ses of plan.sessions) {
        traiter(ses.ouverture);
        const g = generateur(derive(graine, d, rang++));
        const u = g() % 100;
        const tours = entre(g, h.tours[0], h.tours[1]);
        const jetons = entre(g, h.jetonsParTour[0], h.jetonsParTour[1]);
        const permis = ouverturePermise({ nombre: actifs.size, sequestre: sequestreTenu() }, ses.sequestre, p, h.lectureCreneaux);
        if (!permis.ok || ses.sequestre > libre) {
          sautes++;
          noterSaut(d, 1);
          continue;
        }
        const E = ses.sequestre;
        const siennes = plan.transactions.filter((x) => x.canal === ses.id)
          .map((x) => ({ bloc: x.bloc, montant: x.montant, type: x.type, jour: d, cle: cle.index }));
        transactions.push(...siennes);
        n.recharges += siennes.length - 1;
        libre -= E;
        m.depose += E;
        m.enVol += E;
        depense += E;
        depenseCle[cle.index] += E;
        n.ouverts++;
        ouverts++;
        let issue;
        if (u < h.issues.cooperatif) {
          issue = issueCooperative(E);
          n.cooperatifs++;
        } else if (u < h.issues.cooperatif + h.issues.unilateral) {
          const G = BigInt(tours) * BigInt(jetons) * BigInt(h.gnParJeton);
          issue = issueUnilaterale({ E, n: tours, G, unite: h.uniteTarif }, p);
          n.unilateraux++;
          if (issue.depassement) n.depassements++;
        } else {
          issue = issueNonLivraison(E);
          n.nonLivres++;
        }
        const canal = { id: `${d}.${rang - 1}`, jour: d, cle: cle.index, ouverture: ses.ouverture, pret: ses.pret, fin: ses.fin, E, issue };
        canaux.push(canal);
        actifs.set(canal.id, E);
        echeances.push({ bloc: ses.fin, type: "cloture", canal });
      }
    }
    depenseJour.push(depense);
    journal.push({ jour: d, voulus, ouverts, sautes, depense, libre });
  }
  traiter(horizon);

  // controles de fin, chacun par une fonction independante de l'executant
  const disj = verifierDisjoncteur(transactions, p);
  const evenements = [];
  for (const c of canaux) {
    evenements.push({ bloc: c.ouverture, type: "ouvre", id: c.id, sequestre: c.E });
    if (c.issue.chemin !== "unilateral" || h.liberationUnilaterale === "force_settle") {
      evenements.push({ bloc: c.fin, type: "libere", id: c.id });
    } else {
      evenements.push({ bloc: c.fin + fenetreLitige, type: h.liberationUnilaterale === "finalize" ? "libere" : "vide", id: c.id });
    }
  }
  const cr = verifierCreneaux(evenements, p, h.lectureCreneaux);
  let horsCle = 0;
  for (const c of canaux) {
    const k = cal.cles[c.cle];
    if (!(c.ouverture >= k.blocDebut && c.ouverture < k.blocRotation && c.fin < k.blocDebut + cal.dureeMaxBlocs)) horsCle++;
  }
  for (const x of transactions) {
    const k = cal.cles[x.cle];
    if (!(x.bloc >= k.blocDebut && x.bloc < k.blocDebut + cal.dureeMaxBlocs)) horsCle++;
  }
  const bilan = libre + verrouille + reserve + m.enVol + m.payeMineurs + m.brule + m.indefini;
  return {
    jours,
    graine,
    hypotheses: h,
    montants: { budget: h.budget, ...m, libre, verrouille, reserve },
    compteurs: n,
    reservations: { pic: cr.pic, base: p.max_active_reservations_base, premierSaut },
    disjoncteur: { declenchements: disj.declenchements, pireNb: disj.pireNb, pireDepense: disj.pireDepense },
    calendrier: {
      cles: cal.cles.length,
      rotations: cal.rotations,
      usageMax: Math.max(...cal.cles.map((k) => k.blocRotation - k.blocDebut)),
      joursRotation: cal.cles.slice(1).map((k) => k.jourDebut),
    },
    controles: {
      parTransaction: h.appliquerReference ? transactions.filter((x) => x.montant > p.agent_per_tx_limit).length : 0,
      quotidien: h.appliquerReference ? depenseJour.filter((x) => x > p.agent_daily_cap_autonomous).length : 0,
      parCle: depenseCle.filter((x, i) => x > plafondCle[i]).length,
      disjoncteur: disj.declenchements,
      creneaux: cr.violations.length,
      cles: horsCle,
      calendrier: verifierCalendrier(cal).ok,
      conservationCanaux: canaux.filter((c) => !conserve(c.issue)).length,
      portefeuille: bilan === h.budget,
    },
    journal,
  };
}

const json = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v.toString() : v));

// ------------------------------------------------------------------------------------------------
// Resume en anglais (sortie de la ligne de commande, ASCII seulement)
// ------------------------------------------------------------------------------------------------

export function resume({ base, flop, jamais }) {
  const p = valeurs(base.hypotheses.parametres ?? {});
  const h = base.hypotheses;
  const m = base.montants;
  const n = base.compteurs;
  const c = base.controles;
  const L = [];
  // montants exacts : la conservation se lit a l'unite de base, une poussiere reste visible
  const ligne = (etiquette, v, suite = "") => `  ${etiquette.padEnd(22)}${enFlop(v)}${suite}`;
  L.push(`FLOP testnet agent budget: ${base.jours}-day simulation, seed ${base.graine} (day 0 is the opening day)`);
  L.push("");
  const surcharges = Object.keys(h.parametres ?? {});
  L.push(surcharges.length > 0
    ? `Parameter values (yellowpaper v0.5, except ${surcharges.join(", ")}, overridden for this run):`
    : "Paper values (yellowpaper v0.5, web page read on 2026-09-10; PARAMS in deals/budget.mjs quotes each one):");
  L.push(`  ${p.block_time_seconds} s blocks; session key at most ${groupe(p.session_keys_max_duration_blocks)} blocks; identity stake ${enFlop(p.agent_identity_min_stake)} FLOP; existential deposit ${enFlop(p.existential_deposit)} FLOP`);
  L.push(`  reservations ${p.max_active_reservations_base} + 1 per ${enFlop(p.escrow_per_reservation_slot)} FLOP escrowed; unilateral penalty ${p.refund_penalty_phi_percent} %; dispute window ${groupe(p.channel_dispute_window_blocks)} blocks`);
  L.push(`  circuit breaker ${p.circuit_breaker_tx_count} tx or ${enFlop(p.circuit_breaker_flop_cap)} FLOP per ${p.circuit_breaker_window} blocks (the window value is reference-only)`);
  L.push(`  per-tx ${enFlop(p.agent_per_tx_limit)} FLOP and daily ${enFlop(p.agent_daily_cap_autonomous)} FLOP: reference-only values, ${h.appliquerReference ? "applied here" : "not applied here"}`);
  L.push("");
  L.push("Assumptions (not in the paper):");
  L.push(`  budget ${lisible(h.budget)} FLOP funded once, spread over the days left; ${lisible(h.sequestreCible)} FLOP escrowed per channel`);
  L.push(`  ${h.sessionsParJour[0]} to ${h.sessionsParJour[1]} sessions wanted a day, at most ${h.simultanees} at once, ${groupe(h.dureeSessionBlocs)} blocks each (also the timeout bound)`);
  L.push(`  outcomes: ${h.issues.cooperatif} % cooperative, ${h.issues.unilateral} % unilateral, ${h.issues.nonLivraison} % miner non-delivery`);
  L.push(`  ${h.tours[0]} to ${h.tours[1]} turns of ${h.jetonsParTour[0]} to ${h.jetonsParTour[1]} tokens, ${h.gnParJeton} G_n a token (the paper's Llama-3-8B example, section 4.2)`);
  L.push(`  keys rotated ${groupe(h.margeRotationBlocs)} blocks before expiry; lifetime cap per key: ${h.plafondSessionParCle === null ? "its share of the budget" : `${lisible(h.plafondSessionParCle)} FLOP`} (the paper gives no value)`);
  L.push(`  reservation cap counted ${h.lectureCreneaux === "avant" ? "before" : "after"} the new channel's escrow; transaction fees not modeled; agent-leg rewards not counted (R9.12, E.40)`);
  L.push("");
  L.push(`Sessions, pay unit = base unit (1e-18 FLOP): ${n.voulus} wanted, ${n.ouverts} opened (${n.cooperatifs} cooperative, ${n.unilateraux} unilateral, ${n.nonLivres} miner non-delivery)`);
  L.push(`  ${n.sautes} skipped for want of a reservation slot; ${n.recharges} escrow top-ups; the rest of the demand was held back by the budget or the caps`);
  L.push("Money, in FLOP:");
  L.push(ligne("escrow deposited", m.depose));
  L.push(ligne("paid to miners", m.payeMineurs));
  L.push(ligne("  of which tariff P", m.payeTarif, "   (unilateral closes: a few base units each under this reading)"));
  L.push(ligne("refunded to agent", m.rembourse));
  L.push(ligne("burned (penalty)", m.brule));
  L.push(ligne("still escrowed", m.enVol, "   (unilateral closes awaiting finalize after the last day)"));
  L.push(ligne("free at the end", m.libre, `   (plus ${enFlop(m.verrouille)} staked, ${enFlop(m.reserve)} kept as existential deposit)`));
  L.push(`  ${"balance check".padEnd(22)}budget = free + stake + deposit + escrowed + paid + burned + undefined: ${c.portefeuille ? "exact to the base unit" : "BROKEN"}`);
  L.push("");
  L.push(`Same draws, pay unit = 1 FLOP (issue #33): P > E in ${flop.compteurs.depassements} of ${flop.compteurs.unilateraux} unilateral closes, where finalize has no stated outcome;`);
  L.push(`  ${lisible(flop.montants.indefini)} FLOP of escrow left without a defined outcome (counted as lost), ${lisible(flop.montants.brule)} FLOP burned`);
  L.push("");
  L.push(`Reservations: peak ${base.reservations.pic} held (base ${base.reservations.base}); here a unilateral close frees its slot at finalize, an assumption: section 12.2 frees on settle/expire/timeout/fraud only`);
  L.push(jamais.compteurs.sautes > 0
    ? `  if a unilateral close never freed its slot: ${jamais.compteurs.sautes} openings skipped, the first on day ${jamais.reservations.premierSaut}`
    : "  if a unilateral close never freed its slot: no opening skipped over this run");
  L.push("");
  L.push(`Circuit breaker: ${base.disjoncteur.declenchements} trips; busiest ${p.circuit_breaker_window}-block window ${base.disjoncteur.pireNb} tx and ${lisible(base.disjoncteur.pireDepense)} FLOP (limits ${p.circuit_breaker_tx_count - 1} tx, ${enFlop(p.circuit_breaker_flop_cap)} FLOP)`);
  L.push(`Session keys: ${base.calendrier.cles} keys, ${base.calendrier.rotations} rotations, each used at most ${groupe(base.calendrier.usageMax)} blocks;`);
  L.push(`  rotate at block height, days ${base.calendrier.joursRotation.map((j) => String(Number(j.toFixed(2)))).join(", ")} at the earliest (missed blocks only delay them)`);
  L.push(`Checks: per-tx ${c.parTransaction}, daily ${c.quotidien}, per-key ${c.parCle}, breaker ${c.disjoncteur}, reservations ${c.creneaux}, key lifetime ${c.cles}, channels conserved ${n.ouverts - c.conservationCanaux}/${n.ouverts}`);
  return L.join("\n");
}

// ------------------------------------------------------------------------------------------------
// selftest
// ------------------------------------------------------------------------------------------------

export function selftest() {
  const cas = [];
  const test = (nom, fn) => {
    let ok = false;
    let detail = "";
    try {
      ok = fn() === true;
    } catch (e) {
      detail = String(e?.message ?? e).slice(0, 160);
    }
    cas.push([nom, ok, detail]);
  };
  const refuse = (fn) => {
    try {
      fn();
    } catch (e) {
      return e instanceof ErreurParametre;
    }
    return false;
  };
  const U = UNITES_PAR_FLOP;
  const p = valeurs();
  const g = generateur(20260911);

  test("paper values: the fifteen parameters as quoted", () => p.agent_identity_min_stake === 10n * U
    && p.max_active_reservations_base === 4 && p.escrow_per_reservation_slot === 50n * U
    && p.refund_penalty_phi_percent === 20 && p.channel_base_per_turn === 1 && p.circuit_breaker_window === 60
    && p.circuit_breaker_tx_count === 100 && p.circuit_breaker_flop_cap === 250n * U
    && p.agent_per_tx_limit === 100n * U && p.agent_daily_cap_autonomous === 500n * U
    && p.session_keys_max_duration_blocks === 864000 && p.block_time_seconds === 1
    && p.channel_dispute_window_blocks === 604800 && p.existential_deposit === U / 100n && p.agent_share_ppt === 100);
  test("every parameter carries a status and a citation", () =>
    Object.values(PARAMS).every((d) => ["enforced", "reference-only", "prose", "exemple"].includes(d.statut) && d.citation.length > 40)
    && PARAMS_ABSENTS.every((a) => a.statut && a.ou && a.entree));

  const planOk = { sequestreCible: 50, sessionsVoulues: 1, plafondSessionRestant: 500, dureeSessionBlocs: 3600 };
  test("invalid: a penalty above 100 % is refused", () => refuse(() => valeurs({ refund_penalty_phi_percent: 120 })));
  test("invalid: a zero escrow per reservation slot is refused", () => refuse(() => valeurs({ escrow_per_reservation_slot: 0 })));
  test("invalid: an unknown parameter is refused", () => refuse(() => valeurs({ agent_daily_cap: 500 })));
  test("invalid: a fractional block count is refused", () => refuse(() => valeurs({ circuit_breaker_window: 60.5 })));
  test("invalid: an amount finer than 1e-18 FLOP is refused", () => refuse(() => versBase("0.0000000000000000001")));
  test("invalid: a negative budget is refused", () => refuse(() => planJour(-1, p, planOk)));
  test("invalid: a plan without a session cap is refused", () => refuse(() => planJour(100, p, { ...planOk, plafondSessionRestant: undefined })));
  test("invalid: escrow held without a held reservation is refused", () =>
    refuse(() => planJour(100, p, { ...planOk, tenues: { nombre: 0, sequestre: 42 } })));
  test("invalid: an unchosen pay unit is refused (issue #33)", () =>
    refuse(() => issueUnilaterale({ E: 50, n: 1, G: 1 }, p)) && refuse(() => simuler(5, 1, {})));
  test("invalid: a rotation margin not below the key lifetime is refused", () => refuse(() => calendrierCles(null, 864000, 1, 864000)));
  test("invalid: outcome shares not summing to 100 are refused", () =>
    refuse(() => simuler(5, 1, { uniteTarif: "base", issues: { cooperatif: 80, unilateral: 10, nonLivraison: 5 } })));
  test("invalid: turns above channel_max_settlement_turns are refused", () => refuse(() => simuler(5, 1, { uniteTarif: "base", tours: [1, 1025] })));
  test("invalid: a budget below the identity stake is refused", () => refuse(() => simuler(5, 1, { uniteTarif: "base", budget: 10 })));
  test("invalid: a seed outside 32 bits is refused", () => refuse(() => simuler(5, 2 ** 32, { uniteTarif: "base" })));

  // --- issue d'un canal : conservation a l'unite de base
  const phis = Array.from({ length: 101 }, (_, i) => valeurs({ refund_penalty_phi_percent: i }));
  const tireE = () => (BigInt(1 + (g() % 100_000)) * U) / BigInt(1 + (g() % 997)) + BigInt(g() % 1000);
  test("conservation: a cooperative close pays the whole escrow (200 draws)", () => {
    for (let i = 0; i < 200; i++) {
      const E = tireE();
      const r = issueCooperative(E);
      if (!conserve(r) || r.mineur !== E || r.agent !== 0n || r.brule !== 0n) return false;
    }
    return true;
  });
  const balayage = (unite) => {
    let depassements = 0;
    for (let i = 0; i < 500; i++) {
      const pp = phis[g() % 101];
      const E = tireE();
      const tours = g() % 1025;
      const G = BigInt(g()) * BigInt(1 + (g() % 1000));
      const r = issueUnilaterale({ E, n: tours, G, unite }, pp);
      const P = tarifP({ n: tours, G, unite }, pp);
      if (!conserve(r) || r.mineur !== P || r.depassement !== (P > E)) return -1;
      if (r.depassement) depassements++;
    }
    return depassements;
  };
  test("conservation: unilateral close, pay unit = base unit (500 draws)", () => balayage("base") === 0);
  test("conservation: unilateral close, pay unit = 1 FLOP, P > E among them (500 draws)", () => balayage("flop") > 0);
  test("conservation: a miner non-delivery refunds the whole escrow", () => {
    for (let i = 0; i < 100; i++) {
      const E = tireE();
      const r = issueNonLivraison(E);
      if (!conserve(r) || r.agent !== E || r.mineur !== 0n || r.brule !== 0n) return false;
    }
    return true;
  });
  const E50 = 50n * U;
  const G20 = 20n * 1000n * 16n;          // 20 tours de 1 000 jetons a 16 G_n
  test("P > E is flagged and shown, never hidden (pay unit = 1 FLOP)", () => {
    const r = issueUnilaterale({ E: E50, n: 20, G: G20, unite: "flop" }, p);
    return r.depassement && r.note !== null && r.agent < 0n && r.brule < 0n && conserve(r) && r.P === (20n + G20) * U;
  });
  test("pay unit = base unit: the miner gets dust, the rest splits 80/20", () => {
    const r = issueUnilaterale({ E: E50, n: 20, G: G20, unite: "base" }, p);
    const P = 20n + G20;
    const brule = ((E50 - P) * 20n) / 100n;
    return !r.depassement && r.mineur === P && r.brule === brule && r.agent === E50 - P - brule && conserve(r);
  });
  test("pay unit = 1 FLOP, small tariff: P comes out of E, the rest splits 80/20", () => {
    const r = issueUnilaterale({ E: E50, n: 10, G: 20, unite: "flop" }, p);
    return !r.depassement && r.mineur === 30n * U && r.brule === 4n * U && r.agent === 16n * U;
  });
  test("the penalty never reaches the miner (phi from 0 to 100)", () =>
    phis.every((pp) => {
      const r = issueUnilaterale({ E: E50, n: 3, G: 5, unite: "base" }, pp);
      return r.mineur === 8n && conserve(r);
    }));
  test("a non-delivery equals R12.1d with phi 0 and nothing delivered", () => {
    const a = issueNonLivraison(E50);
    const b = issueUnilaterale({ E: E50, n: 0, G: 0, unite: "base" }, phis[0]);
    return a.mineur === b.mineur && a.agent === b.agent && a.brule === b.brule;
  });

  // --- reservations
  test("reservation cap: 4, plus one slot per whole 50 FLOP escrowed", () => creneauxPermis(0, p) === 4
    && creneauxPermis("49.999999999999999999", p) === 4 && creneauxPermis(50, p) === 5 && creneauxPermis(200, p) === 8);
  test("reservation readings: the new escrow counts only when read 'apres'", () =>
    ouverturePermise({ nombre: 4, sequestre: 0n }, E50, p, "apres").ok === true
    && ouverturePermise({ nombre: 4, sequestre: 0n }, E50, p, "avant").ok === false);
  test("reservation checker refuses a fifth 10 FLOP channel", () => {
    const ev = [1, 2, 3, 4, 5].map((b) => ({ bloc: b, type: "ouvre", id: b, sequestre: 10n * U }));
    const r = verifierCreneaux(ev, p, "avant");
    return !r.ok && r.violations.length === 1 && r.violations[0].id === 5;
  });

  // --- plans au hasard, relus par les controles independants
  let plans = null;
  try {
    plans = [];
    for (let i = 0; i < 300; i++) {
      const hyp = {
        sequestreCible: 1 + (g() % 300),
        sessionsVoulues: g() % 31,
        simultanees: 1 + (g() % 8),
        tenues: (() => {
          const nombre = g() % 7;
          return { nombre, sequestre: nombre === 0 ? 0n : BigInt(g() % 401) * U };
        })(),
        plafondSessionRestant: g() % 3001,
        depenseDuJour: g() % 601,
        dureeSessionBlocs: 60 + (g() % 7141),
        lectureCreneaux: g() % 2 ? "avant" : "apres",
      };
      const budget = g() % 2001;
      plans.push({ budget: BigInt(budget) * U, hyp, plan: planJour(budget, p, hyp) });
    }
  } catch (e) {
    plans = null;
    cas.push([`planner sweep ran (${String(e?.message ?? e).slice(0, 80)})`, false, ""]);
  }
  test("planner sweep is not empty (300 random days, some with several channels)", () =>
    plans !== null && plans.filter((x) => x.plan.canaux > 1).length > 20);
  test("planner: never beyond the reservation cap (300 random days)", () => plans !== null && plans.every(({ hyp, plan }) => {
    const initiaux = Array.from({ length: hyp.tenues.nombre }, (_, i) => ({ id: `t${i}`, sequestre: i === 0 ? hyp.tenues.sequestre : 0n }));
    const ev = plan.sessions.flatMap((s) => [{ bloc: s.ouverture, type: "ouvre", id: s.id, sequestre: s.sequestre }, { bloc: s.fin, type: "libere", id: s.id }]);
    return verifierCreneaux(ev, p, hyp.lectureCreneaux, initiaux).ok;
  }));
  test("planner: never beyond per-tx, daily, session-cap or budget ceilings", () => plans !== null && plans.every(({ budget, hyp, plan }) => {
    const restant = 500n * U - BigInt(hyp.depenseDuJour) * U;
    const plafond = minBig(budget, BigInt(hyp.plafondSessionRestant) * U, restant > 0n ? restant : 0n);
    return plan.depense <= plafond && plan.transactions.every((x) => x.montant <= 100n * U)
      && plan.transactions.reduce((s, x) => s + x.montant, 0n) === plan.depense;
  }));
  test("planner: never trips the circuit breaker", () => plans !== null && plans.every(({ plan }) => verifierDisjoncteur(plan.transactions, p).ok));
  test("planner: one transaction per block, every session inside the day", () => plans !== null && plans.every(({ plan }) =>
    new Set(plan.transactions.map((x) => x.bloc)).size === plan.transactions.length && plan.sessions.every((s) => s.fin < 86400)));
  test("a 250 FLOP channel takes one open and two top-ups under the 100 FLOP per-tx cap", () => {
    const r = planJour(1000, p, { sequestreCible: 250, sessionsVoulues: 1, plafondSessionRestant: 1000, dureeSessionBlocs: 600 });
    return r.canaux === 1 && r.recharges.parCanal === 2 && r.transactions.map((x) => enFlop(x.montant)).join(",") === "100,100,50";
  });
  test("the daily cap stops a day at 500 FLOP: two 250 FLOP channels of five wanted", () => {
    const r = planJour(10_000, p, { sequestreCible: 250, sessionsVoulues: 5, simultanees: 5, plafondSessionRestant: 10_000, dureeSessionBlocs: 600 });
    return r.canaux === 2 && r.depense === 500n * U && r.plafonds.disjoncteur.respecte && r.plafonds.quotidien.respecte;
  });

  // --- disjoncteur : le detecteur sait dire oui
  test("breaker detector: a third 100 FLOP transaction in a minute trips", () => {
    const r = verifierDisjoncteur([0, 1, 2].map((b) => ({ bloc: b, montant: 100n * U })), p);
    return r.declenchements === 1 && r.premierDeclenchement === 2;
  });
  test("breaker detector: 100 transactions inside 60 blocks trip", () =>
    verifierDisjoncteur(Array.from({ length: 100 }, (_, i) => ({ bloc: Math.floor(i / 2), montant: 0n })), p).declenchements === 1);
  test("one transaction per block never reaches the 100-tx limb (60 a window at most)", () => {
    const r = verifierDisjoncteur(Array.from({ length: 1000 }, (_, i) => ({ bloc: i, montant: 0n })), p);
    return r.ok && r.pireNb === 60;
  });

  // --- cles de session
  test("keys: 90 days with a one-day margin make 10 keys, none used past its lifetime", () => {
    const cal = calendrierCles(null, 864000, 1, 86400);
    return cal.cles.length === 10 && cal.rotations === 9 && verifierCalendrier(cal).ok
      && cal.cles.every((k) => k.blocRotation - k.blocDebut <= 777600);
  });
  test("keys: no margin makes 9 keys, contiguous, to the last block", () => {
    const cal = calendrierCles(null, 864000, 1, 0);
    return cal.cles.length === 9 && verifierCalendrier(cal).ok && cal.cles[cal.cles.length - 1].blocRotation === 7776000;
  });
  test("keys: the checker catches a key kept one block too long", () => {
    const cal = calendrierCles(null, 864000, 1, 0);
    const k = cal.cles[4];
    const trop = k.blocDebut + 864001;
    const faux = { ...cal, cles: cal.cles.map((x, i) => (i === 4 ? { ...x, blocRotation: trop } : i === 5 ? { ...x, blocDebut: trop } : x)) };
    return !verifierCalendrier(faux).ok;
  });
  test("keys: dates are the earliest ones, at the target cadence", () =>
    calendrierCles("2030-01-01T00:00:00Z", 864000, 1, 86400).cles[1].dateDebut === "2030-01-10T00:00:00.000Z");

  // --- simulations
  const simBase = simuler(90, 7, { uniteTarif: "base" });
  test("90-day run: no per-tx, daily, per-key, breaker, reservation or key-lifetime violation", () => {
    const c = simBase.controles;
    return c.parTransaction === 0 && c.quotidien === 0 && c.parCle === 0 && c.disjoncteur === 0 && c.creneaux === 0
      && c.cles === 0 && c.calendrier && simBase.compteurs.ouverts > 50;
  });
  test("90-day run: every channel conserves its escrow, the wallet balances exactly", () =>
    simBase.controles.conservationCanaux === 0 && simBase.controles.portefeuille);
  test("90-day run: the same seed gives the same output", () => json(simuler(90, 7, { uniteTarif: "base" })) === json(simBase));
  test("90-day run: another seed gives another output", () => json(simuler(90, 8, { uniteTarif: "base" })) !== json(simBase));
  const simFlop = simuler(90, 7, { uniteTarif: "flop" });
  test("pay unit = 1 FLOP: every unilateral close of the run has P > E", () =>
    simFlop.compteurs.unilateraux > 0 && simFlop.compteurs.depassements === simFlop.compteurs.unilateraux && simFlop.controles.portefeuille);
  test("pay unit = base unit: no unilateral close has P > E", () =>
    simBase.compteurs.unilateraux > 0 && simBase.compteurs.depassements === 0);
  const rafale = { uniteTarif: "base", budget: 100_000, sequestreCible: 100, sessionsParJour: [5, 5], simultanees: 5 };
  test("guard off: a burst of openings trips the simulated breaker", () => simuler(10, 3, { ...rafale, garde: false }).controles.disjoncteur > 0);
  test("guard on: the same burst is paced and never trips", () => {
    const s = simuler(10, 3, rafale);
    return s.controles.disjoncteur === 0 && s.compteurs.ouverts === 50;
  });
  test("never-freed reading: leaked slots block later openings", () => {
    const hyp = { uniteTarif: "base", issues: { cooperatif: 50, unilateral: 50, nonLivraison: 0 } };
    const jamais = simuler(90, 11, { ...hyp, liberationUnilaterale: "jamais" });
    const finalize = simuler(90, 11, { ...hyp, liberationUnilaterale: "finalize" });
    return jamais.compteurs.sautes > finalize.compteurs.sautes && jamais.controles.creneaux === 0 && jamais.controles.portefeuille;
  });

  for (const [nom, ok, detail] of cas) {
    console.log(`  ${nom.padEnd(84)} ${ok ? "reussi" : "ECHOUE"}${ok || !detail ? "" : `  (${detail})`}`);
  }
  const echecs = cas.filter(([, ok]) => !ok).length;
  console.log(`budget : ${cas.length - echecs}/${cas.length}`);
  return echecs ? 1 : 0;
}

// ------------------------------------------------------------------------------------------------
// Ligne de commande
// ------------------------------------------------------------------------------------------------

const USAGE = [
  "usage:",
  "  node deals/budget.mjs simulate [--days 90] [--budget X] [--seed N]",
  "      X: FLOP funded once to the agent wallet (default: days x 50); N: 32-bit seed (default 1)",
  "  node deals/budget.mjs selftest",
].join("\n");

function lireOptions(args) {
  const o = { days: 90, budget: null, seed: 1 };
  for (let i = 0; i < args.length; i += 2) {
    const [cle, v] = [args[i], args[i + 1]];
    if (v === undefined) throw new ErreurParametre(`option ${cle} needs a value`);
    if (cle === "--days") o.days = Number(v);
    else if (cle === "--budget") o.budget = v;
    else if (cle === "--seed") o.seed = Number(v);
    else throw new ErreurParametre(`unknown option: ${cle}`);
  }
  return o;
}

function commandeSimulate(args) {
  const o = lireOptions(args);
  const hyp = o.budget === null ? {} : { budget: o.budget };
  const base = simuler(o.days, o.seed, { ...hyp, uniteTarif: "base" });
  const flop = simuler(o.days, o.seed, { ...hyp, uniteTarif: "flop" });
  const jamais = simuler(o.days, o.seed, { ...hyp, uniteTarif: "base", liberationUnilaterale: "jamais" });
  console.log(resume({ base, flop, jamais }));
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("budget.mjs")) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === "selftest") process.exit(selftest());
    else if (cmd === "simulate") process.exit(commandeSimulate(args));
    else {
      console.error(USAGE);
      process.exit(2);
    }
  } catch (e) {
    if (!(e instanceof ErreurParametre)) throw e;
    console.error(`invalid input: ${e.message}`);
    process.exit(2);
  }
}
