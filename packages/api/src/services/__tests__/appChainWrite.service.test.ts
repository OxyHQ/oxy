/**
 * The write path an app uses to append to a PERSON's chain, against a REAL
 * Postgres and with a REAL custodial signature.
 *
 * Two things are load-bearing here and both are security boundaries, so both are
 * tested with the fixture that tells a correct implementation from a lax one
 * rather than with the shape that happens to pass:
 *
 *  - **The namespace grant is matched on a DOT boundary.** A bare `startsWith`
 *    would let a grant of `app.mention.` authorize `app.mentionother.feed.post`
 *    — a neighbouring app's namespace, on every account the credential can name.
 *    Every case below that could pass under `startsWith` is paired with one that
 *    could not.
 *  - **An application with no grant writes nothing.** The empty list is the
 *    default every existing row got at migration time, so if it authorized
 *    everything the deploy itself would be the breach.
 */

import { randomUUID } from 'node:crypto';
import { generateSecp256k1KeyPair } from '@oxyhq/protocol/secp256k1';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { signedRecords } from '../../db/schema/signedRecords';
import { users } from '../../db/schema/users';
import { OXY_DID } from '../did.service';
import { appendAppRecord, collectionIsWithinNamespaces } from '../appChainWrite.service';


let restoreEnv: { priv?: string; pub?: string };

beforeAll(async () => {
  await connectPostgres();
  restoreEnv = { priv: process.env.OXY_PRIVATE_KEY, pub: process.env.OXY_PUBLIC_KEY };
  const pair = generateSecp256k1KeyPair();
  process.env.OXY_PRIVATE_KEY = pair.privateKey;
  process.env.OXY_PUBLIC_KEY = pair.publicKey;
});

afterAll(async () => {
  process.env.OXY_PRIVATE_KEY = restoreEnv.priv;
  process.env.OXY_PUBLIC_KEY = restoreEnv.pub;
  await closePostgres();
});

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

/** An application row carrying `chainNamespaces`. Owns its own account, as the schema requires. */
async function application(chainNamespaces: string[]): Promise<string> {
  const ownerAccountId = await account();
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `test-${randomUUID()}`, ownerAccountId, chainNamespaces })
    .returning({ id: applications.id });
  return row.id;
}

describe('collectionIsWithinNamespaces', () => {
  it('matches a collection under a granted namespace', () => {
    expect(collectionIsWithinNamespaces('app.mention.feed.post', ['app.mention.'])).toBe(true);
  });

  it('refuses a NEIGHBOURING namespace that shares the prefix as a string', () => {
    // The case a bare `startsWith` gets wrong, and the reason this function
    // exists rather than an inline `some(s => c.startsWith(s))`.
    expect(collectionIsWithinNamespaces('app.mentionother.feed.post', ['app.mention.'])).toBe(false);
  });

  it('treats a grant written without its trailing dot the same way', () => {
    // A hand-entered grant must not silently widen to the neighbour.
    expect(collectionIsWithinNamespaces('app.mention.feed.post', ['app.mention'])).toBe(true);
    expect(collectionIsWithinNamespaces('app.mentionother.feed.post', ['app.mention'])).toBe(false);
  });

  it('refuses the bare prefix itself, which names no collection', () => {
    expect(collectionIsWithinNamespaces('app.mention.', ['app.mention.'])).toBe(false);
  });

  it('authorizes NOTHING for an empty grant', () => {
    expect(collectionIsWithinNamespaces('app.mention.feed.post', [])).toBe(false);
    expect(collectionIsWithinNamespaces('anything.at.all', [])).toBe(false);
  });

  it('accepts any one of several grants', () => {
    const grants = ['app.syra.', 'app.mention.'];
    expect(collectionIsWithinNamespaces('app.syra.listen', grants)).toBe(true);
    expect(collectionIsWithinNamespaces('app.mention.feed.like', grants)).toBe(true);
    expect(collectionIsWithinNamespaces('app.mercaria.item', grants)).toBe(false);
  });
});

describe('appendAppRecord', () => {
  it('appends under the subject’s chain, issued by Oxy', async () => {
    const [appId, userId] = [await application(['app.mention.']), await account()];

    const result = await appendAppRecord({
      appId,
      oxyUserId: userId,
      collection: 'app.mention.feed.post',
      rkey: 'post_1',
      record: { text: 'hello' },
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;

    const [row] = await getDb()
      .select({ nsid: signedRecords.nsid, type: signedRecords.type, envelope: signedRecords.envelope })
      .from(signedRecords)
      .where(eq(signedRecords.recordId, result.record.recordId));

    expect(row.nsid).toBe('app.mention.feed.post');
    expect(row.type).toBe('app_record');
    // Oxy is the issuer; the app never appears as one.
    expect(row.envelope.issuer).toBe(OXY_DID);
    expect(result.record.verified).toBe(true);
    expect(result.record.seq).toBe(0);
  });

  it('chains a second record onto the first', async () => {
    const [appId, userId] = [await application(['app.mention.']), await account()];
    const first = await appendAppRecord({
      appId, oxyUserId: userId, collection: 'app.mention.feed.post', rkey: 'a', record: { text: '1' },
    });
    const second = await appendAppRecord({
      appId, oxyUserId: userId, collection: 'app.mention.feed.post', rkey: 'b', record: { text: '2' },
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.record.seq).toBe(1);
    expect(second.record.envelope.prev).toBe(first.record.recordId);
  });

  it('refuses a collection outside the application’s namespace', async () => {
    const [appId, userId] = [await application(['app.mention.']), await account()];

    const result = await appendAppRecord({
      appId, oxyUserId: userId, collection: 'app.syra.listen', rkey: 'x', record: {},
    });

    expect(result).toEqual({ ok: false, reason: 'namespace_forbidden', detail: 'app.syra.listen' });
  });

  it('refuses everything for an application with no grant', async () => {
    // The state every row got from the migration's default.
    const [appId, userId] = [await application([]), await account()];

    const result = await appendAppRecord({
      appId, oxyUserId: userId, collection: 'app.mention.feed.post', rkey: 'x', record: {},
    });

    expect(result).toMatchObject({ ok: false, reason: 'namespace_forbidden' });
  });

  it('refuses an application that does not exist', async () => {
    const result = await appendAppRecord({
      appId: randomUUID(), oxyUserId: await account(), collection: 'app.mention.feed.post', rkey: 'x', record: {},
    });

    expect(result).toMatchObject({ ok: false, reason: 'unknown_application' });
  });

  it('refuses rather than dropping the write when the custodial key is unset', async () => {
    const [appId, userId] = [await application(['app.mention.']), await account()];
    const saved = process.env.OXY_PRIVATE_KEY;
    delete process.env.OXY_PRIVATE_KEY;
    try {
      const result = await appendAppRecord({
        appId, oxyUserId: userId, collection: 'app.mention.feed.post', rkey: 'x', record: {},
      });
      expect(result).toEqual({ ok: false, reason: 'signing_disabled' });
    } finally {
      process.env.OXY_PRIVATE_KEY = saved;
    }
  });

  it('writes nothing at all when it refuses', async () => {
    const [appId, userId] = [await application(['app.mention.']), await account()];
    await appendAppRecord({
      appId, oxyUserId: userId, collection: 'app.syra.listen', rkey: 'x', record: {},
    });

    const rows = await getDb()
      .select({ id: signedRecords.id })
      .from(signedRecords)
      .where(eq(signedRecords.userId, userId));
    expect(rows).toHaveLength(0);
  });
});
