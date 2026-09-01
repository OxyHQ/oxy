# Oxy ID Verifiability — Transparency Log + FairCoin Anchor

**Date:** 2026-07-26
**Status:** Approved (decision); implementation phased, not yet started
**Owner question:** should Commons (identity + reputation) migrate to real blockchain technology — specifically, a Commons-owned chain connected to FairCoin so standing can earn rewards?
**Decision:** No Commons-owned chain. Add a transparency log over the existing per-subject hash chains, anchor its root in **FairCoin** (`OP_RETURN`, 32-byte root, nothing else), and pay reputation rewards in FairCoin to a user-declared, identity-derived address. Reputation stays computed off-chain.

## Why the question has this answer

A blockchain buys exactly one thing the current design lacks: **you don't have to trust the operator**. That guarantee comes from validators that are *not* the operator — not from the data structure. Oxy already has the data structure:

| Blockchain guarantee | What exists today | Evidence |
|---|---|---|
| Non-repudiable authorship | secp256k1-signed envelope v2, verified by the protocol engine | `packages/protocol/src/chain/verify.ts`, `engine.ts` |
| Tamper-evident history | per-subject hash chain, `recordId = sha256(signingInput)`, `prev` → previous record | `packages/protocol/src/envelope/recordId.ts`, `chain/types.ts` |
| No silent rewrite / no forks | continuity check `prev === head && seq === head.seq + 1`, plus a unique `(userId, seq)` index as the multi-writer backstop | `chain/continuity.ts`, `packages/api/src/models/SignedRecord.ts:116-119` |
| O(1) head, one row per user | `RepoHead { userId, subjectDid, seq, headRecordId, recordCount }` | `packages/api/src/models/RepoHead.ts` |
| Identity independent of any single key | `did:web` anchored on the account `_id`; keys are verification methods in `authMethods` | `packages/api/src/services/did.service.ts` |
| Credible exit / portability | self-hostable node replicates the user's own chain and is the source of truth for it | `packages/node`, `packages/protocol/src/node/` |
| Recovery from key loss | v2 slots + identity marker + backup/shared ladder + 12-word phrase | `packages/core/src/crypto/keyManager.ts` |

What is missing is **an external witness**: nothing today stops Oxy from serving two different histories to two parties (equivocation), or from quietly suppressing a record, and nothing proves *when* a record existed. That gap is closed by a transparency log plus an anchor — not by owning a chain.

### Why a Commons-owned chain is rejected

1. **Validators.** A chain whose nodes are all operated by Oxy provides zero additional guarantee over the current MongoDB. It is a slower, permanently-public database. Making it real requires recruiting independent operators who cannot be switched off and who stay for years — an organizational problem no amount of code solves. Note that even the "own chain" projects are not standalone: Humanity Protocol and World Chain are rollups that publish to Ethereum and inherit its validator set.
2. **Privacy — the disqualifying reason.** Commons' civic layer records who physically attested whom (`realLife.service.ts`) and who vouched for whose personhood (`personhood.service.ts`). On a public chain that is a permanent, correlatable graph of real-world human contact. This directly contradicts the standing owner mandate that no user IP or location may be persisted because the threat model is state-actor harassment of users (`docs/superpowers/specs/2026-07-14-no-ip-storage-design.md`). An IP is deletable; a chain entry is not.
3. **Erasure.** Immutability and the right to erasure cannot both hold for personal data. Profile records, credential contents, and revocations must remain deletable.
4. **Key loss.** On-chain, the key *is* the account. Oxy deliberately built the opposite: an account-anchored DID with rotatable verification methods and a recovery ladder, after the 2026-07-18 vault-wipe incident.
5. **Cost and UX.** Gas, wallets, confirmations and block latency inside an onboarding flow that is currently "Hello Human" plus biometrics.

### How web3 platforms actually do it (the pattern being adopted here)

| Platform | On-chain | Off-chain (the bulk) |
|---|---|---|
| Farcaster | `IdRegistry`, `KeyRegistry`, `StorageRegistry` rent, recovery address (Optimism) | every message: signed CRDT sets in hubs/Snapchain, verified against the on-chain key registry. Reputation entirely off-chain (Neynar, OpenRank) |
| Lens | profile/follow NFTs, publication pointers | content on IPFS/Arweave; had to migrate to its own L2 on cost |
| ENS | name registry + resolvers | reads via CCIP-Read gateways and L2 |
| EAS | schema + revocation registry, `timestamp`/`multiTimestamp` for batched roots | off-chain EIP-712 attestations stored anywhere |
| Human Passport | only the published score, as an EAS attestation | stamps are off-chain VCs; score computed off-chain |
| World ID / Humanity | Merkle root of the registered identity set; ZK membership + nullifier | biometric template never on-chain |
| Ceramic | anchored stream-tip roots to Ethereum, then dropped it on cost/latency | signed event streams (same shape as our chains) |
| Bluesky `did:plc` | nothing | a signed, publicly exportable operation log — "credible exit" instead of consensus |

Nobody computes a reputation score on-chain; graph algorithms are not affordable in gas. The universal split is: **minimal registry on-chain, signed data off-chain, derived scores off-chain, ZK for privacy.** Oxy already has the middle two.

Anti-patterns explicitly not copied: profile-as-NFT (Lens) makes identity **sellable**, fatal for civic identity; storage rent in ETH (Farcaster) puts a wallet in the onboarding path; and on-chain attestations of physical encounters publish the contact graph forever.

## Invariant: what may ever touch a public chain

Same standing as the no-IP rule. **This is not a default to be relaxed by a future change.**

**Permitted on-chain, exhaustively:**
- One 32-byte Merkle root per checkpoint period, plus a 4-byte magic and a 4-byte checkpoint index.
- Reward payment transactions (amount + destination address).

**Never on-chain, in any encoding, hashed or not:** DIDs, user ids, usernames/handles, record contents or types, the attestation/vouch/social graph, jury membership or votes, credential contents or identifiers, personhood evidence, biometric material, IP addresses or location, per-user counters, or the number of records any individual holds. A per-user datum in an `OP_RETURN` is a privacy regression even if it looks like a hash; treat any proposal to add "just one more field" as a design error.

**Known, accepted leak:** a reward payment is public and links a FairCoin address to a payout. Mitigations in phase 3.

## Phase 1 — Transparency log (no chain involved; prerequisite for everything else)

### Model

- **Leaf**, one per chained user, derived from the existing `RepoHead` row:
  `leaf = sha256("oxy.leaf.v1" ‖ subjectDid ‖ ":" ‖ seq ‖ ":" ‖ headRecordId)`
  Domain-separated (RFC 6962-style leaf/node prefixes) so a leaf hash can never be reinterpreted as an interior node.
- **Tree**: leaves ordered by `subjectDid` lexicographically so any third party can recompute the root from a snapshot deterministically. Interior nodes `sha256("oxy.node.v1" ‖ left ‖ right)`.
- **Checkpoint** (new Mongo collection, append-only, never mutated):
  `{ index, periodEnd, treeSize, root, prevCheckpointHash, oxySignature, anchor?: { network, txid, confirmations, anchoredAt } }`
  `prevCheckpointHash = sha256(canonicalize(previous checkpoint without its anchor))` — the checkpoint sequence is itself a hash chain, so checkpoint history cannot be rewritten after an anchor exists. Signed with the Oxy key (`OXY_PRIVATE_KEY`), the same provenance key used for custodial DID and export attestations.

### Public endpoints (unauthenticated, cacheable, no CSRF)

- `GET /transparency/checkpoints/latest` and `/transparency/checkpoints/:index` — the signed checkpoint.
- `GET /transparency/proof?subject=<did>&index=<n>` — inclusion proof (audit path) for that subject's leaf in that checkpoint, plus the leaf preimage components (`seq`, `headRecordId`).
- `GET /transparency/checkpoints?since=<index>` — the checkpoint chain, so a verifier can walk `prevCheckpointHash` links itself.

A subject DID is a public identifier already served by `GET /u/:userId/did.json`, so serving a proof for it reveals nothing new. The endpoints must not accept a filter that would enumerate the full leaf set for an unauthenticated caller (rate-limit prefix `rl:transparency:read:`).

### Where the code lives

The tree, leaf/node hashing, proof generation, proof *verification*, and the checkpoint signing bytes live in **`packages/protocol`** (`src/transparency/`), app-agnostic like the chain engine, reusing `sha256` and `canonicalize` from `src/envelope/`. oxy-api only supplies the leaf source (a `RepoHead` cursor) and the HTTP surface; Commons and `@oxyhq/node` import the verifier. Response shapes go in `@oxyhq/contracts` and, per the standing rule, **contracts publishes before any consumer**.

**Implemented** (`packages/protocol/src/transparency/`, 30 tests in `src/__tests__/transparency.test.ts`): `transparencyLeafHash`, `buildTransparencyTree`, `buildTransparencyTreeFromHeads`, `inclusionProof`, `verifyInclusionProof`, `EMPTY_TRANSPARENCY_ROOT`, `checkpointSigningInput`, `checkpointHash`, `signCheckpoint`, `verifyCheckpointSignature`. The tree follows RFC 6962 (Certificate Transparency) so it is independently reimplementable; leaf and interior hashes use distinct domain prefixes; `buildTransparencyTreeFromHeads` owns the canonical ordering (ascending `subjectDid`, UTF-16 code-unit order — never `localeCompare`, which is locale-dependent and would make two verifiers disagree on the root) and throws on a duplicate subject rather than committing to one of two heads.

### What this proves, and what it does not

Proves: at checkpoint *N*, Oxy committed to a specific head for a specific subject, and it published exactly one root for that period (verifiable once anchored). A client or node holding its own inclusion proofs across checkpoints detects any rollback, fork, or suppression of *its* chain, because a later checkpoint must show a head that extends the earlier one.

Does not prove, by itself: that no record was removed for a user who never checks. This is a state-snapshot tree, not a per-entry append-only log — the accepted trade-off for a tree with one leaf per user instead of one per record. Commons and `@oxyhq/node` therefore **persist their own latest proof** and re-verify on each new checkpoint; that turns the guarantee from "auditable in principle" into "audited continuously by every device". Upgrade path if ever needed: add a second, CT-style append-only log of `recordId`s with real consistency proofs.

### Witnesses (sub-phase, and the piece that makes equivocation undeniable)

Independent parties co-sign each checkpoint root and serve what they signed. Detection then requires no cooperation from Oxy: two roots for one period, signed by disjoint witness sets, is proof of misbehaviour. Candidates and their operating requirements are an open question below; the checkpoint schema carries `witnessSignatures[]` from day one so adding them is not a migration.

**Do not confuse this with the existing `NodeIngestWitness`** (`packages/api/src/models/NodeIngestWitness.ts`): that is *Oxy* counter-signing each record it ingests from a user's own node, so a later rewrite signed with a stolen user key cannot deny the original content. It is prior art for the same threat model from the opposite direction — it protects the user's history against the user's own key being stolen; the transparency log protects it against Oxy. The two are complementary and neither replaces the other. Name the new field/collection so the distinction is obvious in code (`checkpointWitnessSignatures`, not `witnesses`).

### Scheduling and failure behaviour

Reuse the existing fleet-safe job pattern rather than inventing one: BullMQ repeatable job with a stable scheduler id when `REDIS_URL` is set (exactly one schedule fleet-wide — the leader-gated effect), with an unref'd in-process interval fallback when it isn't. See `packages/api/src/queue/nodeIngest.queue.ts` (and its sibling `backgroundJobs.ts`) for the exact shape, including the `.unref?.()` requirement on any interval. There is no `LeaderElection` primitive in oxy-api; do not port one for this.

The real mutex is the **unique index on `Checkpoint.index`**: if two tasks ever compute the same period concurrently they will produce slightly different roots, and only one insert survives. The loser must abandon its root entirely and re-read the persisted checkpoint — it must never retry with its own recomputed root, and the anchoring step must always anchor the *persisted* root, never a locally computed one. **Two signed roots for one period is precisely the equivocation this system exists to detect**, so this is a correctness constraint, not a race-condition nicety.

If checkpoint computation fails, record writes are unaffected — the log falls behind and resumes; gaps in `index` are never allowed, so a missed period is computed late to keep the chain contiguous.

## Phase 2 — FairCoin anchor

FairCoin is used because it already exists, already has nodes outside Oxy, and accepts arbitrary data. Verified facts:

| Fact | Evidence |
|---|---|
| Bitcoin/PIVX-derived; PoW→PoS boundary at block 10000; masternodes | `~/FairCoinWorkspace/FairCoin/src/chainparams.cpp:338`, `src/activemasternode.cpp` |
| Mainnet port 46372, DNS seeds `seed1/seed2.fairco.in`, 2-minute target spacing | `chainparams.cpp:380`, `:389`, `:416` |
| Testnet port 46374, seeds `testnet-seed1/2.fairco.in` | `chainparams.cpp:468`, `:490` |
| `OP_RETURN` relayed and mined by default; carrier limit is **83 bytes of `scriptPubKey`** (so ≈80 bytes of payload after the `OP_RETURN` opcode and pushdata prefix), tunable via `-datacarriersize` | `src/script/standard.h:28` (`MAX_OP_RETURN_RELAY = 83`), `src/script/standard.cpp:198` (`scriptPubKey.size() > nMaxDatacarrierBytes`), `src/init.cpp:477-478`, `:880` |
| Published JSON-RPC client | `@fairco.in/rpc-client@^0.1.1` (`~/FairCoinWorkspace/Explorer/package.json:21`) |
| Raw-tx build/sign/broadcast without importing a wallet key into the node | `~/FairCoinWorkspace/Explorer/server/mcp/wallet-tools.ts` (`createrawtransaction` → `signrawtransaction` with a WIF → `sendrawtransaction`) |
| UTXO read path requires `addressindex=1` on the node | `wallet-tools.ts:145-158` (`getaddressutxos`, with an explicit error when the index is off) |

### Payload

`OXY1` (4 bytes, ASCII) ‖ `uint32be(checkpoint.index)` ‖ `root` (32 bytes) = **40 bytes of payload**, i.e. 42–43 bytes of `scriptPubKey` including the opcode and pushdata — half the 83-byte policy ceiling, so no node needs a non-default `-datacarriersize`. No length-prefix games and no versioning inside the root: a new format gets a new magic (`OXY2`).

### Operation

- **Cadence:** proposal every 6 hours (4 transactions/day). Cost is negligible at FairCoin fee levels; the cadence bounds how long an equivocation can go unanchored, so it is a security parameter, not a cost parameter.
- **Idempotence is a security property.** A checkpoint index maps to exactly one root and at most one anchoring attempt in flight. Retries must rebroadcast the *same* payload; the job must never compute a second root for an index that was already published. Store `txid` on the checkpoint on broadcast and reconcile confirmations on a later pass.
- **Anchor wallet:** a dedicated key, held in SSM (`/oxy/oxy-api/FAIRCOIN_ANCHOR_WIF`), completely separate from the identity vault and from any user funds. It signs only anchor transactions. Needs monitoring for balance and a documented top-up procedure; a failed anchor degrades to "checkpoint published, not yet anchored" and never blocks record writes.
- **Node access:** an Oxy-reachable `faircoind` with `-datacarrier=1` (default) and `addressindex=1` (required by the UTXO read path above), or a small hosted RPC endpoint. Confirm before committing to this phase.
- **User-facing verification:** the checkpoint exposes its `txid`, and the FairCoin Explorer already renders transactions — "check it yourself on the blockchain" needs no new infrastructure. Optionally the Explorer grows an "Oxy checkpoint" view that decodes the `OXY1` payload.

### Authorized FairCoin-side changes

The owner has authorized improving FairCoin where needed. Minimum required:

1. Extend the raw-tx path in `~/FairCoinWorkspace/Explorer/server/mcp/wallet-tools.ts` to build a `data` (`OP_RETURN`) output alongside the change output, and type it in `@fairco.in/rpc-client`. This is the only functional gap — the daemon already supports it.
2. Verify `-datacarrier`/`-datacarriersize` on whichever node Oxy uses, and that a 40-byte `OP_RETURN` relays and confirms on mainnet (test on testnet first).

Nothing in the FairCoin consensus code needs to change.

### Bitcoin/OpenTimestamps as an additional anchor

If the census of independent FairCoin nodes turns out to be thin, an additional OpenTimestamps anchor (free, batched, on Bitcoin) gives a much larger independent validator set for the timestamp claim. It is additive — same root, second witness — and is decided by the census, not by preference. The checkpoint's `anchor` field is therefore an array-capable shape from the start.

## Phase 3 — Reputation rewards in FairCoin

### What stays off-chain

The reputation ledger and every derived score (`reputation.service.ts`, `ReputationTransaction`/`ReputationBalance`). No web3 platform computes this on-chain, and the trust-tier/influence math is a graph aggregate. What goes on-chain is **only the payment**.

### Destination address

`KeyManager.deriveScopedSeed('oxypay/faircoin/v1')` (`packages/core/src/crypto/keyManager.ts:2624`) already derives a domain-separated 32-byte seed from the on-device identity key via HKDF, without exposing the private key, and reproducible from the user's 12-word phrase. So a user's FairCoin wallet is already a function of their Oxy ID and survives device loss.

The server **cannot** derive that address (the input key never leaves the device). Therefore the client publishes it: a signed record on the user's own chain, collection `app.oxy.payout`, `rkey` `faircoin`, containing the address (and the HD derivation index used). This is the right shape — no wallet-linking UI, no server-side key custody, the declaration is self-signed and auditable, and it goes through the existing `verifyAndStoreRecord` path with no new trust assumption. A payout with no such record is simply not paid.

### Payment path

Oxy publishes an Oxy-signed reward record (reusing the existing `emitAttestation` mechanism that already writes `reputation_attestation` records onto the earner's chain — `reputation.service.ts:274`, called from `realLife.service.ts:228`, `validator.service.ts:432`, `personhood.service.ts:354`), then pays the declared address. Because the reward record lands in a chain whose head gets anchored, the payout is auditable against the anchored checkpoint: the promise is timestamped, and the payment is on a public chain.

### Hard rules

- **Verification is never purchasable and never conditional on money.** Rewards recognise *service* — correct jury votes, valid real-life attestations — never status, and never "pay to be verified". A design where funds influence personhood is rejected outright.
- Payouts are **opt-in**: no `app.oxy.payout` record, no payment, no on-chain footprint.
- **Privacy disclosure, in the UI, before opt-in:** a payout is public and permanently links that FairCoin address to reward activity, and the address is declared in a public signed record — so opting in links an Oxy identity to on-chain economic activity. Mitigations: a fresh derived address per payout (index declared in the record), and one transaction per payout rather than batching many recipients into one transaction (a batched transaction publicly links every co-recipient). Batching is a privacy regression, not an optimisation.

### Explicitly out of scope here

Economic staking/slashing for validators (FairCoin at risk when a juror votes badly). It is coherent with the existing `vouch_slashed` mechanics, but it is a separate decision requiring: a custody model for stake, a dispute path that cannot be gamed by whoever holds more coin, and an answer to "does staking price ordinary users out of jury service". Revisit only after phase 1 is in production.

## Phase 4 — web3 interoperability (optional, later)

Designed but not committed: export records as EAS-compatible off-chain attestations (EIP-712); add `did:pkh` as an additional verification method on the existing `did:web` so an Ethereum address can be bound to the same account; selective disclosure (SD-JWT / BBS+) so a user can prove personhood or a standing threshold to an external verifier without revealing the underlying graph. All of it is additive to the off-chain core and none of it requires a chain of our own.

## Rollout order

1. ✅ **Done** — `@oxyhq/protocol` transparency tree, proof verifier, and co-signable checkpoint primitives (`src/transparency/`, 30 tests).
2. ✅ **Done** — `@oxyhq/contracts` `src/transparency.ts` (checkpoint / signature / anchor / inclusion-proof schemas, 15 tests) and oxy-api: `TransparencyCheckpoint` model, `transparency.service.ts`, the four public read endpoints (`routes/transparency.ts`, 15 tests), and the 6-hourly publish job (`queue/transparencyCheckpoint.queue.ts`, BullMQ + unref'd interval fallback), mounted in `server.ts` outside the CSRF group. **Both packages are unpublished** — `@oxyhq/contracts` and `@oxyhq/protocol` need a version bump + publish (contracts FIRST) before an external consumer (Commons, `@oxyhq/node`) can import these from `dist/`; oxy-api builds them from the workspace.
3. Client-side continuous verification: Commons and `@oxyhq/node` persist their own latest proof and re-verify against each new checkpoint. This is what turns "auditable in principle" into "audited by every device".
4. FairCoin `data`-output support + testnet smoke test. Done when a 40-byte `OP_RETURN` is broadcast and read back by RPC on testnet, then mainnet.
5. Anchoring job + `anchor` reconciliation + the "anchored on FairCoin" surface in Commons. Done when a user can see their own head anchored in a FairCoin transaction and the client detects a tampered proof.
6. Witnesses — user-run `@oxyhq/node` deployments co-signing checkpoints.
7. Payout records + payments (independent of 6, and gated on the anti-sybil review above).

Steps 1–5 are additive and reversible: removing the checkpoint job and endpoints leaves the record chains untouched. Step 7 is not reversible in the sense that published payments are permanent — which is why the disclosure and opt-in are part of the design, not follow-ups.

## Open questions

1. Checkpoint cadence (proposal: 6h) and whether the anchor cadence should differ from the checkpoint cadence.
2. Who the witnesses are, and what they must run.
3. **Census of FairCoin nodes/masternodes not operated by Oxy.** This determines how much the anchor is worth and whether OpenTimestamps is also required.
4. Source and rate of reward emission (treasury? fee share?), and the cap that keeps it sustainable.
5. Whether the FairCoin Explorer hosts an "Oxy checkpoint" decoder view.
6. Whether the anchor uses an Oxy-operated `faircoind` (needs `addressindex=1`) or a hosted RPC.

## Testing

1. **Protocol unit tests** (`packages/protocol`): leaf/node domain separation, deterministic root over a fixed sorted leaf set, inclusion proof round-trip, and negative cases — a mutated `headRecordId`, a mutated `seq`, a leaf moved to a different index, and a proof from a different checkpoint must all fail verification.
2. **Read-only production dry run:** count `RepoHead` rows and compute a root from a snapshot in a read-only script, to size the tree and the job's runtime. No writes.
3. **Testnet anchor smoke test** before committing to phase 2: run `faircoind` on testnet (port 46374, seeds `testnet-seed1/2.fairco.in`), build a 40-byte `OP_RETURN` transaction through the raw-tx path, broadcast it, and read it back via RPC. If this fails, phase 2 changes shape and this document must be revised.
4. **Red-team scenarios, each of which must be detected:** (a) Oxy alters a stored record — the client's next inclusion proof mismatches its retained head; (b) Oxy hides a record — the anchored head fails to extend the previously anchored head; (c) Oxy publishes two roots for one period — the unique index blocks it, and if it happened anyway only one is anchored, and the witnesses hold the other; (d) Oxy rewrites checkpoint history — `prevCheckpointHash` breaks against an already-anchored root. If any scenario is undetectable, the design is wrong.
5. **Owner review** of the on-chain privacy invariant and of the "verification is never purchasable" rule.
