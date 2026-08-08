/**
 * The social-graph and moderation batch, against a REAL Postgres.
 *
 * Thirteen tables landed here: the follow graph, restrictions, notifications,
 * topics, the four moderation/conduct tables plus two policy child tables, the
 * two reputation profiles, per-period analytics and the generic app-data store.
 * Every assertion below goes through the application's own pool against the
 * throwaway database `jest.globalSetup.ts` migrated — there is no mock and no
 * second migrator, so what passes is what the shipped DDL actually does.
 *
 * One `describe` per decision that could be reversed without anything else
 * noticing. Each has been mutation-tested: break the constraint it guards and it
 * goes red naming the offending table and column.
 *
 * The whole run shares one database, so every row here carries a per-test random
 * owner id — no assertion depends on a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { APP_DATA_IDENTIFIER_PATTERN } from '../userAppData';
import { applications } from '../applications';
import { conductStrikes } from '../conductStrikes';
import { identityBindings } from '../identityBindings';
import { moderationEffects } from '../moderationEffects';
import { moderationPolicies } from '../moderationPolicies';
import { moderationPolicySeverityRules } from '../moderationPolicySeverityRules';
import { moderationPolicyStandingThresholds } from '../moderationPolicyStandingThresholds';
import { notifications } from '../notifications';
import { reporterReputationProfiles } from '../reporterReputationProfiles';
import { reputationTransactions } from '../reputationTransactions';
import { restrictions } from '../restrictions';
import { reviewerReputationProfiles } from '../reviewerReputationProfiles';
import { topics } from '../topics';
import { userAnalytics } from '../userAnalytics';
import { APP_DATA_IDENTIFIER_SQL_PATTERN, userAppData } from '../userAppData';
import { userFollows } from '../userFollows';
import { users } from '../users';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/**
 * Mongo's rank weights `{name: 10, displayName: 8, aliases: 5, description: 1}`,
 * normalized and ordered `{D, C, B, A}` as `ts_rank` expects. Postgres's DEFAULT
 * weights order the four fields the same way but do not reproduce these ratios,
 * which is exactly why the call-site port must pass this array explicitly.
 */
const MONGO_RANK_WEIGHTS = '{0.1, 0.5, 0.8, 1.0}';

const uniqueId = () => randomUUID().replace(/-/g, '');

/** The SQLSTATE a driver error carries, walking drizzle's wrapper chain. */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The driver message, so an assertion can prove WHICH constraint fired. */
function pgErrorMessage(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  return messages.join(' | ');
}

/**
 * Await a query, expecting it to reject, and return the error.
 *
 * Awaiting a drizzle query builder twice RUNS it twice, so `expect(q).rejects`
 * followed by `q.catch(...)` would issue two statements — this runs exactly one.
 */
async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

/** A real `users` row — every `user_id` in this file carries a foreign key. */
async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/**
 * A real `applications` row.
 *
 * `identity_bindings.application_id`, `moderation_effects.application_id` and
 * `conduct_strikes.application_id` each took a fabricated string until
 * `applications` landed; all three now carry the foreign key the deferred-FK
 * ledger had already decided on, and that is the point of the constraint.
 */
async function application(): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${uniqueId()}`, ownerAccountId: await account() })
    .returning({ id: applications.id });
  return row.id;
}

/**
 * A real `identity_bindings` row. `moderation_effects.binding_id` carries a
 * foreign key with `ON DELETE RESTRICT`: the binding is what PROVED the identity
 * an effect landed on, so a synthetic id no longer satisfies it.
 */
async function binding(userId: string): Promise<string> {
  const [row] = await getDb()
    .insert(identityBindings)
    .values({
      applicationId: await application(),
      userId,
      localPrincipalId: `principal-${uniqueId()}`,
      bindingType: 'oauth_grant',
    })
    .returning({ id: identityBindings.id });
  return row.id;
}

/**
 * A real `reputation_transactions` row. `conduct_strikes.transaction_id` and
 * `moderation_effects.transaction_id` carry foreign keys with
 * `ON DELETE RESTRICT`: the ledger entry is where the points actually moved, so
 * a synthetic id no longer satisfies it. Owned by the same account as the
 * consequence, which is what the erasure cascade assumes.
 */
async function ledgerEntry(userId: string): Promise<string> {
  const [row] = await getDb()
    .insert(reputationTransactions)
    .values({ userId, points: -20, actionType: 'conduct_penalty', category: 'penalty' })
    .returning({ id: reputationTransactions.id });
  return row.id;
}

/** A policy version both consequence tables can reference. */
async function policy(): Promise<{ id: string; version: string }> {
  const version = `oxy.test.${uniqueId()}`;
  const [row] = await getDb()
    .insert(moderationPolicies)
    .values({
      policyVersion: version,
      conductFamilies: ['spam'],
      repetitionMultipliers: [1, 1.5, 2],
      repetitionWindowDays: 90,
      multiFindingSecondaryShare: 0.25,
      multiFindingCap: 2,
    })
    .returning({ id: moderationPolicies.id });
  return { id: row.id, version };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('user_follows — one typed table, both sides constrained', () => {
  it('stores an edge and refuses the same one twice', async () => {
    const follower = await account();
    const followed = await account();
    await getDb().insert(userFollows).values({ followerId: follower, followedId: followed });

    const error = await rejection(
      getDb().insert(userFollows).values({ followerId: follower, followedId: followed })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorMessage(error)).toContain('user_follows_follower_id_followed_id_key');
  });

  it('treats the reverse direction as a different edge', async () => {
    const a = await account();
    const b = await account();
    await getDb().insert(userFollows).values({ followerId: a, followedId: b });
    await expect(
      getDb().insert(userFollows).values({ followerId: b, followedId: a })
    ).resolves.toBeDefined();
  });

  it('refuses a self-follow, which Mongo permitted', async () => {
    const self = await account();
    const error = await rejection(
      getDb().insert(userFollows).values({ followerId: self, followedId: self })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(error)).toContain('user_follows_not_self_check');
  });

  it('refuses an edge into an account that does not exist', async () => {
    // The guarantee Mongo never had, and the reason `followed_id` is a real
    // foreign key rather than a discriminated polymorphic column.
    const follower = await account();
    const error = await rejection(
      getDb().insert(userFollows).values({ followerId: follower, followedId: `ghost-${uniqueId()}` })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
    expect(pgErrorMessage(error)).toContain('user_follows_followed_id_users_id_fk');
  });

  it('removes both directions when an account is deleted', async () => {
    // `user.service.ts:1633` does this by hand today, with a `deleteMany` over
    // an `$or` of the two columns. Here it is the database's job.
    const subject = await account();
    const follower = await account();
    const followed = await account();
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: follower, followedId: subject },
        { followerId: subject, followedId: followed },
      ]);

    await getDb().delete(users).where(eq(users.id, subject));

    const inbound = await getDb()
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(eq(userFollows.followedId, subject));
    const outbound = await getDb()
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(eq(userFollows.followerId, subject));
    expect({ inbound: inbound.length, outbound: outbound.length }).toEqual({
      inbound: 0,
      outbound: 0,
    });
  });
});

describe('user_follows — the string/ObjectId ambiguity is gone', () => {
  it('holds ids as text, so there is exactly one representation', async () => {
    const rows = await getDb().execute<{ column_name: string; data_type: string }>(sql`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'user_follows'
        and column_name in ('follower_id', 'followed_id')
      order by column_name
    `);

    expect(rows).toEqual([
      { column_name: 'followed_id', data_type: 'text' },
      { column_name: 'follower_id', data_type: 'text' },
    ]);
  });

  it('no longer accepts two spellings of the same id as equivalent', async () => {
    // Mongo's `followedId` was declared `ObjectId`, so a call site could pass a
    // `Types.ObjectId` OR its `.toString()` and Mongoose cast between them
    // silently — which is the only reason `followedIdToObjectId`
    // (`routes/profiles.ts:894`) existed. That cast was CASE-INSENSITIVE, so
    // these two spellings were ONE key in Mongo.
    const lower = 'a1b2c3d4e5f60718293a4b5c';
    const upper = lower.toUpperCase();

    // In Postgres they are two different `text` values, and only the stored one
    // resolves. The non-vacuity guard is the pair: the canonical spelling MUST
    // match, or a broken query would produce the same zero rows.
    const follower = await account();
    const [followed] = await getDb()
      .insert(users)
      .values({ id: lower, color: 'teal' })
      .returning({ id: users.id });
    await getDb().insert(userFollows).values({ followerId: follower, followedId: followed.id });

    const canonical = await getDb()
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(and(eq(userFollows.followerId, follower), eq(userFollows.followedId, lower)));
    expect(canonical).toHaveLength(1);

    const otherSpelling = await getDb()
      .select({ id: userFollows.id })
      .from(userFollows)
      .where(and(eq(userFollows.followerId, follower), eq(userFollows.followedId, upper)));
    expect(otherSpelling).toHaveLength(0);
  });

  it('cannot even STORE the other spelling — the foreign key refuses it', async () => {
    // This is the part that turns a silent mismatch into a loud one. A call site
    // that hands over an id in the wrong representation does not write a row
    // that later matches nothing; it fails at the write.
    const lower = 'b1c2d3e4f5061728394a5b6c';
    await getDb().insert(users).values({ id: lower, color: 'teal' });
    const follower = await account();

    const error = await rejection(
      getDb().insert(userFollows).values({ followerId: follower, followedId: lower.toUpperCase() })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('restrictions — mirrors blocks, minus the index blocks needed', () => {
  it('rejects the same (user, restricted) pair twice and permits the reverse', async () => {
    const a = await account();
    const b = await account();
    await getDb().insert(restrictions).values({ userId: a, restrictedId: b });

    const error = await rejection(
      getDb().insert(restrictions).values({ userId: a, restrictedId: b })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    await expect(
      getDb().insert(restrictions).values({ userId: b, restrictedId: a })
    ).resolves.toBeDefined();
  });

  it('has no updated_at — the absence IS the append-only contract', async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'restrictions'
    `);
    const names = rows.map((row) => row.column_name);

    expect(names).toContain('created_at');
    expect(names).not.toContain('updated_at');
  });
});

describe('notifications — participants constrained, entity deliberately not', () => {
  it('collapses a repeated (recipient, actor, type, entity) into one row', async () => {
    const recipient = await account();
    const actor = await account();
    const entityId = uniqueId();
    await getDb()
      .insert(notifications)
      .values({ recipientId: recipient, actorId: actor, type: 'like', entityId, entityType: 'post' });

    const error = await rejection(
      getDb()
        .insert(notifications)
        .values({ recipientId: recipient, actorId: actor, type: 'like', entityId, entityType: 'post' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    // A different TYPE against the same entity is a different notification.
    await expect(
      getDb()
        .insert(notifications)
        .values({ recipientId: recipient, actorId: actor, type: 'reply', entityId, entityType: 'post' })
    ).resolves.toBeDefined();
  });

  it('accepts an entity id that names no local row, and refuses a bad participant', async () => {
    // `entity_id` is polymorphic and two of its three types live in Mention's
    // database — so it carries no foreign key, on purpose, and this insert must
    // succeed. `actor_id` is the contrast that proves the table is constrained
    // at all.
    const recipient = await account();
    await expect(
      getDb().insert(notifications).values({
        recipientId: recipient,
        actorId: await account(),
        type: 'mention',
        entityId: `mention-post-${uniqueId()}`,
        entityType: 'post',
      })
    ).resolves.toBeDefined();

    const error = await rejection(
      getDb().insert(notifications).values({
        recipientId: recipient,
        actorId: `ghost-${uniqueId()}`,
        type: 'mention',
        entityId: uniqueId(),
        entityType: 'post',
      })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('rejects an undeclared type or entity type from a raw write', async () => {
    // Raw SQL on purpose: the typed columns already refuse these at compile
    // time, so only a hand-written statement (backfill, psql) can reach the
    // constraint — which is precisely who it has to stop.
    const recipient = await account();
    const actor = await account();

    const badType = await rejection(
      getDb().execute(sql`
        insert into notifications (id, recipient_id, actor_id, type, entity_id, entity_type)
        values (${uniqueId()}, ${recipient}, ${actor}, 'subscribed', ${uniqueId()}, 'post')
      `)
    );
    expect(pgErrorCode(badType)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(badType)).toContain('notifications_type_check');

    const badEntity = await rejection(
      getDb().execute(sql`
        insert into notifications (id, recipient_id, actor_id, type, entity_id, entity_type)
        values (${uniqueId()}, ${recipient}, ${actor}, 'like', ${uniqueId()}, 'comment')
      `)
    );
    expect(pgErrorCode(badEntity)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(badEntity)).toContain('notifications_entity_type_check');
  });
});

describe('topics — the weighted text index', () => {
  /** One topic whose four searchable fields share no vocabulary. */
  async function searchableTopic(): Promise<string> {
    const token = uniqueId().slice(0, 10);
    const [row] = await getDb()
      .insert(topics)
      .values({
        name: `zn${token}`,
        slug: `zn${token}`,
        displayName: 'Videogames',
        description: 'Everything about playing',
        type: 'category',
        source: 'seed',
        aliases: ['esports', 'machine learning'],
      })
      .returning({ id: topics.id });
    return row.id;
  }

  /** `ts_rank` under Mongo's weight ratios for one query term. */
  async function rank(id: string, term: string): Promise<number> {
    const [row] = await getDb()
      .select({
        rank: sql<number>`ts_rank(${sql.raw(`'${MONGO_RANK_WEIGHTS}'`)}, ${topics.searchVector}, to_tsquery('english', ${term}))`,
      })
      .from(topics)
      .where(eq(topics.id, id));
    return Number(row.rank);
  }

  it('ranks name above display name above aliases above description', async () => {
    const id = await searchableTopic();
    const [row] = await getDb()
      .select({ name: topics.name })
      .from(topics)
      .where(eq(topics.id, id));

    const byName = await rank(id, row.name);
    const byDisplayName = await rank(id, 'videogam');
    const byAlias = await rank(id, 'esport');
    const byDescription = await rank(id, 'everything');

    // Every field contributes — a zero anywhere would mean that `setweight`
    // term never made it into the vector.
    expect(byName).toBeGreaterThan(0);
    expect(byDisplayName).toBeGreaterThan(0);
    expect(byAlias).toBeGreaterThan(0);
    expect(byDescription).toBeGreaterThan(0);

    // And they are ordered A > B > C > D, which is what the weighting is FOR.
    expect(byName).toBeGreaterThan(byDisplayName);
    expect(byDisplayName).toBeGreaterThan(byAlias);
    expect(byAlias).toBeGreaterThan(byDescription);

    // A term in no field must not match, or the four assertions above would
    // hold for a vector containing everything.
    expect(await rank(id, 'reykjavik')).toBe(0);
  });

  it('stems the aliases under the same configuration as every other field', async () => {
    // The trap the `array_to_tsvector` round trip exists to avoid: used
    // directly, it emits each alias VERBATIM, so `esports` would never match the
    // stemmed query term `esport` and alias search would silently do nothing
    // while looking like it worked.
    const id = await searchableTopic();
    expect(await rank(id, 'esport')).toBeGreaterThan(0);
    // A multi-word alias tokenizes into its words, exactly as a text field does.
    expect(await rank(id, 'machin')).toBeGreaterThan(0);
    expect(await rank(id, 'learn')).toBeGreaterThan(0);
  });

  it('produces the same lexemes the STABLE spelling would have', async () => {
    // `array_to_string` is the obvious spelling and Postgres refuses it in a
    // generated column. This pins the immutable replacement as an equivalent
    // rather than an approximation: identical lexeme SETS (positions differ,
    // because `array_to_tsvector` sorts, and positions affect neither `@@` nor
    // `setweight` ranking).
    const samples = [
      ['machine learning', 'deep-learning'],
      ["O'Brien", 'café', 'naïve'],
      ['C++', '.NET', 'node.js'],
      ['Running', 'runs', 'ran'],
      [],
    ];

    for (const aliases of samples) {
      // A JS array bound as one parameter arrives as a record, so the literal is
      // assembled element by element — each element still a bound parameter.
      const literal = sql`array[${sql.join(
        aliases.map((alias) => sql`${alias}`),
        sql`, `
      )}]::text[]`;
      const [row] = await getDb().execute<{ equivalent: boolean }>(sql`
        select strip(to_tsvector('english', replace(array_to_tsvector(${literal})::text, '''', ' ')))
             = strip(to_tsvector('english', array_to_string(${literal}, ' '))) as equivalent
      `);
      expect({ aliases, equivalent: row.equivalent }).toEqual({ aliases, equivalent: true });
    }
  });

  it('keeps translations as an object and refuses anything else', async () => {
    const token = uniqueId().slice(0, 10);
    const [row] = await getDb()
      .insert(topics)
      .values({
        name: `tr${token}`,
        slug: `tr${token}`,
        displayName: 'Animals',
        type: 'category',
        source: 'seed',
        translations: { 'es-ES': { displayName: 'Animales' }, 'ca-ES': { displayName: 'Animals' } },
      })
      .returning({ translations: topics.translations });
    expect(row.translations).toEqual({
      'es-ES': { displayName: 'Animales' },
      'ca-ES': { displayName: 'Animals' },
    });

    const error = await rejection(
      getDb().execute(sql`
        insert into topics (id, name, slug, display_name, type, source, translations)
        values (${uniqueId()}, ${`bad${token}`}, ${`bad${token}`}, 'Bad', 'category', 'seed', '[]'::jsonb)
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(error)).toContain('topics_translations_object_check');
  });

  it('promotes children to top level rather than deleting them with a parent', async () => {
    const token = uniqueId().slice(0, 10);
    const [parent] = await getDb()
      .insert(topics)
      .values({
        name: `pa${token}`,
        slug: `pa${token}`,
        displayName: 'Parent',
        type: 'category',
        source: 'seed',
      })
      .returning({ id: topics.id });
    const [child] = await getDb()
      .insert(topics)
      .values({
        name: `ch${token}`,
        slug: `ch${token}`,
        displayName: 'Child',
        type: 'topic',
        source: 'seed',
        parentTopicId: parent.id,
      })
      .returning({ id: topics.id });

    await getDb().delete(topics).where(eq(topics.id, parent.id));

    const [survivor] = await getDb()
      .select({ parentTopicId: topics.parentTopicId })
      .from(topics)
      .where(eq(topics.id, child.id));
    expect(survivor).toEqual({ parentTopicId: null });
  });
});

describe('user_app_data — `{}` is a value, not an absence', () => {
  it('holds the value as jsonb, not as a serialized string', async () => {
    // This has to be asserted against the CATALOGUE, because drizzle's `jsonb`
    // column maps a driver string back through `JSON.parse` — so a `text`
    // column under the same schema declaration would round-trip `{}` in
    // JavaScript and the round-trip assertion below would pass while the stored
    // representation was an opaque blob.
    const [row] = await getDb().execute<{ data_type: string }>(sql`
      select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'user_app_data' and column_name = 'value'
    `);
    expect(row).toEqual({ data_type: 'jsonb' });
  });

  it('preserves an empty object exactly, distinct from NULL', async () => {
    // Mongoose sets `minimize: false` on this schema precisely so `{}` is
    // STORED rather than stripped: a progress record with no entries yet is not
    // the same thing as no record.
    const userId = await account();
    const [stored] = await getDb()
      .insert(userAppData)
      .values({ userId, namespace: 'academy', key: 'progress', value: {} })
      .returning({ value: userAppData.value });
    expect(stored.value).toEqual({});

    const [readBack] = await getDb()
      .select({ value: userAppData.value })
      .from(userAppData)
      .where(and(eq(userAppData.userId, userId), eq(userAppData.key, 'progress')));
    expect(readBack.value).toEqual({});

    // And SERVER-side, where no client-side mapping can stand in for the stored
    // value: an empty JSON OBJECT, not SQL NULL and not JSON `null`.
    const [inDatabase] = await getDb().execute<{
      is_null: boolean;
      json_type: string;
      is_empty_object: boolean;
    }>(sql`
      select ${userAppData.value} is null as is_null,
             jsonb_typeof(${userAppData.value}) as json_type,
             ${userAppData.value} = '{}'::jsonb as is_empty_object
      from ${userAppData}
      where ${userAppData.userId} = ${userId} and ${userAppData.key} = 'progress'
    `);
    expect(inDatabase).toEqual({ is_null: false, json_type: 'object', is_empty_object: true });
  });

  it('keeps every other shape-less value intact', async () => {
    const userId = await account();
    const nested = { lessons: { intro: { done: true, score: 0 } }, tags: ['a', 'b'], seen: 3 };
    await getDb()
      .insert(userAppData)
      .values([
        { userId, namespace: 'academy', key: 'nested', value: nested },
        { userId, namespace: 'academy', key: 'list', value: [] },
        { userId, namespace: 'academy', key: 'absent' },
      ]);

    const rows = await getDb()
      .select({ key: userAppData.key, value: userAppData.value })
      .from(userAppData)
      .where(eq(userAppData.userId, userId));
    const byKey = new Map(rows.map((row) => [row.key, row.value]));

    expect(byKey.get('nested')).toEqual(nested);
    expect(byKey.get('list')).toEqual([]);
    expect(byKey.get('absent')).toBeNull();
  });

  it('refuses an identifier the Mongoose validator would have rejected', async () => {
    const userId = await account();

    for (const [column, values] of [
      ['namespace', ['Academy', 'aca demy', 'aca.demy', '', 'a'.repeat(65)]],
      ['key', ['Progress', 'pro gress', 'pro/gress', '']],
    ] as const) {
      for (const value of values) {
        const row = column === 'namespace'
          ? { userId, namespace: value, key: 'progress' }
          : { userId, namespace: 'academy', key: value };
        const error = await rejection(getDb().insert(userAppData).values(row));
        expect({ column, value, code: pgErrorCode(error) }).toEqual({
          column,
          value,
          code: CHECK_VIOLATION,
        });
        expect(pgErrorMessage(error)).toContain(`user_app_data_${column}_check`);
      }
    }
  });

  it('states the same identifier rule the Mongoose model does', async () => {
    // The SQL pattern is written for POSIX regex and the Mongoose one for
    // JavaScript, so they cannot be compared as strings — they are compared by
    // BEHAVIOUR, against inputs on both sides of the boundary.
    const accepted = ['a', 'academy', 'oxy-academy', 'oxy_academy_2', '0', 'x'.repeat(64)];
    const refused = ['', 'A', 'Academy', 'oxy academy', 'oxy.academy', 'oxy/academy', 'x'.repeat(65), 'ñ'];

    for (const value of [...accepted, ...refused]) {
      const [row] = await getDb().execute<{ matches: boolean }>(sql`
        select ${value} ~ ${sql.raw(`'${APP_DATA_IDENTIFIER_SQL_PATTERN}'`)} as matches
      `);
      expect({ value, sql: row.matches }).toEqual({
        value,
        sql: APP_DATA_IDENTIFIER_PATTERN.test(value),
      });
    }

    // Non-vacuity: both lists must be non-empty and must disagree, or the loop
    // above would pass against a regex that accepts (or refuses) everything.
    expect(accepted.every((value) => APP_DATA_IDENTIFIER_PATTERN.test(value))).toBe(true);
    expect(refused.some((value) => APP_DATA_IDENTIFIER_PATTERN.test(value))).toBe(false);
  });

  it('permits one row per (user, namespace, key) and no more', async () => {
    const userId = await account();
    await getDb().insert(userAppData).values({ userId, namespace: 'academy', key: 'progress', value: 1 });

    const error = await rejection(
      getDb().insert(userAppData).values({ userId, namespace: 'academy', key: 'progress', value: 2 })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    // A different key, and the same key under another namespace, both stand.
    await expect(
      getDb().insert(userAppData).values([
        { userId, namespace: 'academy', key: 'streak', value: 2 },
        { userId, namespace: 'inbox', key: 'progress', value: 3 },
      ])
    ).resolves.toBeDefined();
  });
});

describe('moderation policy — the arrays that became child tables', () => {
  it('permits exactly one severity rule per severity', async () => {
    const { id } = await policy();
    await getDb()
      .insert(moderationPolicySeverityRules)
      .values({ policyId: id, severity: 'high', points: -20, riskPoints: 10 });

    const error = await rejection(
      getDb()
        .insert(moderationPolicySeverityRules)
        .values({ policyId: id, severity: 'high', points: -30, riskPoints: 15 })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorMessage(error)).toContain(
      'moderation_policy_severity_rules_policy_id_severity_key'
    );

    // Another severity under the same version, and the same severity under a
    // different version, are both legitimate.
    const other = await policy();
    await expect(
      getDb()
        .insert(moderationPolicySeverityRules)
        .values([
          { policyId: id, severity: 'low', points: -5, riskPoints: 2 },
          { policyId: other.id, severity: 'high', points: -20, riskPoints: 10 },
        ])
    ).resolves.toBeDefined();
  });

  it('keeps "no automatic expiry" distinct from a value', async () => {
    const { id } = await policy();
    const [row] = await getDb()
      .insert(moderationPolicySeverityRules)
      .values({ policyId: id, severity: 'critical', points: -100, riskPoints: 60 })
      .returning({ riskExpiryDays: moderationPolicySeverityRules.riskExpiryDays });
    expect(row.riskExpiryDays).toBeNull();

    const error = await rejection(
      getDb()
        .insert(moderationPolicySeverityRules)
        .values({ policyId: id, severity: 'medium', points: -10, riskPoints: 5, riskExpiryDays: 0 })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('permits exactly one threshold per standing', async () => {
    const { id } = await policy();
    await getDb()
      .insert(moderationPolicyStandingThresholds)
      .values({ policyId: id, standing: 'watch', minRisk: 10 });

    const error = await rejection(
      getDb()
        .insert(moderationPolicyStandingThresholds)
        .values({ policyId: id, standing: 'watch', minRisk: 20 })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('takes its rules and thresholds with it when a version is removed', async () => {
    const { id } = await policy();
    await getDb()
      .insert(moderationPolicySeverityRules)
      .values({ policyId: id, severity: 'low', points: -5, riskPoints: 2 });
    await getDb()
      .insert(moderationPolicyStandingThresholds)
      .values({ policyId: id, standing: 'good', minRisk: 0 });

    await getDb().delete(moderationPolicies).where(eq(moderationPolicies.id, id));

    const rules = await getDb()
      .select({ id: moderationPolicySeverityRules.id })
      .from(moderationPolicySeverityRules)
      .where(eq(moderationPolicySeverityRules.policyId, id));
    const thresholds = await getDb()
      .select({ id: moderationPolicyStandingThresholds.id })
      .from(moderationPolicyStandingThresholds)
      .where(eq(moderationPolicyStandingThresholds.policyId, id));
    expect({ rules: rules.length, thresholds: thresholds.length }).toEqual({
      rules: 0,
      thresholds: 0,
    });
  });

  it('keeps the repetition multipliers in the order that IS their meaning', async () => {
    const version = `oxy.test.${uniqueId()}`;
    const [row] = await getDb()
      .insert(moderationPolicies)
      .values({
        policyVersion: version,
        conductFamilies: ['spam', 'harassment'],
        repetitionMultipliers: [1, 1.5, 2.25],
        repetitionWindowDays: 180,
        multiFindingSecondaryShare: 0.25,
        multiFindingCap: 2,
      })
      .returning({
        repetitionMultipliers: moderationPolicies.repetitionMultipliers,
        conductFamilies: moderationPolicies.conductFamilies,
      });

    expect(row.repetitionMultipliers).toEqual([1, 1.5, 2.25]);
    expect(row.conductFamilies).toEqual(['spam', 'harassment']);
  });
});

describe('conduct_strikes and moderation_effects — one penalty per incident', () => {
  /** Everything a strike needs, minus what the caller overrides. */
  async function strikeValues(): Promise<typeof conductStrikes.$inferInsert> {
    const { version } = await policy();
    const userId = await account();
    return {
      userId,
      incidentId: `inc-${uniqueId()}`,
      decisionId: `dec-${uniqueId()}`,
      decisionRevision: 1,
      effectType: 'conduct_penalty',
      severity: 'high',
      riskPoints: 10,
      family: 'spam',
      policyVersion: version,
      transactionId: await ledgerEntry(userId),
    };
  }

  it('refuses a second strike for the same incident, subject, axis and revision', async () => {
    const values = await strikeValues();
    await getDb().insert(conductStrikes).values(values);

    const error = await rejection(getDb().insert(conductStrikes).values(values));
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorMessage(error)).toContain(
      'conduct_strikes_incident_id_user_id_effect_type_revision_key'
    );

    // A different AXIS in the same incident is a distinct consequence, not a
    // duplicate — a person can be both the author and a colluding reviewer.
    await expect(
      getDb()
        .insert(conductStrikes)
        .values({ ...values, effectType: 'review_abuse_penalty' })
    ).resolves.toBeDefined();
    // And an appeal's revision creates its own strike.
    await expect(
      getDb().insert(conductStrikes).values({ ...values, decisionRevision: 2 })
    ).resolves.toBeDefined();
  });

  it('refuses to delete a policy version a strike was derived under', async () => {
    const values = await strikeValues();
    await getDb().insert(conductStrikes).values(values);

    const error = await rejection(
      getDb()
        .delete(moderationPolicies)
        .where(eq(moderationPolicies.policyVersion, values.policyVersion))
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
    expect(pgErrorMessage(error)).toContain('conduct_strikes_policy_version_fk');
  });

  it('refuses a strike citing a policy version that does not exist', async () => {
    const values = await strikeValues();
    const error = await rejection(
      getDb()
        .insert(conductStrikes)
        .values({ ...values, policyVersion: `oxy.absent.${uniqueId()}` })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('makes "resolved but still active" and "active but resolved" unrepresentable', async () => {
    const values = await strikeValues();
    const [row] = await getDb()
      .insert(conductStrikes)
      .values(values)
      .returning({ id: conductStrikes.id });

    const halfExpired = await rejection(
      getDb().update(conductStrikes).set({ status: 'expired' }).where(eq(conductStrikes.id, row.id))
    );
    expect(pgErrorCode(halfExpired)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(halfExpired)).toContain('conduct_strikes_resolution_complete_check');

    const halfActive = await rejection(
      getDb().update(conductStrikes).set({ resolvedAt: new Date() }).where(eq(conductStrikes.id, row.id))
    );
    expect(pgErrorCode(halfActive)).toBe(CHECK_VIOLATION);

    // Both fields together, as `expireConductStrikes` writes them, is accepted.
    await expect(
      getDb()
        .update(conductStrikes)
        .set({ status: 'expired', resolvedAt: new Date() })
        .where(eq(conductStrikes.id, row.id))
    ).resolves.toBeDefined();
  });

  it('answers a redelivered event and a re-emitted one with the same guard', async () => {
    const strike = await strikeValues();
    const [created] = await getDb()
      .insert(conductStrikes)
      .values(strike)
      .returning({ id: conductStrikes.id });

    const effect: typeof moderationEffects.$inferInsert = {
      eventId: `evt-${uniqueId()}`,
      incidentId: strike.incidentId,
      caseId: `case-${uniqueId()}`,
      decisionId: strike.decisionId,
      decisionRevision: 1,
      principalId: strike.userId,
      bindingId: await binding(strike.userId),
      applicationId: await application(),
      effectType: 'conduct_penalty',
      points: -20,
      activeRisk: 10,
      severity: 'high',
      family: 'spam',
      repetitionMultiplier: 1,
      multiFindingMultiplier: 1,
      idempotencyKey: `idem-${uniqueId()}`,
      transactionId: strike.transactionId,
      strikeId: created.id,
      policyVersionUniversal: 'universal.1',
      policyVersionApplication: 'app.1',
      policyVersionOxyConduct: strike.policyVersion,
      proofHash: uniqueId(),
    };
    await getDb().insert(moderationEffects).values(effect);

    // Each key is provoked in ISOLATION. A row that violates both would be
    // reported under whichever Postgres checked first, so "some unique
    // constraint fired" would stand in for "this one did" — and the whole point
    // of the pair is that NEITHER key alone is sufficient.

    // The TRANSPORT key: the same event id, a different incident. The semantic
    // key is satisfied, so only the event id can reject this.
    const redelivered = await rejection(
      getDb()
        .insert(moderationEffects)
        .values({ ...effect, incidentId: `inc-${uniqueId()}` })
    );
    expect(pgErrorCode(redelivered)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorMessage(redelivered)).toContain('moderation_effects_event_id_key');

    // The SEMANTIC key: a FRESH event id for the same incident, principal, axis
    // and revision. This is the one the transport key alone would have let
    // through, applying a second penalty for one incident.
    const reEmitted = await rejection(
      getDb()
        .insert(moderationEffects)
        .values({ ...effect, eventId: `evt-${uniqueId()}` })
    );
    expect(pgErrorCode(reEmitted)).toBe(UNIQUE_VIOLATION);
    expect(pgErrorMessage(reEmitted)).toContain(
      'moderation_effects_incident_principal_type_revision_key'
    );

    // And a genuinely different incident, with its own event id, is accepted —
    // so neither key is simply rejecting everything.
    await expect(
      getDb()
        .insert(moderationEffects)
        .values({
          ...effect,
          eventId: `evt-${uniqueId()}`,
          incidentId: `inc-${uniqueId()}`,
          idempotencyKey: `idem-${uniqueId()}`,
        })
    ).resolves.toBeDefined();
  });

  it('makes half a reversal unrepresentable', async () => {
    const strike = await strikeValues();
    const [row] = await getDb()
      .insert(moderationEffects)
      .values({
        eventId: `evt-${uniqueId()}`,
        incidentId: strike.incidentId,
        caseId: `case-${uniqueId()}`,
        decisionId: strike.decisionId,
        decisionRevision: 1,
        principalId: strike.userId,
        bindingId: await binding(strike.userId),
        applicationId: await application(),
        effectType: 'conduct_penalty',
        points: -20,
        activeRisk: 10,
        severity: 'high',
        family: 'spam',
        repetitionMultiplier: 1,
        multiFindingMultiplier: 1,
        idempotencyKey: `idem-${uniqueId()}`,
        transactionId: strike.transactionId,
        policyVersionUniversal: 'universal.1',
        policyVersionApplication: 'app.1',
        policyVersionOxyConduct: strike.policyVersion,
        proofHash: uniqueId(),
      })
      .returning({ id: moderationEffects.id });

    const error = await rejection(
      getDb()
        .update(moderationEffects)
        .set({ status: 'reversed' })
        .where(eq(moderationEffects.id, row.id))
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(error)).toContain('moderation_effects_reversal_complete_check');

    await expect(
      getDb()
        .update(moderationEffects)
        .set({ status: 'reversed', reversedAt: new Date(), reversalReason: 'appeal upheld' })
        .where(eq(moderationEffects.id, row.id))
    ).resolves.toBeDefined();
  });
});

describe('reputation profiles — one per account, maps kept as objects', () => {
  it('permits one reporter profile per account', async () => {
    const userId = await account();
    await getDb().insert(reporterReputationProfiles).values({ userId });

    const error = await rejection(
      getDb().insert(reporterReputationProfiles).values({ userId })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('defaults a newcomer to a neutral prior rather than zero', async () => {
    const [row] = await getDb()
      .insert(reporterReputationProfiles)
      .values({ userId: await account() })
      .returning();

    expect({
      reliability: row.reliability,
      confidence: row.confidence,
      confirmed: row.confirmed,
      confirmedByFamily: row.confirmedByFamily,
    }).toEqual({ reliability: 0.5, confidence: 0, confirmed: 0, confirmedByFamily: {} });
  });

  it('round-trips the per-family counts and refuses a non-object', async () => {
    const userId = await account();
    const [row] = await getDb()
      .insert(reporterReputationProfiles)
      .values({ userId, confirmedByFamily: { spam: 3, harassment: 1 } })
      .returning({ confirmedByFamily: reporterReputationProfiles.confirmedByFamily });
    expect(row.confirmedByFamily).toEqual({ spam: 3, harassment: 1 });

    const error = await rejection(
      getDb().execute(sql`
        insert into reporter_reputation_profiles (id, user_id, confirmed_by_family)
        values (${uniqueId()}, ${await account()}, '"spam"'::jsonb)
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(error)).toContain(
      'reporter_reputation_profiles_confirmed_by_family_object_check'
    );
  });

  it('keeps a reviewer profile per account, with its arrays and maps', async () => {
    const userId = await account();
    const [row] = await getDb()
      .insert(reviewerReputationProfiles)
      .values({
        userId,
        categoryReliability: { spam: 0.9 },
        unlockedCategories: ['spam', 'harassment'],
        languages: ['en', 'es'],
      })
      .returning();

    expect({
      status: row.status,
      globalReliability: row.globalReliability,
      categoryReliability: row.categoryReliability,
      languageReliability: row.languageReliability,
      unlockedCategories: row.unlockedCategories,
      languages: row.languages,
    }).toEqual({
      status: 'active',
      globalReliability: 0.5,
      categoryReliability: { spam: 0.9 },
      languageReliability: {},
      unlockedCategories: ['spam', 'harassment'],
      languages: ['en', 'es'],
    });

    const error = await rejection(getDb().insert(reviewerReputationProfiles).values({ userId }));
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('rejects an undeclared reviewer status from a raw write', async () => {
    const error = await rejection(
      getDb().execute(sql`
        insert into reviewer_reputation_profiles (id, user_id, status)
        values (${uniqueId()}, ${await account()}, 'banned')
      `)
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });
});

describe('user_analytics — one aggregate per account per window', () => {
  it('renames `userID` to `user_id` and has no capitalised column left', async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'user_analytics'
    `);
    const names = rows.map((row) => row.column_name);

    expect(names).toContain('user_id');
    expect(names).not.toContain('userid');
    expect(names.filter((name) => !/^[a-z][a-z0-9_]*$/.test(name))).toEqual([]);
  });

  it('refuses a second aggregate for the same (account, period, date)', async () => {
    const userId = await account();
    const date = new Date('2026-07-01T00:00:00.000Z');
    await getDb().insert(userAnalytics).values({ userId, period: 'daily', date });

    const error = await rejection(
      getDb().insert(userAnalytics).values({ userId, period: 'daily', date })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    // A different window over the same instant is a different aggregate.
    await expect(
      getDb().insert(userAnalytics).values({ userId, period: 'weekly', date })
    ).resolves.toBeDefined();
  });

  it('flattens the nested stats and keeps the demographics maps whole', async () => {
    const userId = await account();
    const [row] = await getDb()
      .insert(userAnalytics)
      .values({
        userId,
        period: 'monthly',
        date: new Date('2026-07-01T00:00:00.000Z'),
        postViews: 12,
        engagementLikes: 3,
        reachImpressions: 40,
        demographicsCountries: { ES: 7, US: 2 },
        demographicsLanguages: { 'es-ES': 6 },
        peakActivityHour: 23,
        peakActivityCount: 5,
      })
      .returning();

    expect({
      postViews: row.postViews,
      profileViews: row.profileViews,
      engagementLikes: row.engagementLikes,
      engagementQuotes: row.engagementQuotes,
      reachImpressions: row.reachImpressions,
      reachUniqueViewers: row.reachUniqueViewers,
      demographicsCountries: row.demographicsCountries,
      demographicsLanguages: row.demographicsLanguages,
      peakActivityHour: row.peakActivityHour,
    }).toEqual({
      postViews: 12,
      profileViews: 0,
      engagementLikes: 3,
      engagementQuotes: 0,
      reachImpressions: 40,
      reachUniqueViewers: 0,
      demographicsCountries: { ES: 7, US: 2 },
      demographicsLanguages: { 'es-ES': 6 },
      peakActivityHour: 23,
    });
  });

  it('refuses an hour outside the day', async () => {
    const userId = await account();
    const error = await rejection(
      getDb().insert(userAnalytics).values({
        userId,
        period: 'daily',
        date: new Date('2026-07-02T00:00:00.000Z'),
        peakActivityHour: 24,
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
    expect(pgErrorMessage(error)).toContain('user_analytics_peak_activity_hour_check');

    // 23 is the last valid hour — the pair is what proves the bound is `< 24`
    // rather than "any check at all".
    await expect(
      getDb().insert(userAnalytics).values({
        userId,
        period: 'daily',
        date: new Date('2026-07-03T00:00:00.000Z'),
        peakActivityHour: 23,
      })
    ).resolves.toBeDefined();
  });
});

describe('deleting an account takes its social graph and its records with it', () => {
  it('leaves nothing behind in any table of this batch', async () => {
    const subject = await account();
    const other = await account();
    const { version } = await policy();

    await getDb().insert(userFollows).values({ followerId: subject, followedId: other });
    await getDb().insert(restrictions).values({ userId: subject, restrictedId: other });
    await getDb()
      .insert(notifications)
      .values({
        recipientId: subject,
        actorId: other,
        type: 'follow',
        entityId: uniqueId(),
        entityType: 'profile',
      });
    await getDb().insert(userAppData).values({ userId: subject, namespace: 'academy', key: 'progress', value: {} });
    await getDb()
      .insert(userAnalytics)
      .values({ userId: subject, period: 'daily', date: new Date('2026-06-01T00:00:00.000Z') });
    await getDb().insert(reporterReputationProfiles).values({ userId: subject });
    await getDb().insert(reviewerReputationProfiles).values({ userId: subject });
    const [strike] = await getDb()
      .insert(conductStrikes)
      .values({
        userId: subject,
        incidentId: `inc-${uniqueId()}`,
        decisionId: `dec-${uniqueId()}`,
        decisionRevision: 1,
        effectType: 'conduct_penalty',
        severity: 'high',
        riskPoints: 10,
        family: 'spam',
        policyVersion: version,
        transactionId: await ledgerEntry(subject),
      })
      .returning({ id: conductStrikes.id });
    await getDb().insert(moderationEffects).values({
      eventId: `evt-${uniqueId()}`,
      incidentId: `inc-${uniqueId()}`,
      caseId: `case-${uniqueId()}`,
      decisionId: `dec-${uniqueId()}`,
      decisionRevision: 1,
      principalId: subject,
      bindingId: await binding(subject),
      applicationId: await application(),
      effectType: 'conduct_penalty',
      points: -20,
      activeRisk: 10,
      severity: 'high',
      family: 'spam',
      repetitionMultiplier: 1,
      multiFindingMultiplier: 1,
      idempotencyKey: `idem-${uniqueId()}`,
      transactionId: await ledgerEntry(subject),
      strikeId: strike.id,
      policyVersionUniversal: 'universal.1',
      policyVersionApplication: 'app.1',
      policyVersionOxyConduct: version,
      proofHash: uniqueId(),
    });

    await getDb().delete(users).where(eq(users.id, subject));

    for (const [label, rows] of [
      ['follows', await getDb().select().from(userFollows).where(eq(userFollows.followerId, subject))],
      ['restrictions', await getDb().select().from(restrictions).where(eq(restrictions.userId, subject))],
      ['notifications', await getDb().select().from(notifications).where(eq(notifications.recipientId, subject))],
      ['appData', await getDb().select().from(userAppData).where(eq(userAppData.userId, subject))],
      ['analytics', await getDb().select().from(userAnalytics).where(eq(userAnalytics.userId, subject))],
      ['reporterProfile', await getDb().select().from(reporterReputationProfiles).where(eq(reporterReputationProfiles.userId, subject))],
      ['reviewerProfile', await getDb().select().from(reviewerReputationProfiles).where(eq(reviewerReputationProfiles.userId, subject))],
      ['strikes', await getDb().select().from(conductStrikes).where(eq(conductStrikes.userId, subject))],
      ['effects', await getDb().select().from(moderationEffects).where(eq(moderationEffects.principalId, subject))],
    ] as const) {
      expect({ [label]: rows.length }).toEqual({ [label]: 0 });
    }

    // The counterparty is untouched: only the erased account's own rows go.
    const [survivor] = await getDb().select({ id: users.id }).from(users).where(eq(users.id, other));
    expect(survivor).toEqual({ id: other });
  });
});
