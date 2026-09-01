/**
 * `topics` — the interest/category taxonomy. Ported from `models/Topic.ts`.
 *
 * ## The weighted text index
 *
 * Mongo declared one text index over four paths with weights
 * `{name: 10, displayName: 8, aliases: 5, description: 1}` and
 * `default_language: 'en'`. The Postgres port is a GENERATED `tsvector` built
 * from four `setweight` terms (A/B/C/D, highest first) plus a GIN index —
 * generated rather than application-maintained for the reason
 * `CONVENTIONS.md` gives: a hook is bypassable and a
 * `GENERATED ALWAYS ... STORED` column is not.
 *
 * **Call-site note, and it is load-bearing.** Postgres's DEFAULT rank weights
 * are `{D,C,B,A} = {0.1, 0.2, 0.4, 1.0}`, which orders the four fields the same
 * way Mongo did but does not reproduce its RATIOS. `TopicService.search` /
 * `.list` must therefore rank with the explicit array —
 * `ts_rank('{0.1, 0.5, 0.8, 1.0}', search_vector, query)` — which is Mongo's
 * `{1, 5, 8, 10}` normalized. Ranking with the default weights compiles, runs,
 * and quietly returns a different order.
 *
 * ## The alias term needed an IMMUTABLE `text[]` → `tsvector`
 *
 * `CONVENTIONS.md` warns that a generated expression must be IMMUTABLE and that
 * the obvious spellings are not. That trap has a third instance here, beyond the
 * two it lists:
 *
 * | Want | Rejected | Use |
 * |---|---|---|
 * | a `tsvector` over a `text[]` | `to_tsvector('english', array_to_string(x, ' '))` — `array_to_string` is STABLE | `to_tsvector('english', replace(array_to_tsvector(x)::text, '''', ' '))` |
 *
 * Measured against this Postgres, not reasoned: `array_to_string(anyarray, text)`
 * is `provolatile = 's'`, as are `x::text` and `to_jsonb(x)`, because each
 * depends on a polymorphic output function. `array_to_tsvector(text[])` is the
 * one IMMUTABLE route out of an array — but it emits each ELEMENT as a verbatim
 * lexeme, with no stemming and no case folding, so using it directly would build
 * a vector whose alias lexemes can never match a stemmed query term. That is the
 * failure mode `CONVENTIONS.md` names outright: a query that looks like it
 * covers a field while answering a narrower question.
 *
 * Rendering it back to text and re-tokenizing under the SAME `'english'`
 * configuration fixes that. `tsvector_out` quotes each lexeme, so the `replace`
 * strips the quoting it added — exactly the inverse-by-construction shape
 * `decode(replace(x, '\', '\\'), 'escape')` uses for the contact hashes. Verified
 * to produce the identical lexeme SET as `array_to_string` over multi-word,
 * hyphenated, accented, punctuation-bearing and empty inputs (positions differ,
 * because `array_to_tsvector` sorts; positions do not affect `@@` or
 * `setweight` ranking). `__tests__/socialGraph.test.ts` pins the equality.
 *
 * ## Everything else that did not travel verbatim
 *
 * - `description` defaulted to `''` in Mongoose. Absent is NULL here, as on
 *   `users`: `''` is a value, and every reader already treats blank and absent
 *   identically.
 * - `translations` is the codebase's ONLY `Map` of subdocuments. It is `jsonb`:
 *   the KEY space is open (arbitrary BCP-47 locale tags), nothing joins on a
 *   key, and there is no locale table to reference — so a child table would add
 *   a join to every read and enforce nothing. The CHECK below keeps it an object
 *   rather than a dumping ground.
 * - Mongo's standalone `{type}` and `{aliases}` indexes are dropped. `{type}` is
 *   fully served by `(is_active, type)` — both live readers (`getCategories`,
 *   `list`) filter `isActive` too — and nothing queries `aliases` by element;
 *   they exist only to be searched, which the GIN index above covers.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, tsvector, updatedAt } from '@oxyhq/db';

/** Where a topic sits in the taxonomy. Mongo's `TopicType`, unchanged. */
export const TOPIC_TYPES = ['category', 'topic', 'entity'] as const;

/** How a topic came to exist. Mongo's `TopicSource`, unchanged. */
export const TOPIC_SOURCES = ['seed', 'ai', 'manual', 'system'] as const;

/**
 * Mongo's `default_language: 'en'`. A LITERAL configuration, because the
 * one-argument `to_tsvector` reads `default_text_search_config` at runtime and
 * is therefore STABLE, which Postgres refuses in a generated column.
 */
const SEARCH_CONFIGURATION = 'english';

/** Renders a `const` tuple as a SQL `in (...)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * `to_tsvector` over a `text[]`, IMMUTABLE. See the header for why the obvious
 * spellings are not and why this one is an exact inverse rather than an
 * approximation.
 */
function arrayTsvector(column: string): string {
  return (
    `to_tsvector('${SEARCH_CONFIGURATION}', ` +
    `replace(array_to_tsvector(coalesce(${column}, '{}'::text[]))::text, '''', ' '))`
  );
}

/** `to_tsvector` over a nullable text column. */
function textTsvector(column: string): string {
  return `to_tsvector('${SEARCH_CONFIGURATION}', coalesce(${column}, ''))`;
}

/**
 * The four weighted terms, highest first.
 *
 * Column names are spelled in SQL because a generated expression is built before
 * the table object exists, so there are no drizzle columns to interpolate — the
 * same unavoidable exception `user_locations.search_vector` carries. The test
 * asserts each term actually contributes, so a name that drifts fails rather
 * than silently indexing nothing.
 */
const SEARCH_VECTOR_EXPRESSION = sql.raw(
  `setweight(${textTsvector('name')}, 'A') || ` +
    `setweight(${textTsvector('display_name')}, 'B') || ` +
    `setweight(${arrayTsvector('aliases')}, 'C') || ` +
    `setweight(${textTsvector('description')}, 'D')`
);

export const topics = pgTable(
  'topics',
  {
    id: generatedId(),
    /**
     * The canonical lookup key (`TopicService.findOrCreate` resolves on it).
     * Mongoose lower-cased and trimmed it on write; that is APPLICATION
     * behaviour with no Postgres counterpart, so the call-site port must keep
     * normalizing — the unique below compares the stored value as-is.
     */
    name: text().notNull(),
    /** URL handle (`getBySlug`). Same normalization note as `name`. */
    slug: text().notNull(),
    displayName: text().notNull(),
    /** Mongoose defaulted to `''`; absent is NULL. */
    description: text(),
    type: text({ enum: TOPIC_TYPES }).notNull(),
    source: text({ enum: TOPIC_SOURCES }).notNull(),
    /**
     * Synonyms. A scalar array with a real `[]` default — distinct from
     * `default: undefined`, which would be a nullable column with no default.
     */
    aliases: text().array().notNull().default([]),
    /**
     * Parent in the taxonomy tree; NULL means "top level".
     *
     * `SET NULL`, not `CASCADE`: removing a parent category must not silently
     * delete an entire subtree of topics that content is already labelled with.
     * Promoting the orphans to top level is the state NULL already means.
     */
    parentTopicId: text().references((): AnyPgColumn => topics.id, {
      onDelete: 'set null',
    }),
    icon: text(),
    image: text(),
    isActive: boolean().notNull().default(true),
    /** Locale tag → `{ displayName, description? }`. See the header. */
    translations: jsonb(),
    /** GENERATED — the replacement for Mongo's weighted text index. */
    searchVector: tsvector().generatedAlwaysAs(SEARCH_VECTOR_EXPRESSION),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('topics_name_key').on(t.name),
    unique('topics_slug_key').on(t.slug),

    // Mongo's `{isActive, type}` compound. It also subsumes Mongo's standalone
    // `{type}` index, since both live readers filter on `isActive` as well.
    index('topics_is_active_type_idx').on(t.isActive, t.type),
    // The child-side of the self-reference. Postgres does NOT index a foreign
    // key automatically, and without this every parent delete (and every
    // `SET NULL` cascade) scans the table.
    index('topics_parent_topic_id_idx')
      .on(t.parentTopicId)
      .where(sql`${t.parentTopicId} is not null`),
    index('topics_search_vector_idx').using('gin', t.searchVector),

    check('topics_type_check', sql`${t.type} in (${sql.raw(inList(TOPIC_TYPES))})`),
    check('topics_source_check', sql`${t.source} in (${sql.raw(inList(TOPIC_SOURCES))})`),
    // `jsonb` here is an associative array, not a free-for-all: a translations
    // value that is an array, a number or a string is a bug, and this is where
    // it stops.
    check(
      'topics_translations_object_check',
      sql`${t.translations} is null or jsonb_typeof(${t.translations}) = 'object'`
    ),
    // A topic cannot be its own parent. Deeper cycles are the application's
    // problem; the one-hop case is free to state and is the shape a bad write
    // actually produces.
    check('topics_parent_topic_id_not_self_check', sql`${t.parentTopicId} <> ${t.id}`),
  ]
);
