/**
 * `/topics` against a REAL Postgres.
 *
 * The staff-authorization concern is unchanged from the suite this replaces;
 * what changed is that the write side is no longer proved by asserting the
 * ARGUMENTS of a mocked `Topic.findOneAndUpdate`. That assertion pinned the
 * Mongo call shape and nothing else — it would have passed just as happily
 * against an update that matched no row.
 *
 * Two additions the mock could not have covered, and both are the port's own
 * risk surface: the response body (`_id`, no `__v`, `description` a string) and
 * the weighted OR-semantics search.
 *
 * MOCKED: `authMiddleware` only, so a test can be staff or not without minting
 * a session. Every topic row is real.
 */

import express from 'express';
import http from 'http';
import { eq, inArray } from 'drizzle-orm';

const mockAuthMiddleware = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { topics } from '../../db/schema/topics';
import topicsRouter from '../topics.routes';
import { topicService } from '../../services/TopicService';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

function requestJson(
  target: http.Server,
  method: string,
  path: string,
  payload?: unknown
): Promise<JsonResponse> {
  const address = target.address();
  if (address === null || typeof address === 'string') {
    return Promise.reject(new Error('server not listening on a TCP port'));
  }
  const { port } = address;
  const body = payload === undefined ? '' : JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let server: http.Server;
let currentIsStaff = false;

/** Names this file inserted, removed between tests so none leaks into another. */
const insertedNames: string[] = [];

async function seedTopic(
  fields: Partial<typeof topics.$inferInsert> & { name: string; slug: string }
): Promise<string> {
  const [row] = await getDb()
    .insert(topics)
    .values({ displayName: fields.name, type: 'topic', source: 'seed', ...fields })
    .returning({ id: topics.id });
  insertedNames.push(fields.name);
  return row.id;
}

async function clearSeeded(): Promise<void> {
  const names = insertedNames.splice(0);
  if (names.length > 0) {
    await getDb().delete(topics).where(inArray(topics.name, names));
  }
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/topics', topicsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await clearSeeded();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await clearSeeded();
  currentIsStaff = false;
  mockAuthMiddleware.mockImplementation(
    (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { _id: 'user-id', id: 'user-id', isStaff: currentIsStaff };
      next();
    }
  );
});

describe('/topics write authorization', () => {
  it('rejects topic resolution for authenticated non-staff users', async () => {
    const res = await requestJson(server, 'POST', '/topics/resolve', {
      names: [{ name: 'Poisoned topic', type: 'topic' }],
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Forbidden' });

    // The refusal must be a refusal to WRITE, not merely a refused response.
    const [row] = await getDb()
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.name, 'poisoned topic'))
      .limit(1);
    expect(row).toBeUndefined();
  });

  it('allows staff users to resolve topic names', async () => {
    currentIsStaff = true;
    insertedNames.push('poisoned topic');

    const res = await requestJson(server, 'POST', '/topics/resolve', {
      names: [{ name: 'Poisoned topic', type: 'topic' }],
    });

    expect(res.status).toBe(200);
    // Keyed by the LOWERCASED name, and the row is really there.
    expect(res.body.topics).toMatchObject({ 'poisoned topic': { slug: 'poisoned-topic' } });

    const [row] = await getDb()
      .select({ name: topics.name, slug: topics.slug, source: topics.source })
      .from(topics)
      .where(eq(topics.name, 'poisoned topic'))
      .limit(1);
    expect(row).toEqual({ name: 'poisoned topic', slug: 'poisoned-topic', source: 'ai' });
  });

  it('rejects metadata updates for authenticated non-staff users', async () => {
    await seedTopic({ name: 'technology', slug: 'technology', displayName: 'Tech' });

    const res = await requestJson(server, 'PATCH', '/topics/technology', {
      displayName: 'Defaced',
      description: 'Poisoned global metadata',
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Forbidden' });

    const [row] = await getDb()
      .select({ displayName: topics.displayName, description: topics.description })
      .from(topics)
      .where(eq(topics.slug, 'technology'))
      .limit(1);
    expect(row).toEqual({ displayName: 'Tech', description: null });
  });

  it('allows staff users to update topic metadata', async () => {
    await seedTopic({ name: 'technology', slug: 'technology', displayName: 'Tech' });
    currentIsStaff = true;

    const res = await requestJson(server, 'PATCH', '/topics/technology', {
      displayName: 'Technology',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: 'technology', displayName: 'Technology' });

    const [row] = await getDb()
      .select({ displayName: topics.displayName })
      .from(topics)
      .where(eq(topics.slug, 'technology'))
      .limit(1);
    expect(row).toEqual({ displayName: 'Technology' });
  });

  it('ignores a field outside the update whitelist', async () => {
    await seedTopic({ name: 'technology', slug: 'technology', displayName: 'Tech' });
    currentIsStaff = true;

    const res = await requestJson(server, 'PATCH', '/topics/technology', {
      displayName: 'Technology',
      slug: 'hijacked',
      isActive: false,
    });

    expect(res.status).toBe(200);
    const [row] = await getDb()
      .select({ slug: topics.slug, isActive: topics.isActive })
      .from(topics)
      .where(eq(topics.displayName, 'Technology'))
      .limit(1);
    expect(row).toEqual({ slug: 'technology', isActive: true });
  });
});

describe('/topics response shape', () => {
  it('serves `_id` and a string `description`, and never `__v`', async () => {
    await seedTopic({ name: 'gardening', slug: 'gardening', displayName: 'Gardening' });

    const res = await requestJson(server, 'GET', '/topics/gardening');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'gardening',
      slug: 'gardening',
      displayName: 'Gardening',
      // Mongoose defaulted `description` to `''` and therefore always emitted a
      // string; the column is NULL. A client doing `description.length` must
      // not start crashing.
      description: '',
      isActive: true,
    });
    expect(typeof res.body._id).toBe('string');
    expect(res.body).not.toHaveProperty('__v');
    // Optional columns that are NULL are ABSENT, as they were on a Mongo
    // document that never had the key — not `null`.
    expect(res.body).not.toHaveProperty('icon');
    expect(res.body).not.toHaveProperty('parentTopicId');
  });

  it('overlays a locale translation onto displayName and description', async () => {
    await seedTopic({
      name: 'cooking',
      slug: 'cooking',
      displayName: 'Cooking',
      description: 'Food',
      translations: { es: { displayName: 'Cocina', description: 'Comida' } },
    });

    const res = await requestJson(server, 'GET', '/topics/cooking?locale=es');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: 'Cocina', description: 'Comida' });
  });

  it('rejects an unknown `type` with the value set the column accepts', async () => {
    const res = await requestJson(server, 'GET', '/topics?type=not-a-type');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'INVALID_TYPE' });
    expect(String(res.body.message)).toContain('category, topic, entity');
  });
});

describe('/topics search — Mongo `$text` semantics', () => {
  it('matches on ANY term, not all of them', async () => {
    await seedTopic({ name: 'urban gardening', slug: 'urban-gardening', displayName: 'Urban Gardening' });
    await seedTopic({ name: 'quantum physics', slug: 'quantum-physics', displayName: 'Quantum Physics' });

    const res = await requestJson(server, 'GET', '/topics/search?q=gardening%20physics');

    expect(res.status).toBe(200);
    const names = (res.body.topics as Array<{ name: string }>).map((t) => t.name);
    // `plainto_tsquery` builds AND. Mongo's `$text` is OR, so BOTH rows must
    // come back — an AND port would return zero here and look like "no match".
    expect(names).toEqual(expect.arrayContaining(['urban gardening', 'quantum physics']));
  });

  it('ranks a name hit above a description-only hit (Mongo weights 10 vs 1)', async () => {
    await seedTopic({
      name: 'ceramics',
      slug: 'ceramics',
      displayName: 'Ceramics',
      description: 'unrelated',
    });
    await seedTopic({
      name: 'sculpture',
      slug: 'sculpture',
      displayName: 'Sculpture',
      description: 'about ceramics and clay',
    });

    const results = await topicService.search('ceramics', 10);
    const ranked = results.map((t) => t.name).filter((n) => n === 'ceramics' || n === 'sculpture');

    // Postgres's DEFAULT ts_rank weights order the fields the same way but with
    // different ratios; this is here so ranking with them instead of Mongo's
    // normalized `{1,5,8,10}` is visible rather than silent.
    expect(ranked[0]).toBe('ceramics');
  });

  it('matches an alias, stemmed under the same configuration as the query', async () => {
    await seedTopic({
      name: 'bicycles',
      slug: 'bicycles',
      displayName: 'Bicycles',
      aliases: ['cycling', 'bike riding'],
    });

    const results = await topicService.search('cycling', 10);

    // `array_to_tsvector` alone emits each element as a VERBATIM lexeme with no
    // stemming, so an alias vector built that way can never match a stemmed
    // query term. Re-tokenizing is what makes this pass.
    expect(results.map((t) => t.name)).toContain('bicycles');
  });

  it('returns nothing for a stop-words-only query', async () => {
    await seedTopic({ name: 'anything', slug: 'anything', displayName: 'Anything' });

    expect(await topicService.search('the a of', 10)).toEqual([]);
  });
});

describe('TopicService.findOrCreate', () => {
  it('is idempotent — a second call returns the first row untouched', async () => {
    insertedNames.push('astronomy');

    const first = await topicService.findOrCreate('Astronomy', 'category', 'manual');
    const second = await topicService.findOrCreate('  ASTRONOMY  ', 'topic', 'ai');

    expect(second._id).toBe(first._id);
    // `$setOnInsert` semantics: the existing row keeps its ORIGINAL type and
    // source. An `on conflict do update` would have overwritten both.
    expect(second.type).toBe('category');
    expect(second.source).toBe('manual');
  });
});
