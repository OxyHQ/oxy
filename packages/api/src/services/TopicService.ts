/**
 * Topic taxonomy service.
 *
 * ## The text search is the part that had to be ported rather than translated
 *
 * Mongo ran `$text: { $search: q }` against a WEIGHTED text index
 * (`{name: 10, displayName: 8, aliases: 5, description: 1}`) and sorted by
 * `{ $meta: 'textScore' }`. Two properties of that had to survive, and neither
 * is what the obvious Postgres spelling gives you:
 *
 * 1. **The weights.** `ts_rank`'s DEFAULT weight array is `{0.1, 0.2, 0.4, 1.0}`,
 *    which orders the four fields the same way but does not reproduce Mongo's
 *    RATIOS. {@link SEARCH_RANK_WEIGHTS} is Mongo's `{1, 5, 8, 10}` normalized,
 *    passed explicitly — see the note in `db/schema/topics.ts`, which says
 *    outright that ranking with the defaults compiles, runs, and quietly
 *    returns a different order.
 * 2. **OR semantics.** Mongo's `$text` treats a multi-word search as OR over
 *    its terms. `plainto_tsquery` / `websearch_to_tsquery` both build AND, so
 *    using either directly would make a two-word query answer a strictly
 *    NARROWER question than it does today while looking correct.
 *    {@link searchTsQuery} therefore lets `plainto_tsquery` do the parsing,
 *    stemming and stop-word removal and then rewrites its `&` connectives to
 *    `|`. That rewrite is exact rather than approximate: `plainto_tsquery`
 *    emits nothing but quoted lexemes joined by `&`, and `&` cannot appear
 *    inside a lexeme because the parser drops it as a non-word character.
 *
 * A stop-words-only query produces the empty tsquery, which `@@` never matches
 * — the same empty result Mongo gave.
 *
 * ## Normalization is re-applied HERE
 *
 * `trim: true` / `lowercase: true` were Mongoose APPLICATION behaviour with no
 * Postgres counterpart (`schema/CONVENTIONS.md`), and `topics.name` / `.slug`
 * are compared as stored. {@link TopicService.findOrCreate} is the only writer
 * of either, so it is the one place that must keep normalizing.
 */

import { and, asc, countDistinct, eq, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import type { SelectedRow } from '@oxyhq/db';
import { topics, TOPIC_SOURCES, TOPIC_TYPES } from '../db/schema/topics';

/** The `topics.type` closed value set, derived from the column itself. */
export type TopicType = (typeof TOPIC_TYPES)[number];
/** The `topics.source` closed value set, derived from the column itself. */
export type TopicSource = (typeof TOPIC_SOURCES)[number];

/** A locale's overlay for {@link TopicService.localizeTopics}. */
export interface TopicTranslation {
  displayName: string;
  description?: string;
}

/**
 * A topic as every `/topics` response serialises it.
 *
 * `_id` rather than `id`, and no `id` alongside it, because the routes served
 * `.lean()` documents: `.lean()` bypasses the model's `toJSON` transform, so
 * the wire has always carried `_id` and never the `id` virtual. Preserved
 * verbatim — the apps consuming `/topics` are not being rebuilt for this port.
 *
 * `__v` is the one field deliberately dropped: it is forbidden by the migration
 * contract, it was always `0`, and it carries no information a client can act
 * on.
 */
export interface TopicRecord {
  _id: string;
  name: string;
  slug: string;
  displayName: string;
  description: string;
  type: TopicType;
  source: TopicSource;
  aliases: string[];
  parentTopicId?: string;
  icon?: string;
  image?: string;
  isActive: boolean;
  translations?: Record<string, TopicTranslation>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Mongo's `{name: 10, displayName: 8, aliases: 5, description: 1}` normalized,
 * ordered `{D, C, B, A}` as `ts_rank` requires — so `A` (weight 1.0) is `name`,
 * matching the `setweight` order the generated `search_vector` is built with.
 */
const SEARCH_RANK_WEIGHTS = '{0.1, 0.5, 0.8, 1.0}';

/** Mongo's `default_language: 'en'`, spelled as a LITERAL configuration. */
const SEARCH_CONFIGURATION = 'english';

/** Every column a `/topics` response reads. */
const TOPIC_COLUMNS = {
  id: topics.id,
  name: topics.name,
  slug: topics.slug,
  displayName: topics.displayName,
  description: topics.description,
  type: topics.type,
  source: topics.source,
  aliases: topics.aliases,
  parentTopicId: topics.parentTopicId,
  icon: topics.icon,
  image: topics.image,
  isActive: topics.isActive,
  translations: topics.translations,
  createdAt: topics.createdAt,
  updatedAt: topics.updatedAt,
} as const;

type TopicRow = SelectedRow<typeof TOPIC_COLUMNS>;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * `translations` is `jsonb`, so it arrives as a plain object or NULL — never
 * the Mongoose `Map` the old reader also had to handle. A value that is not an
 * object is rejected by `topics_translations_object_check` at write time, so
 * the only shapes reachable here are "object" and "absent".
 */
function toTranslations(value: unknown): Record<string, TopicTranslation> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, TopicTranslation>;
}

/**
 * Row → wire document.
 *
 * NULL becomes ABSENT for the four optionals, matching a Mongo document that
 * simply had no such key — a client that iterates keys, or spreads the object,
 * must not start seeing `icon: null` where it saw nothing.
 *
 * `description` is the one exception and it is deliberate: Mongoose defaulted
 * it to `''` and therefore always emitted a string, so a NULL is coalesced back
 * rather than dropped. Dropping it would break `topic.description.length` at
 * every caller.
 */
function toTopicRecord(row: TopicRow): TopicRecord {
  return {
    _id: row.id,
    name: row.name,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description ?? '',
    type: row.type,
    source: row.source,
    aliases: row.aliases,
    ...(row.parentTopicId !== null ? { parentTopicId: row.parentTopicId } : {}),
    ...(row.icon !== null ? { icon: row.icon } : {}),
    ...(row.image !== null ? { image: row.image } : {}),
    isActive: row.isActive,
    ...(toTranslations(row.translations) ? { translations: toTranslations(row.translations) } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The OR-semantics tsquery for a user-supplied search string. See the header
 * for why the connective is rewritten rather than the query hand-built.
 */
function searchTsQuery(query: string): SQL<unknown> {
  return sql`replace(plainto_tsquery(${SEARCH_CONFIGURATION}, ${query})::text, '&', '|')::tsquery`;
}

/** Mongo's `{ $meta: 'textScore' }`, with Mongo's weights. */
function searchRank(query: string): SQL<number> {
  return sql<number>`ts_rank(${sql.raw(`'${SEARCH_RANK_WEIGHTS}'::float4[]`)}, ${topics.searchVector}, ${searchTsQuery(query)})`;
}

interface ListOptions {
  type?: TopicType;
  query?: string;
  limit?: number;
  offset?: number;
}

class TopicService {
  /**
   * Atomic upsert — find by lowercase name or create a new topic.
   *
   * `on conflict do nothing` is the exact analogue of Mongoose's
   * `$setOnInsert`: an existing row is left untouched, including its
   * `updated_at`. The follow-up read is not a race — under READ COMMITTED,
   * `do nothing` waits for a concurrent inserter to commit before deciding, so
   * by the time it returns empty the winning row is visible to the next
   * statement.
   */
  async findOrCreate(
    name: string,
    type: TopicType,
    source: TopicSource,
    displayName?: string
  ): Promise<TopicRecord> {
    const normalizedName = name.toLowerCase().trim();
    const display = displayName ?? name.charAt(0).toUpperCase() + name.slice(1);
    const slug = slugify(normalizedName);
    const db = getDb();

    const [inserted] = await db
      .insert(topics)
      .values({
        name: normalizedName,
        slug,
        displayName: display,
        type,
        source,
        // Mongoose defaulted this to `''`. NULL is the column's "absent", and
        // `toTopicRecord` coalesces it back to `''` on the way out, so the wire
        // is unchanged while the two states cannot both exist in storage.
        description: null,
        aliases: [],
        isActive: true,
      })
      .onConflictDoNothing({ target: topics.name })
      .returning(TOPIC_COLUMNS);

    if (inserted) {
      return toTopicRecord(inserted);
    }

    const [existing] = await db
      .select(TOPIC_COLUMNS)
      .from(topics)
      .where(eq(topics.name, normalizedName))
      .limit(1);
    if (!existing) {
      throw new Error(`Topic "${normalizedName}" could not be created or resolved`);
    }
    return toTopicRecord(existing);
  }

  /**
   * Batch resolve/create topics. Deduplicates input names and returns a
   * Map keyed by the original (lowercased) name.
   */
  async resolveNames(
    names: Array<{ name: string; type: TopicType }>,
    source: TopicSource = 'ai'
  ): Promise<Map<string, TopicRecord>> {
    // Deduplicate by lowercase name
    const unique = new Map<string, TopicType>();
    for (const entry of names) {
      const key = entry.name.toLowerCase().trim();
      if (key && !unique.has(key)) {
        unique.set(key, entry.type);
      }
    }

    const result = new Map<string, TopicRecord>();

    // Run upserts in parallel
    const promises = Array.from(unique.entries()).map(async ([name, type]) => {
      const topic = await this.findOrCreate(name, type, source);
      result.set(name, topic);
    });

    await Promise.all(promises);
    return result;
  }

  /**
   * Full-text search across name, displayName, aliases, and description.
   */
  async search(query: string, limit = 20): Promise<TopicRecord[]> {
    if (!query || !query.trim()) return [];

    const rows = await getDb()
      .select(TOPIC_COLUMNS)
      .from(topics)
      .where(and(eq(topics.isActive, true), sql`${topics.searchVector} @@ ${searchTsQuery(query)}`))
      .orderBy(sql`${searchRank(query)} desc`)
      .limit(limit);

    return rows.map(toTopicRecord);
  }

  /**
   * All active category topics sorted alphabetically by displayName.
   */
  async getCategories(): Promise<TopicRecord[]> {
    const rows = await getDb()
      .select(TOPIC_COLUMNS)
      .from(topics)
      .where(and(eq(topics.type, 'category'), eq(topics.isActive, true)))
      .orderBy(asc(topics.displayName));

    return rows.map(toTopicRecord);
  }

  /**
   * Paginated topic list with optional type filter and text search.
   */
  async list(options: ListOptions = {}): Promise<{ topics: TopicRecord[]; total: number }> {
    const { type, query, limit = 50, offset = 0 } = options;
    const hasQuery = Boolean(query && query.trim());

    const filters: SQL[] = [eq(topics.isActive, true)];
    if (type) filters.push(eq(topics.type, type));
    if (hasQuery && query) {
      filters.push(sql`${topics.searchVector} @@ ${searchTsQuery(query)}`);
    }
    const where = and(...filters);

    const db = getDb();
    // Two statements, exactly as the Mongo `Promise.all([find, countDocuments])`
    // was — `total` is the size of the whole filtered set, not of the page.
    const [rows, [counted]] = await Promise.all([
      hasQuery && query
        ? db
            .select(TOPIC_COLUMNS)
            .from(topics)
            .where(where)
            .orderBy(sql`${searchRank(query)} desc`)
            .offset(offset)
            .limit(limit)
        : db
            .select(TOPIC_COLUMNS)
            .from(topics)
            .where(where)
            .orderBy(asc(topics.displayName))
            .offset(offset)
            .limit(limit),
      db.select({ total: countDistinct(topics.id) }).from(topics).where(where),
    ]);

    return { topics: rows.map(toTopicRecord), total: counted?.total ?? 0 };
  }

  /**
   * Retrieve a single topic by its slug.
   */
  async getBySlug(slug: string): Promise<TopicRecord | null> {
    const [row] = await getDb()
      .select(TOPIC_COLUMNS)
      .from(topics)
      .where(and(eq(topics.slug, slug), eq(topics.isActive, true)))
      .limit(1);
    return row ? toTopicRecord(row) : null;
  }

  /**
   * Update the editable metadata of a topic, addressed by slug.
   *
   * Lives here rather than in the route so the `topics` table has ONE writer
   * module: the route used to reach past this service into the Mongoose model
   * directly, which is how it ended up holding the last `.lean()` on a table
   * this file already owned.
   *
   * The caller supplies an explicit whitelist of columns; there is no spread of
   * a request body anywhere on this path.
   */
  async updateBySlug(
    slug: string,
    update: Partial<Pick<
      typeof topics.$inferInsert,
      'description' | 'translations' | 'icon' | 'image' | 'aliases' | 'displayName'
    >>
  ): Promise<TopicRecord | null> {
    const [row] = await getDb()
      .update(topics)
      .set(update)
      .where(and(eq(topics.slug, slug), eq(topics.isActive, true)))
      .returning(TOPIC_COLUMNS);
    return row ? toTopicRecord(row) : null;
  }

  /**
   * Overlay translations for a given locale onto the displayName and
   * description fields. Returns new objects — does not mutate the input.
   */
  localizeTopics(records: TopicRecord[], locale: string): TopicRecord[] {
    if (!locale) return records;

    return records.map((topic) => {
      const translation = topic.translations?.[locale];
      if (!translation) return topic;

      return {
        ...topic,
        displayName: translation.displayName ?? topic.displayName,
        description: translation.description ?? topic.description,
      };
    });
  }
}

export const topicService = new TopicService();
export default topicService;
