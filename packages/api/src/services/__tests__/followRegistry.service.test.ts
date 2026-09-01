/**
 * The tenancy property, as tests.
 *
 * The registry's whole job is keeping applications apart. 0016 proved a kind
 * lives in the namespace it claims; what these prove is that the claimant owns
 * that namespace at all — the difference between "`mercaria.store` is well
 * formed" and "only Mercaria may say what a store is".
 *
 * The rest is idempotency, which matters because every one of these calls runs
 * on an application's boot: a registration that fails the second time is a
 * deploy that fails the second time.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { followNamespaces } from '../../db/schema/followNamespaces';
import { followTargetKinds } from '../../db/schema/followTargetKinds';
import { followTargets } from '../../db/schema/followTargets';
import { users } from '../../db/schema/users';
import type { FollowCapability } from '../followCapability.service';
import {
  claimNamespace,
  ensureTarget,
  getKindCapabilities,
  listKindsForApplication,
  registerKind,
  releaseNamespace,
} from '../followRegistry.service';

let userId: string;
let appA: string;
let appB: string;
let counter = 0;

const unique = (prefix: string) => `${prefix}${(counter += 1)}`;

function capabilityFor(applicationId: string): FollowCapability {
  return {
    userId,
    applicationId,
    grantId: null as unknown as string,
    scopes: ['follow-targets:register'],
    sessionId: 'session',
  };
}

async function makeApplication(name: string) {
  const [app] = await getDb()
    .insert(applications)
    .values({ name, status: 'active', ownerAccountId: userId })
    .returning({ id: applications.id });
  return app.id;
}

/** Claim a fresh namespace for `appA` and return it. */
async function ownedNamespace(): Promise<string> {
  const ns = unique('appns');
  const result = await claimNamespace({ capability: capabilityFor(appA), namespace: ns });
  expect(result.ok).toBe(true);
  return ns;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  const [user] = await getDb().insert(users).values({}).returning({ id: users.id });
  userId = user.id;
  appA = await makeApplication('App A');
  appB = await makeApplication('App B');
});

describe('claiming a namespace', () => {
  it('grants an unclaimed namespace to the application that asks', async () => {
    const ns = unique('appns');
    const result = await claimNamespace({ capability: capabilityFor(appA), namespace: ns });

    expect(result).toMatchObject({ ok: true, value: { namespace: ns, created: true } });
    const [row] = await getDb()
      .select({ applicationId: followNamespaces.applicationId })
      .from(followNamespaces)
      .where(eq(followNamespaces.namespace, ns));
    expect(row.applicationId).toBe(appA);
  });

  it('is idempotent for the holder', async () => {
    // Applications register on boot. One that fails the second time is a deploy
    // that fails the second time.
    const ns = await ownedNamespace();
    const again = await claimNamespace({ capability: capabilityFor(appA), namespace: ns });
    expect(again).toMatchObject({ ok: true, value: { created: false } });
  });

  it('refuses a namespace another application holds', async () => {
    const ns = await ownedNamespace();
    expect(await claimNamespace({ capability: capabilityFor(appB), namespace: ns })).toEqual({
      ok: false,
      reason: 'namespace_taken',
    });
  });

  it('never re-grants the platform’s own namespace', async () => {
    // `oxy` is unowned by design. Rows across the whole graph already name
    // kinds inside it, so letting an application adopt that identity would
    // silently change what those rows mean.
    expect(await claimNamespace({ capability: capabilityFor(appA), namespace: 'oxy' })).toEqual({
      ok: false,
      reason: 'namespace_taken',
    });
  });

  it('refuses a namespace that is not a single segment', async () => {
    for (const bad of ['mercaria.shop', '', '9lives', 'a-b', 'a b']) {
      expect(await claimNamespace({ capability: capabilityFor(appA), namespace: bad })).toEqual({
        ok: false,
        reason: 'invalid_namespace',
      });
    }
  });

  it('normalizes case rather than rejecting it', async () => {
    // `Mercaria` and `mercaria` naming two namespaces would be a tenancy bug: a
    // kind's prefix is matched as text, so one application would end up owning
    // the name the other believes it registered.
    const ns = unique('appns');
    await claimNamespace({ capability: capabilityFor(appA), namespace: ns.toUpperCase() });

    const [row] = await getDb()
      .select({ namespace: followNamespaces.namespace })
      .from(followNamespaces)
      .where(eq(followNamespaces.namespace, ns));
    expect(row).toBeDefined();
    // And the same name in another case is then recognised as taken.
    expect(await claimNamespace({ capability: capabilityFor(appB), namespace: ns })).toEqual({
      ok: false,
      reason: 'namespace_taken',
    });
  });
});

describe('releasing a namespace', () => {
  it('lets the holder release an empty namespace, and another application claim it after', async () => {
    // The recoverable-mistake case: a development build using a fallback client
    // id claims the name, and without this it is bound to the wrong
    // application permanently.
    const ns = await ownedNamespace();

    expect(await releaseNamespace({ capability: capabilityFor(appA), namespace: ns })).toEqual({
      ok: true,
      value: { namespace: ns, released: true },
    });
    expect(await claimNamespace({ capability: capabilityFor(appB), namespace: ns })).toMatchObject({
      ok: true,
      value: { created: true },
    });
  });

  it('refuses to release a namespace that has kinds in it', async () => {
    // The original guarantee, intact: targets and relationships across the
    // graph derive their meaning from a kind, and a kind from its namespace.
    const ns = await ownedNamespace();
    await registerKind({ capability: capabilityFor(appA), kind: `${ns}.store` });

    expect(await releaseNamespace({ capability: capabilityFor(appA), namespace: ns })).toEqual({
      ok: false,
      reason: 'namespace_in_use',
    });
    // And it is still held afterwards.
    expect(await claimNamespace({ capability: capabilityFor(appB), namespace: ns })).toEqual({
      ok: false,
      reason: 'namespace_taken',
    });
  });

  it('refuses to release a namespace another application holds', async () => {
    // Not a way to take a name from somebody who has not used it yet.
    const ns = await ownedNamespace();
    expect(await releaseNamespace({ capability: capabilityFor(appB), namespace: ns })).toEqual({
      ok: false,
      reason: 'namespace_not_owned',
    });
  });

  it('can never release the platform namespace', async () => {
    // `oxy` is held by no application row, so no capability matches its holder.
    expect(await releaseNamespace({ capability: capabilityFor(appA), namespace: 'oxy' })).toEqual({
      ok: false,
      reason: 'namespace_not_owned',
    });
  });

  it('succeeds when there was nothing to release', async () => {
    expect(
      await releaseNamespace({ capability: capabilityFor(appA), namespace: unique('gone') })
    ).toMatchObject({ ok: true, value: { released: false } });
  });
});

describe('registering a kind', () => {
  it('registers inside a namespace the caller owns', async () => {
    const ns = await ownedNamespace();
    expect(
      await registerKind({ capability: capabilityFor(appA), kind: `${ns}.store` })
    ).toMatchObject({ ok: true, value: { kind: `${ns}.store` } });
  });

  it('refuses a kind in another application’s namespace', async () => {
    // The property the whole table exists for: App B cannot define — or later
    // redefine — what a thing in App A's namespace means.
    const ns = await ownedNamespace();
    expect(await registerKind({ capability: capabilityFor(appB), kind: `${ns}.store` })).toEqual({
      ok: false,
      reason: 'namespace_not_owned',
    });
  });

  it('refuses a kind whose namespace nobody claimed', async () => {
    expect(
      await registerKind({ capability: capabilityFor(appA), kind: 'unclaimed99.thing' })
    ).toEqual({ ok: false, reason: 'namespace_not_owned' });
  });

  it('refuses to let a second application overwrite an existing kind', async () => {
    // Caught by the namespace check, before the write is even attempted.
    const ns = await ownedNamespace();
    await registerKind({
      capability: capabilityFor(appA),
      kind: `${ns}.store`,
      capabilities: { reverse: 'private' },
    });

    expect(
      await registerKind({
        capability: capabilityFor(appB),
        kind: `${ns}.store`,
        capabilities: { reverse: 'public' },
      })
    ).toEqual({ ok: false, reason: 'namespace_not_owned' });

    expect((await getKindCapabilities(`${ns}.store`))?.capabilities).toEqual({
      reverse: 'private',
    });
  });

  it('refuses even the namespace owner a kind another application registered', async () => {
    // The gap 0018 leaves behind: it granted each existing namespace to
    // whoever registered its FIRST kind, so a namespace two applications had
    // both written into comes out owned by one of them with the other's kind
    // rows still inside. Owning the namespace must not silently mean owning
    // those. Set up by writing the row directly, because the service — by
    // design — has no path that produces this state.
    const ns = await ownedNamespace();
    await getDb()
      .insert(followTargetKinds)
      .values({ kind: `${ns}.legacy`, namespace: ns, applicationId: appB });

    expect(
      await registerKind({
        capability: capabilityFor(appA),
        kind: `${ns}.legacy`,
        capabilities: { reverse: 'public' },
      })
    ).toEqual({ ok: false, reason: 'kind_not_owned' });

    // And the other application's declaration is untouched.
    expect((await getKindCapabilities(`${ns}.legacy`))?.capabilities).toEqual({});
  });

  it('lets the owner update the capabilities it declared', async () => {
    const ns = await ownedNamespace();
    await registerKind({ capability: capabilityFor(appA), kind: `${ns}.store`, label: 'Store' });
    await registerKind({
      capability: capabilityFor(appA),
      kind: `${ns}.store`,
      capabilities: { verb: 'subscribe', reverse: 'aggregate' },
    });

    const read = await getKindCapabilities(`${ns}.store`);
    expect(read).toMatchObject({
      // Not passed the second time, so not cleared — a partial update must not
      // erase what it did not mention.
      label: 'Store',
      capabilities: { verb: 'subscribe', reverse: 'aggregate' },
    });
  });

  it('refuses a nested or malformed kind', async () => {
    const ns = await ownedNamespace();
    // Nesting is the interesting one: `a.b` reading as its own namespace is
    // really a second owner for `a`.
    for (const bad of [`${ns}.shop.store`, ns, `${ns}.`, `.store`, `${ns}.a b`]) {
      expect(await registerKind({ capability: capabilityFor(appA), kind: bad })).toEqual({
        ok: false,
        reason: 'invalid_kind',
      });
    }
  });

  it('lists only the calling application’s kinds', async () => {
    const ns = await ownedNamespace();
    await registerKind({ capability: capabilityFor(appA), kind: `${ns}.store` });

    expect((await listKindsForApplication(appA)).map((k) => k.kind)).toContain(`${ns}.store`);
    expect((await listKindsForApplication(appB)).map((k) => k.kind)).not.toContain(`${ns}.store`);
  });
});

describe('ensuring a target', () => {
  it('registers a target the first time and resolves it after', async () => {
    const ns = await ownedNamespace();
    await registerKind({ capability: capabilityFor(appA), kind: `${ns}.store` });
    const uri = unique('https://mercaria.example/stores/');

    const first = await ensureTarget({
      capability: capabilityFor(appA),
      uri,
      kind: `${ns}.store`,
    });
    const second = await ensureTarget({
      capability: capabilityFor(appA),
      uri,
      kind: `${ns}.store`,
    });

    expect(first).toMatchObject({ ok: true, value: { created: true } });
    expect(second).toMatchObject({ ok: true, value: { created: false } });
    if (!first.ok || !second.ok) throw new Error('expected both to succeed');
    // ONE row, which is what makes two applications describing the same thing
    // arrive at one relationship per user rather than one per app.
    expect(second.value.id).toBe(first.value.id);
  });

  it('gives two applications the same row for the same URI', async () => {
    const ns = await ownedNamespace();
    await registerKind({ capability: capabilityFor(appA), kind: `${ns}.store` });
    const uri = unique('https://mercaria.example/stores/');

    const a = await ensureTarget({ capability: capabilityFor(appA), uri, kind: `${ns}.store` });
    const b = await ensureTarget({ capability: capabilityFor(appB), uri, kind: `${ns}.store` });
    if (!a.ok || !b.ok) throw new Error('expected both to succeed');
    expect(b.value.id).toBe(a.value.id);
  });

  it('lets only the providing application refresh the metadata snapshot', async () => {
    // A second application passing its own idea of the name would make the
    // display flip depending on which app last looked at it.
    const ns = await ownedNamespace();
    await registerKind({ capability: capabilityFor(appA), kind: `${ns}.store` });
    const uri = unique('https://mercaria.example/stores/');
    await ensureTarget({
      capability: capabilityFor(appA),
      uri,
      kind: `${ns}.store`,
      metadata: { name: 'Real name' },
    });

    await ensureTarget({
      capability: capabilityFor(appB),
      uri,
      kind: `${ns}.store`,
      metadata: { name: 'Impostor' },
    });

    const [row] = await getDb()
      .select({ metadata: followTargets.metadataSnapshot })
      .from(followTargets)
      .where(eq(followTargets.canonicalUri, uri));
    expect(row.metadata).toEqual({ name: 'Real name' });
  });

  it('refuses a target of a kind nobody registered', async () => {
    expect(
      await ensureTarget({
        capability: capabilityFor(appA),
        uri: unique('https://x.example/a'),
        kind: 'nobody99.registered',
      })
    ).toEqual({ ok: false, reason: 'unknown_kind' });
  });

  it('refuses a URI that is not absolute', async () => {
    const ns = await ownedNamespace();
    await registerKind({ capability: capabilityFor(appA), kind: `${ns}.store` });
    for (const bad of ['', '/stores/1', 'stores/1', ' ']) {
      expect(
        await ensureTarget({ capability: capabilityFor(appA), uri: bad, kind: `${ns}.store` })
      ).toEqual({ ok: false, reason: 'invalid_uri' });
    }
  });

  it('refuses metadata past the bound', async () => {
    const ns = await ownedNamespace();
    await registerKind({ capability: capabilityFor(appA), kind: `${ns}.store` });
    expect(
      await ensureTarget({
        capability: capabilityFor(appA),
        uri: unique('https://mercaria.example/stores/'),
        kind: `${ns}.store`,
        metadata: { blob: 'x'.repeat(5000) },
      })
    ).toEqual({ ok: false, reason: 'metadata_too_large' });
  });

  it('derives localUserId for oxy.user from the canonical URI', async () => {
    const [targetUser] = await getDb().insert(users).values({}).returning({ id: users.id });
    const uri = `https://oxy.so/users/${targetUser.id}`;

    const result = await ensureTarget({
      capability: capabilityFor(appA),
      uri,
      kind: 'oxy.user',
    });

    expect(result).toMatchObject({ ok: true, value: { created: true } });
    if (!result.ok) throw new Error('expected success');
    const [row] = await getDb()
      .select({ localUserId: followTargets.localUserId })
      .from(followTargets)
      .where(eq(followTargets.id, result.value.id));
    expect(row.localUserId).toBe(targetUser.id);
  });

  it('refuses a mismatched localUserId for oxy.user', async () => {
    const [targetUser] = await getDb().insert(users).values({}).returning({ id: users.id });
    const uri = `https://oxy.so/users/${targetUser.id}`;

    expect(
      await ensureTarget({
        capability: capabilityFor(appA),
        uri,
        kind: 'oxy.user',
        localUserId: userId,
      })
    ).toEqual({ ok: false, reason: 'local_user_mismatch' });
  });
});

describe('the database keeps the rule even if the service stops', () => {
  it('refuses a kind whose namespace has no row at all', async () => {
    // The service checks ownership; this checks that a migration, a repair
    // script or a future service cannot walk past it.
    await expect(
      getDb()
        .insert(followTargetKinds)
        .values({ kind: 'ghost99.thing', namespace: 'ghost99', applicationId: appA })
    ).rejects.toThrow();
  });
});
