# ADR 0060 — A universal topic catalog and relatedness across Oxy products

- Status: Accepted for the contract (decisions 1–7 below); the open decisions gate their own rollout phases
- Date: 2026-11-05
- Decided by: the owner of Oxy

## Context

Oxy already has a topic table (`topics`, with `type`, `source`, `isActive`, `parentTopicId`, `translations`) and a follow kind for interests (`oxy.topic`). Products do not share the catalog in practice:

- Mention reads categories from Oxy, but production has no categories loaded, so `GET /topics` returns an empty list for every type. Mention's trending pipeline keeps its own concept registry (four hand-written entries) and clusters terms by co-occurrence per batch without persisting the groups. `trending.conceptId` already declares that its key belongs to "the shared Oxy topic vocabulary".
- Alia stores episode topics as free text. Syra references a `Topic` model that does not exist.
- Hashtags are author-written strings (`posts.hashtags`, `post_hashtags`). They are not topics.

## Decision

1. **One catalog, owned by Oxy.** The `topics` table is the only canonical topic vocabulary. Every product resolves its own labels to Oxy topic IDs through the SDK. No product keeps a second topic registry.
2. **Topics are created automatically.** Classification and trend clustering create topics with `source` set to `ai` or `system`. No product creates topics by hand. Manual edits change metadata (display name, translations, icon), never the existence of a topic.
3. **Hashtags stay separate.** A hashtag is an input that resolves to a topic through an alias row. It is never stored as a topic and never removed from `post_hashtags`.
4. **Relatedness is a derived, versioned table.** Oxy stores the top-K related topics per topic with a score, the co-occurrence count and the computed-at batch. The score is a Beta posterior over co-occurrence, not a raw ratio, and a pair is scored by the weaker of its two directions:
   - `P(B | A) = (co + α) / (volume(A) + α + β)`, with the default prior α = 0.5, β = 49.5 (mean 0.01, weight about 50 items).
   - `score(A, B) = min(P(B | A), P(A | B))`.
   - A pair qualifies only with at least `minCooccurrence` shared items (default 3). Each topic keeps at most K relations (default 20), ordered by score and then by topic ID. Relations are never guessed: no evidence, no relation.
   - The reference implementation is `packages/backend/src/services/topics/relatedness.ts` in Mention (OxyHQ/Mention#1880), pure and tested. Oxy adopts the same module so every product gets the same numbers.
5. **Contributions are observations, not writes to the table.** An app reports a set of topic IDs that co-occur in one item (a post, an episode, a room, a listing) with a source identifier. Oxy:
   - caps each item at 8 topics (at most 28 pairs per item), keeping the heaviest;
   - weights each source so one high-volume product cannot dominate a relation;
   - recomputes relations in batches, never per request, and never calls a model in the path.
6. **Follows contribute only in aggregate.** A follow pair counts when at least N distinct users (N = 20 to start) follow both topics. Only the counts leave the follow store; no product receives a per-user topic list.
7. **Cost rules.** No new infrastructure: Postgres tables and the existing batch scheduler. Counters are maintained incrementally and written in bulk, never one query per pair. Relation reads are one indexed query per topic, cacheable. Migrations are phased so that Mention's trending behaviour does not change until each phase is verified.

## Consequences

- `trending.conceptId` points at Oxy topic IDs. The four hand-written concepts become topics with their labels and aliases.
- The trending clusters (for example Democrats and Dems) become topics with learned aliases, which is the source of automatic categories if they are chosen (see open decisions).
- Products get relations from one endpoint and one contract, and their own content feeds the same counts.
- Relation quality is testable: the algorithm is pure, and a reference set of pairs (for example Donald Trump with White House, high; Donald Trump with petroleum, low) gates each change.

## Open decisions

1. **Where do categories come from?** Options: a fixed editorial taxonomy in Oxy, categories derived from clusters of topics, or no categories and popular topics instead. This ADR does not choose.
2. **Reference pairs.** Who curates the set that gates the relatedness tests.
3. **Historical import.** Whether existing trending terms and hashtags are imported as candidates in phases, and who grants read access for the counts.
4. **Source weights.** The initial weight for each product.

## Rollout

1. Oxy: contract and tables for observations and relations; no consumer yet.
2. Mention: write observations from classified posts and hashtags; read relations behind a flag.
3. Mention trending: resolve `conceptId` through the catalog; keep the current output as a comparison until the numbers match.
4. Other products: adopt the observation contract one by one, starting with those that already label content with topics (Alia, Syra).
