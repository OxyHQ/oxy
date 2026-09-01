/**
 * `resolveApplicationIdFromClientId` — clientId → active application, against a
 * REAL Postgres.
 *
 * ## The guarantee this file exists for
 *
 * **The helper must RETURN NULL when a clientId does not resolve, and must never
 * throw — in either id shape.**
 *
 * The Mongoose version resolved in two hops, and the second one CAST:
 *
 * ```ts
 * const credential = await ApplicationCredential.findOne({ publicKey: clientId });
 * const application = await Application.findById(credential.applicationId);
 * ```
 *
 * `findById` throws a `CastError` on anything that is not 24-char hex, so for an
 * application whose id is the uuid v7 `generatedId()` mints — every application
 * registered since the cutover — this did not return null: it THREW, out of a
 * helper whose entire contract is "null when it does not resolve".
 * `POST /notifications/push-token` answers that with its 500 branch instead of
 * the documented 400, and `emailPushDelivery` loses the whole inbox push for the
 * identity. Neither caller could tell the difference from a genuine outage.
 *
 * There was no suite here at all, so nothing was asserting the contract. The
 * first case below asserts the seeded application id is NOT 24-hex, so the
 * post-cutover cases cannot pass vacuously.
 *
 * Nothing is mocked. The credentials, the applications and the rotation-grace
 * clock are real; `isCredentialUsable` is the same predicate OAuth authorize,
 * OAuth token and the service-token mint use.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  APPLICATION_CREDENTIAL_STATUSES,
  applicationCredentials,
} from '../../db/schema/applicationCredentials';
import { APPLICATION_STATUSES, applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { resolveApplicationIdFromClientId } from '../resolveApplicationFromClientId';

type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
type CredentialStatus = (typeof APPLICATION_CREDENTIAL_STATUSES)[number];

const HEX24 = /^[0-9a-f]{24}$/i;
const HOUR_MS = 60 * 60 * 1000;

let ownerAccountId: string;

/** A unique OAuth `client_id`; `application_credentials.public_key` is UNIQUE. */
function clientId(): string {
  return `oxy_dk_${randomUUID().replace(/-/g, '')}`;
}

/**
 * A POST-cutover application: the id is omitted so `generatedId()` mints the
 * uuid v7 every new row receives. Nothing here invents that shape.
 */
async function seedApplication(status: ApplicationStatus = 'active'): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ownerAccountId, status })
    .returning({ id: applications.id });
  return row.id;
}

/** A PRE-cutover application, whose 24-char ObjectId hex is preserved verbatim. */
async function seedLegacyApplication(status: ApplicationStatus = 'active'): Promise<string> {
  const id = randomBytes(12).toString('hex');
  await getDb()
    .insert(applications)
    .values({ id, name: `App ${randomUUID()}`, ownerAccountId, status });
  return id;
}

async function seedCredential(
  applicationId: string,
  options: { status?: CredentialStatus; expiresAt?: Date } = {},
): Promise<string> {
  const publicKey = clientId();
  await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: 'service',
      type: 'service',
      environment: 'production',
      publicKey,
      status: options.status ?? 'active',
      expiresAt: options.expiresAt ?? null,
    });
  return publicKey;
}

beforeAll(async () => {
  await connectPostgres();
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  ownerAccountId = owner.id;
});

afterAll(async () => {
  await closePostgres();
});

describe('the application id format must not decide whether a clientId resolves', () => {
  it('resolves a POST-CUTOVER application, whose id is not 24-hex', async () => {
    const applicationId = await seedApplication();
    const publicKey = await seedCredential(applicationId);

    // The premise every case below rests on. Without it, reinstating a
    // `findById`-style 24-hex cast would leave this suite green.
    expect(applicationId).not.toMatch(HEX24);

    // The Mongoose version THREW a CastError here rather than resolving.
    await expect(resolveApplicationIdFromClientId(publicKey)).resolves.toBe(applicationId);
  });

  it('still resolves a PRE-cutover application, whose id is 24-hex', async () => {
    const applicationId = await seedLegacyApplication();
    const publicKey = await seedCredential(applicationId);
    expect(applicationId).toMatch(HEX24);

    await expect(resolveApplicationIdFromClientId(publicKey)).resolves.toBe(applicationId);
  });

  it('returns a plain string id, not an ObjectId wrapper', async () => {
    // Both call sites pass the result straight into a write; the value has to
    // survive being a uuid, so the contract is the id itself.
    const applicationId = await seedApplication();
    const publicKey = await seedCredential(applicationId);

    const resolved = await resolveApplicationIdFromClientId(publicKey);

    expect(typeof resolved).toBe('string');
    expect(resolved).toBe(applicationId);
  });
});

describe('resolveApplicationIdFromClientId — what does not resolve', () => {
  it('returns null for a clientId no credential carries', async () => {
    await expect(resolveApplicationIdFromClientId(clientId())).resolves.toBeNull();
  });

  it('returns null for a malformed clientId, without throwing', async () => {
    // No shape precheck: the value is a bound parameter against a `text` column,
    // so a malformed clientId is one that matches no row.
    await expect(resolveApplicationIdFromClientId('not-a-client-id')).resolves.toBeNull();
    await expect(resolveApplicationIdFromClientId('')).resolves.toBeNull();
  });

  it('returns null for a REVOKED credential, even inside a future expiry', async () => {
    const applicationId = await seedApplication();
    const publicKey = await seedCredential(applicationId, {
      status: 'revoked',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    await expect(resolveApplicationIdFromClientId(publicKey)).resolves.toBeNull();
  });

  it('returns null for an ACTIVE credential whose expiry has passed', async () => {
    const applicationId = await seedApplication();
    const publicKey = await seedCredential(applicationId, {
      status: 'active',
      expiresAt: new Date(Date.now() - HOUR_MS),
    });

    await expect(resolveApplicationIdFromClientId(publicKey)).resolves.toBeNull();
  });

  it('returns null for a DEPRECATED credential with no grace expiry', async () => {
    // A deprecated credential without an explicit future grace is disabled —
    // rotation always sets one, so its absence means the row is not usable.
    const applicationId = await seedApplication();
    const publicKey = await seedCredential(applicationId, { status: 'deprecated' });

    await expect(resolveApplicationIdFromClientId(publicKey)).resolves.toBeNull();
  });

  it('returns null for a DEPRECATED credential whose grace has elapsed', async () => {
    const applicationId = await seedApplication();
    const publicKey = await seedCredential(applicationId, {
      status: 'deprecated',
      expiresAt: new Date(Date.now() - HOUR_MS),
    });

    await expect(resolveApplicationIdFromClientId(publicKey)).resolves.toBeNull();
  });

  it.each<ApplicationStatus>(['suspended', 'deleted', 'pending_review'])(
    'returns null when the owning application is %s, however healthy the credential',
    async (status) => {
      const applicationId = await seedApplication(status);
      const publicKey = await seedCredential(applicationId);

      await expect(resolveApplicationIdFromClientId(publicKey)).resolves.toBeNull();
    },
  );
});

describe('resolveApplicationIdFromClientId — the rotation grace still resolves', () => {
  it('resolves a DEPRECATED credential inside its rotation grace', async () => {
    // The 7-day grace is what keeps a rotated secret working; dropping it here
    // would silently break every install that has not re-registered yet.
    const applicationId = await seedApplication();
    const publicKey = await seedCredential(applicationId, {
      status: 'deprecated',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    await expect(resolveApplicationIdFromClientId(publicKey)).resolves.toBe(applicationId);
  });

  it('resolves an ACTIVE credential with a future expiry', async () => {
    const applicationId = await seedApplication();
    const publicKey = await seedCredential(applicationId, {
      status: 'active',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

    await expect(resolveApplicationIdFromClientId(publicKey)).resolves.toBe(applicationId);
  });

  it('resolves each of an application’s credentials to the SAME application', async () => {
    const applicationId = await seedApplication();
    const first = await seedCredential(applicationId);
    const second = await seedCredential(applicationId);

    await expect(resolveApplicationIdFromClientId(first)).resolves.toBe(applicationId);
    await expect(resolveApplicationIdFromClientId(second)).resolves.toBe(applicationId);
  });

  it('never crosses applications: a clientId resolves only to its own', async () => {
    const mine = await seedApplication();
    const theirs = await seedApplication();
    const myKey = await seedCredential(mine);
    const theirKey = await seedCredential(theirs);

    await expect(resolveApplicationIdFromClientId(myKey)).resolves.toBe(mine);
    await expect(resolveApplicationIdFromClientId(theirKey)).resolves.toBe(theirs);
  });
});
