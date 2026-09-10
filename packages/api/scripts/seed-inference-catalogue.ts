#!/usr/bin/env bun
/**
 * Idempotent seed: reserve the catalogue's publisher namespaces.
 *
 * ## What this seeds, and the much larger thing it deliberately does not
 *
 * It seeds PUBLISHERS and nothing else. Not models, not revisions, not
 * providers, not deployments, not routing profiles. That is not an unfinished
 * script — it is the answer to "which models can Oxy actually serve today?",
 * and the answer is that this repository does not know.
 *
 * Historical Alia product tiers never named models, so ADR 0008 retired them
 * as catalogue identities. Nothing here records which upstream weights
 * they resolve to, which providers Oxy holds contracts with, what any customer
 * price is, or whether any commercial review has happened.
 *
 * Every other catalogue object requires at least one fact of that kind:
 *
 * | object | the fact it cannot be seeded without |
 * |---|---|
 * | model | a capability sheet — `max_context_tokens`, `max_output_tokens`, modalities and a LICENCE, all NOT NULL |
 * | revision | a release date and, where Oxy hosts the weights, an artifact digest |
 * | provider | a data policy — retention, training on customer data, zero-retention availability — which is a statement about a third party's contractual behaviour |
 * | deployment | an availability scope AND a commercial permission, i.e. an assertion that a contract/legal review happened |
 * | routing profile | at least one candidate, so it depends on models existing |
 *
 * A plausible invented value in a catalogue is worse than an absent one,
 * because downstream code trusts it: a wrong `retains_payloads` is enforced
 * against a customer's routing policy and silently answers the wrong way, and a
 * wrong licence is a claim Oxy makes on somebody else's behalf. So they are
 * absent, and the catalogue serves an empty list until real data lands. Default
 * deny is not only the column defaults; it is also this.
 *
 * ## Why publishers are different
 *
 * A publisher row is an IDENTITY fact: a slug and a display name. Seeding
 * `openai` asserts only that the namespace `openai/*` belongs to OpenAI, which
 * is what a namespace is for. The five below are exactly the five ADR 0008
 * names in its own concept table, so the source is inside this repository
 * rather than inside somebody's memory.
 *
 * `description` and `website_url` are left NULL for all five. Both are
 * optional, neither is verifiable from this repository, and a URL that quietly
 * goes stale in a catalogue is the same class of problem as an invented price.
 *
 * `alia` matters most: `inference_models_reserved_namespace_is_first_party`
 * names that slug, so the reservation is only meaningful once the row exists.
 *
 * ## Insert-only, on purpose
 *
 * A publisher's display name is editable by whoever curates the catalogue, so
 * this script ADDS namespaces it does not find and never touches one that is
 * already there. Re-running reports zero inserts once seeded, which is also the
 * check that it is idempotent.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/scripts/seed-inference-catalogue.ts
 *
 * Env:
 *   DATABASE_URL   required (injected by ECS from SSM)
 *   DRY_RUN=1|true plan only, no writes
 */

import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { inferencePublishers } from '../src/db/schema/inferencePublishers';
import { logger } from '../src/utils/logger';

interface SeedPublisher {
  readonly slug: string;
  readonly displayName: string;
}

/**
 * The five publishers ADR 0008 names in its concept table:
 *
 *   Publisher — who released the weights — anthropic, openai, meta, mistral, alia
 *
 * Nothing is added to that list here. A sixth namespace is a catalogue decision
 * somebody should make deliberately, in a change that says why.
 */
const PUBLISHERS: readonly SeedPublisher[] = [
  { slug: 'alia', displayName: 'Alia' },
  { slug: 'anthropic', displayName: 'Anthropic' },
  { slug: 'meta', displayName: 'Meta' },
  { slug: 'mistral', displayName: 'Mistral' },
  { slug: 'openai', displayName: 'OpenAI' },
];

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function seed(): Promise<void> {
  await connectPostgres();

  const existing = await getDb()
    .select({ slug: inferencePublishers.slug })
    .from(inferencePublishers)
    .where(
      inArray(
        inferencePublishers.slug,
        PUBLISHERS.map((publisher) => publisher.slug)
      )
    );

  const present = new Set(existing.map((row) => row.slug));
  const missing = PUBLISHERS.filter((publisher) => !present.has(publisher.slug));

  if (DRY_RUN) {
    logger.info('Inference catalogue seed (dry run)', {
      wouldInsert: missing.map((publisher) => publisher.slug),
      alreadyPresent: [...present],
    });
    await closePostgres();
    return;
  }

  if (missing.length === 0) {
    logger.info('Inference catalogue seed: every publisher namespace already reserved');
    await closePostgres();
    return;
  }

  // `onConflictDoNothing` rather than a read-then-write race: two concurrent
  // runs must not fail each other, and `returning` reports what THIS run
  // actually inserted rather than what it planned to.
  const inserted = await getDb()
    .insert(inferencePublishers)
    .values(missing.map((publisher) => ({ slug: publisher.slug, displayName: publisher.displayName })))
    .onConflictDoNothing({ target: inferencePublishers.slug })
    .returning({ slug: inferencePublishers.slug });

  logger.info('Inference catalogue publishers seeded', {
    inserted: inserted.map((row) => row.slug),
    insertedCount: inserted.length,
  });

  await closePostgres();
}

seed().catch(async (error: unknown) => {
  logger.error(
    'Inference catalogue seed failed',
    error instanceof Error ? error : new Error(String(error))
  );
  await closePostgres().catch(() => undefined);
  process.exit(1);
});
