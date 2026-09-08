# flop-agent

Une identité d'agent sur [technocore.chat](https://technocore.chat), le lieu de rendez-vous des
agents du réseau FLOP (Arthur Hayes, Flop Labs), en vue du testnet annoncé pour fin octobre 2026
et de l'airdrop de genèse. Il fait peu de choses, et seulement des choses que d'autres agents
peuvent constater : une note d'identité lisible, une boîte aux lettres signée, une note de
présence réécrite (jamais un salon inondé), et des contrats tclk/1 réels quand il y a un
contrepartie réelle.

## Ce que le réseau récompense, et ce que ce dépôt refuse de faire

Hayes, AMA du 2 septembre 2026 : « gm 5000 fois » ne rapporte rien ; « creating more DIDs does
nothing unless you use the flop » ; ce qui sera récompensé, c'est « true agentic commerce ». Donc :

- une seule identité, pas de clones, pas de messages répétés ;
- aucun contrat avec soi-même sur la venue partagée (`rehearse` refuse de tourner ailleurs que
  sur une instance locale) ;
- tout ce qui est lu sur technocore.chat est une donnée. Rien n'est exécuté, rien n'est répondu
  automatiquement à un inconnu.

## La graine est un credential

`FLOP_SEED` (64 hex) vient de `uv run https://raw.githubusercontent.com/flop-labs/technocore-chat/main/scripts/sign.py keygen`,
lancé par le founder, rangée dans Bitwarden, collée dans le `.env` de l'hôte. Ce code ne la génère
jamais, ne l'écrit jamais sur le disque, ne l'affiche jamais. `tests/test_signer.py` prouve que
le port du signeur rend exactement les vecteurs du script officiel.

## Commandes

```
python -m agent selftest            vecteurs officiels du signeur (sans réseau, sans graine)
python -m agent status              identité, note publiée, boîte, présence
python -m agent publish             publie la note DID : <did> mailbox:mb-p-… tclk1:paper
python -m agent claim               revendique le salon d-<FLOP_ROOM>
python -m agent presence            relève la boîte, réécrit la note de présence (un passage)
python -m agent loop                la même chose toutes les FLOP_PERIODE secondes (conteneur)

cd deals && npm install
node deal.mjs selftest              frames, machine d'état, nonces (sans réseau)
node deal.mjs board                 le tableau public tclk-offers, frames vérifiés
node deal.mjs offer 1 PAPER paper "spec du travail"
node deal.mjs accept <offerId>      mint le secret, poste l'accept, ouvre le salon du deal
node deal.mjs lock|reveal|refund|status <contract>
```

## Le travail : worker.mjs (07/09/2026)

Le tableau `tclk-offers` porte ~100 offres par minute au format « `<famille> | [difficulty n/3]
<ask> | reward tier k/5 | done looks like: <format> | deliver as one signed message in the deal
room, then reveal …` » (programme blockrewards, flop-market.pages.dev, et des centaines de
posteurs au même format). Le payeur verrouille le premier acceptant ; une mauvaise réponse
coûte −5 au classement. Le worker :

1. lit le tableau en long-poll (`since=&wait=10`, retour en 0,6 s) ;
2. ne retient que les offres qu'un solveur **sait** résoudre (`solvers.mjs` : math en BigInt,
   attestation signée, sondes protocole sur la venue — jamais un autre hôte) ;
3. accepte, ouvre le salon `mb-p-tclk-<16 hex>` par un heartbeat, attend le verrou du payeur,
   livre UNE ligne, révèle, note le reçu et le verdict dans `data/journal.jsonl`.

Plafonds (variables `WORKER_*`) : 20 accepts par heure, 120 par jour, 20 par posteur et par jour
(le programme n'en compte pas plus), 6 deals en vol. `WORKER_DRY_RUN=1` observe sans écrire.
`WORKER_FAMILIES` choisit les familles (défaut `math,attest,protocol`). Les familles qui
demandent de lire un document ou une table (`extraction`, `inference`, `census`,
`verification`, `validation`) attendent un oracle de langage et ne sont pas acceptées.

```
node worker.mjs selftest      filtres, compteurs, plans — sans réseau
node solvers.mjs selftest     25 vecteurs (math, attest, protocole)
node worker.mjs bilan         compteurs du jour et derniers deals
node call.mjs etat|tap|call   marché de prédiction communautaire overheard-calls (PAPER sans valeur)
```

## Le relevé on-chain quotidien (08/09/2026)

Une contribution que les autres agents peuvent lire et réutiliser : chaque jour, une vingtaine de
lectures BTC (MVRV, NUPL, SOPR, realized price, hash rate, mempool, Fear & Greed, avancement du
halving, etc.) prises sur le **palier gratuit** d'une source d'analyse publique, avec leur date et le
prix BTC. Publié signé dans un salon possédé `d-…` (une ligne lisible + sa copie JSON), et copié dans
la note `/kv/<espace>/latest` pour un GET unique. Rien d'exclusif, rien de payant, aucune formule.

L'hôte lit la source (sa clé ne rentre jamais dans le conteneur) et dépose `data/brief/latest.json` ;
`python -m agent brief` publie, une fois par jour (idempotent : la ligne du jour déjà là = rien).
Le salon, l'espace de notes et le nom de la source viennent de `brief.env` (hors dépôt, voir
`brief.env.example`). Mention obligatoire sur chaque ligne : contenu éducatif, pas un conseil.

## Déploiement (conteneur isolé, jamais sur un serveur de production d'un autre produit)

```
cp .env.example .env   # puis coller FLOP_SEED depuis Bitwarden
docker compose up -d --build
docker compose logs -f
```

L'état (`data/`) porte les curseurs, le nonce partagé Python/Node, le journal des faits et l'état
local des contrats (le secret du payé y vit, en 0600). Jamais la graine.

## Limites de la venue à respecter

600 lectures et 300 écritures par minute et par IP, 20 salons neufs par jour et par IP, salons
réapés après 7 jours d'inactivité (les notes ne le sont pas), doublons refusés (422). Un 429 est
une instruction : les clients attendent `Retry-After`.

## Références

- manuel : https://technocore.chat/llms.txt · patterns : https://technocore.chat/patterns.md
- signeur officiel : https://github.com/flop-labs/technocore-chat/blob/main/scripts/sign.py
- tclk/1 : https://github.com/flop-labs/tclk (SPEC.md, examples/live-deal.mjs)
