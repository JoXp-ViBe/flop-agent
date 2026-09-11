# flop-agent

An agent identity on [technocore.chat](https://technocore.chat), the meeting point of agents on
the FLOP network (Arthur Hayes, Flop Labs), ahead of the testnet announced for late October 2026
and the genesis airdrop. It does few things, and only things other agents can verify: a readable
identity note, a signed mailbox, a presence note that is rewritten (never a flooded room), real
tclk/1 contracts when there is a real counterparty, and a daily on-chain reading room.

Code comments are in French; the README, the CLI help and every message posted on the venue are
in English.

## Board Observatory

**[joxp-vibe.github.io/flop-agent](https://joxp-vibe.github.io/flop-agent/)** measures what the
tclk board actually contains, and separates it from what an agent reading the board manages to
see. Those are not the same board.

Roughly four in ten signed frames on that board are perfectly valid and invisible to a reader
written in JavaScript the obvious way. A frame's nonce is signed as text and sent as a JSON
number; agents that stamp it in nanoseconds produce nineteen digits, past the `2^53` a
JavaScript number represents exactly. `JSON.parse` rounds it, the reconstructed string no
longer matches what was signed, and the frame fails verification with nothing wrong with it.
This repo had that bug until 9 September 2026.

The page hard-codes no figure: it reads `docs/data.json`, produced by `deals/observatory.mjs`
and regenerated hourly by a workflow that runs on public runners, needs no secret, and can be
re-run from a fork. The reading module (`deals/signing_public.mjs`) has no path to a signing
key at all — the guarantee is what the file does not contain, not a promise in a comment.

```
node deals/observatory.mjs selftest   # 26 checks, armed in both directions, no network
node deals/observatory.mjs            # measure the live board, write docs/data.json
```

## What the network rewards, and what this repo refuses to do

Hayes, AMA of 2 September 2026: "gm 5000 times" earns nothing; "creating more DIDs does nothing
unless you use the flop"; what gets rewarded is "true agentic commerce". Hence:

- one identity, no clones, no repeated messages;
- no contract with oneself on the shared venue (`rehearse` refuses to run anywhere but on a local
  instance);
- everything read on technocore.chat is data. Nothing is executed, nothing is answered
  automatically to a stranger.

## The seed is a credential

`FLOP_SEED` (64 hex) comes from `uv run https://raw.githubusercontent.com/flop-labs/technocore-chat/main/scripts/sign.py keygen`,
run by the operator, stored in a password manager, pasted into the host's `.env`. This code never
generates it, never writes it to disk, never prints it. `tests/test_signer.py` proves that the
signer port reproduces the official script's vectors exactly.

## The owner account (FLOP testnet)

The DID note carries one more record, beside `mailbox:`:

```text
flop-owner: sr25519 <public key, 0x hex> <issued, unix seconds> <owner sig> <did sig>
```

Both signatures cover the same UTF-8 string `flop-owner|<did>|sr25519|<public key>|<issued>`, where
`<did>` is the note's own did:key. The owner signature is sr25519 (schnorrkel, signing context
`substrate`), the did signature is the agent's ed25519 key; both are base64url, like a `delegate:`
record. Each key vouches for the other, so the record fails as soon as it is copied into another
note or edited. The owner key is not in this repository and this code never reads it. The published
record was checked on the note as the venue serves it, with two independent sr25519 implementations
(`@polkadot/util-crypto` 14.0.3, `@scure/sr25519` 2.4.0). To check it with the first:

```js
const msg = new TextEncoder().encode(`flop-owner|${did}|sr25519|${pub}|${issued}`);
sr25519Verify(msg, Buffer.from(ownerSig, 'base64url'), pub);         // the owner key signed it
ed25519Verify(msg, Buffer.from(didSig, 'base64url'), didPublicKey);  // and so did the agent
// didPublicKey: base58btc-decode the did:key after its "z", drop the 0xed01 prefix
```

`python -m agent publish` keeps this record, like every field it does not write itself.

## Commands

```
python -m agent selftest            official signer vectors + note merge (no network, no seed)
python -m agent status              identity, published note, mailbox, presence
python -m agent publish             keep mailbox: and tclk1: current in the DID note, every other field kept
python -m agent claim               claim the owned room d-<FLOP_ROOM>
python -m agent presence            read the mailbox, rewrite the presence note (one pass)
python -m agent loop                the same every FLOP_PERIODE seconds (container)
python -m agent brief               publish today's on-chain readings (see below)

cd deals && npm install
node deal.mjs selftest              frames, state machine, nonces (no network)
node deal.mjs board                 the public tclk-offers board, verified frames
node deal.mjs offer 1 PAPER paper "spec of the work"
node deal.mjs accept <offerId>      mint the secret, post the accept, open the deal room
node deal.mjs lock|reveal|refund|status <contract>
node budget.mjs selftest            channel conservation, caps, circuit breaker, key calendar (no network)
node budget.mjs simulate            90-day testnet spend on the yellowpaper v0.5 values [--days --budget --seed]
```

## The work: worker.mjs

The `tclk-offers` board carries ~100 offers per minute in the form "`<family> | [difficulty n/3]
<ask> | reward tier k/5 | done looks like: <format> | deliver as one signed message in the deal
room, then reveal …`" (blockrewards program, flop-market.pages.dev, and hundreds of posters using
the same format). The payer locks the first accepter; a wrong answer costs points. The worker:

1. reads the board with long-polling (`since=&wait=10`, returns in 0.6 s);
2. keeps only the offers a solver **knows** how to solve (`solvers.mjs`: BigInt math, signed
   attestations, protocol probes on the venue itself, never another host; `tables.mjs`: counts
   and rankings over a posted table; `docs.mjs` and `validation.mjs`: questions over an
   allow-listed document and verdicts on someone else's deliverable, answered through a
   file-based language-model oracle that runs outside the container, with no tools);
3. accepts, opens the room `mb-p-tclk-<16 hex>` with a heartbeat, waits for the payer's lock,
   delivers ONE line, reveals, records the receipt and the verdict in `data/journal.jsonl`. When the
   venue refuses a new room (daily room quota), it delivers on the board instead.

Caps (`WORKER_*` variables): 40 accepts per hour (one every 90 s), 800 per day, 20 per poster and
per day (the program scores no more), 6 deals in flight. The venue grants 20 new rooms per IP per day,
one every 72 minutes (`limits.new_rooms_per_day_per_ip`), so the worker creates a deal room only for an
attestation, whose line must be in the room before the lock (`WORKER_ROOMS_PER_HOUR`, default 3); every other
deal waits for the room the payer opens, or delivers on the board. Measured over 3 days before this rule: 2,963
refused room creations for 3,429 deals, and locks came anyway. `WORKER_DRY_RUN=1` observes without
writing. `WORKER_FAMILIES` selects the families (default `math,attest,protocol,docs,tables,validation`).
A family whose verdicts drop can be suspended at runtime through `data/suspensions.json`.

```
node worker.mjs selftest      filters, counters, plans (no network)
node solvers.mjs selftest     25 vectors (math, attest, protocol)
node tables.mjs selftest      table parsing and answer templates
node worker.mjs bilan         today's counters and latest deals
node call.mjs etat|tap|call   the community prediction market overheard-calls (PAPER has no value)
```

## The probe responder: probe.mjs

Since 8 September 2026 the venue operator runs a labelled experiment: one key posts
`probe v1 | <id> | <kind> | <payload>` lines into busy rooms (`null` = a silence baseline, `ask` = a
question to answer citing the id, `offer` = a zero-paper tclk offer to accept) and measures who answers
within 120 s. `flop-probe` answers each probe once, only when it comes from the announced key and is
still inside the window: a canned, honest answer written in the code for known questions (an unknown
question is journaled, never improvised from the probe text), and a library-shaped accept for offers.
Caps: 60 replies per hour, 20 s between two posts in the same room. `PROBE_ROOMS`, `PROBE_DID`.

```
node probe.mjs selftest       parsing, canned answers, accept shape, refusals
```

## The other side of commerce: payer.mjs

Hayes rewards "true agentic commerce"; a worker only shows one side of it. `flop-payer` (opt-in:
`docker compose --profile payer up -d`) posts tclk/1 offers on the board in the program's own format,
paper rail, no value: one offer every 10 minutes, at most 60 a day and 2 in flight. Every task carries an
answer computed by the payer beforehand, so the judge is exact and never a language model: read the daily
readings note and report its date and count, count today's signed lines in the owned room, or post the
canonical `tclk-attest <contract id>` line and deliver its seq. The tasks are useful to the operator: a
stranger proves, in real conditions, that the published data is readable by another agent.

On accept: paper lock through the official rail, lock frame in the payee's deal room if it exists, otherwise on
the board and then in a room the payer opens itself (the program's convention: honest workers deliver in the
room the payer opened; a venue refusal leaves the deal board-only), then receipt + a `review … PASS 1: …` /
`FAIL 0: …` line the workers can read. One new room per deal on the IP's daily quota: 20 offers a day.
Most payees never open a room (the venue's global room cap): the payer watches both the deal room and the
board for the delivery line and the reveal frame, and re-reads the board's export ring on start-up. A reveal
or a paper claim without any delivery line is receipted `claimed` (the rail's truth) and reviewed `FAIL 0`.
The first accepter is usually a sniper (accepts within seconds, reveals or claims the paper, never delivers), so
the payer lets accepts arrive for a few seconds (`PAYER_ACCEPT_WINDOW_MS`, 8 s) and locks the most reliable
candidate: a payee that already delivered to us first, a payee we saw sniping last, then the community
blockrewards passport (public passes/fails, read over HTTP as data, cached 6 h), then arrival order.
No delivery and no claim by the refund time: refund frame + receipt refunded. Rehearse on a local venue first:
`node deals/payer.mjs rehearse` refuses to run against the shared venue; `deals/rehearse_payee_board.mjs`
plays a board-only payee in four moods (honest, sniper, rail-only, ghost).

```
node payer.mjs selftest       tasks, judge, spec format, offer validity, review line
```

## The daily on-chain readings

A contribution other agents can read and reuse: every day, about twenty BTC readings (MVRV, NUPL,
SOPR, realized price, hash rate, mempool, Fear & Greed, halving progress, etc.) taken from the
**free tier** of a public analytics source, with their date and the BTC price. Published signed in an
owned `d-…` room (one readable line plus its JSON copy) and mirrored in the note
`/kv/<namespace>/latest` for a single GET. Nothing exclusive, nothing paid, no formula.

The host reads the source (its key never enters the container) and drops `data/brief/latest.json`;
`python -m agent brief` publishes it, once a day (idempotent: today's line already there = nothing).
The room, the note namespace and the source name come from `brief.env` (outside the repo, see
`brief.env.example`). Every line carries the mention: educational content, not investment advice.

## Deployment (an isolated container, never on a production server of another product)

```
cp .env.example .env   # then paste FLOP_SEED from your password manager
docker compose up -d --build
docker compose logs -f
```

The state (`data/`) holds the cursors, the nonce shared by Python and Node, the journal of facts and
the local state of contracts (the payee's secret lives there, mode 0600). Never the seed.

## Venue limits to respect

600 reads and 300 writes per minute per IP, 20 new rooms per day per IP (plus a global room cap),
rooms reclaimed after 7 days of inactivity (notes after 7 days too), duplicates refused (422). A 429
is an instruction: clients wait for `Retry-After`, and give up beyond a minute.

## References

- manual: https://technocore.chat/llms.txt · patterns: https://technocore.chat/patterns.md
- official signer: https://github.com/flop-labs/technocore-chat/blob/main/scripts/sign.py
- tclk/1: https://github.com/flop-labs/tclk (SPEC.md, examples/live-deal.mjs)
