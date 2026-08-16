/**
 * The credential audit trail is append-only, against a REAL Postgres (issue #996).
 *
 * `application_credential_audit_events` declared itself append-only in its own
 * header and was enforced by nothing: no route issued an `UPDATE`, which is not
 * the same as an `UPDATE` being refused. `0043_application_credential_audit_immutability`
 * closes that, and this file is what fails — naming the missing trigger — if it
 * is ever dropped.
 *
 * ## Why these assertions are on the MESSAGE and not on the SQLSTATE
 *
 * The trigger raises `23514`, deliberately, so `@oxyhq/db`'s `isCheckViolation`
 * recognises it. But this table already carries three CHECK constraints that
 * raise `23514` too, so a code-only assertion passes whether or not the trigger
 * fired — and a mutation run on PR #997 measured exactly that, with two cases
 * staying green against a removed trigger because an unrelated CHECK was
 * refusing them. So every refusal below asserts the trigger's own sentence,
 * which names this table and the operation, and each is paired with a positive
 * control showing the SAME values are accepted by an INSERT — so the only thing
 * that can be refusing the UPDATE is the trigger.
 *
 * Every row carries a per-test random identifier, so no assertion depends on a
 * table being empty and a sibling file seeding rows cannot change an answer.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { applicationCredentialAuditEvents } from '../applicationCredentialAuditEvents';
import {
  CREDENTIAL_AUDIT_IMMUTABILITY_DDL,
  CREDENTIAL_AUDIT_IMMUTABILITY_TRIGGER_DDL,
  CREDENTIAL_AUDIT_IMMUTABLE_MESSAGE,
  CREDENTIAL_AUDIT_TABLE,
  CREDENTIAL_AUDIT_TRIGGER,
} from '../applicationCredentialAuditImmutability';
import { applicationCredentials } from '../applicationCredentials';
import { applications } from '../applications';
import { users } from '../users';

/** The hand-written migration this file's subject was installed by. */
const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'drizzle',
  '0043_application_credential_audit_immutability.sql'
);

/** The function the trigger must execute — not the ledger's, not the BYOK trail's. */
const TRIGGER_FUNCTION = 'credential_audit_row_immutable';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/**
 * Every message in a thrown error's `cause` chain. Drizzle wraps the driver's
 * error, so the sentence the trigger raised is never on the outermost one —
 * reading only `String(error)` is how an assertion ends up passing on a failure
 * that came from somewhere else entirely.
 */
function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  return messages;
}

/**
 * Assert a write is refused by the immutability TRIGGER specifically, by the
 * sentence it raises. `rejects.toThrow()` would report a typo'd column or a
 * missing fixture as the guard working.
 */
async function expectRefusedByTrigger(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    const messages = errorMessages(error);
    expect(messages.some((message) => message.includes(CREDENTIAL_AUDIT_IMMUTABLE_MESSAGE))).toBe(
      true
    );
    return;
  }
  throw new Error(
    `expected the write to be refused by ${CREDENTIAL_AUDIT_TRIGGER}, but it succeeded`
  );
}

interface Fixture {
  readonly applicationId: string;
  readonly credentialId: string;
  readonly actorUserId: string;
}

async function insertFixture(): Promise<Fixture> {
  const tag = suffix();

  const [user] = await getDb()
    .insert(users)
    .values({ username: `cred-${tag}`, email: `cred-${tag}@example.test` })
    .returning({ id: users.id });

  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Credential audit ${tag}`, ownerAccountId: user.id })
    .returning({ id: applications.id });

  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: `key-${tag}`,
      // A `public` client: no `token_prefix`, no `secret_hash`, so none of the
      // machine-lane CHECKs on that table are in play here.
      publicKey: `oxy_dk_${tag}`,
      type: 'public',
      environment: 'production',
      scopes: [],
      createdByUserId: user.id,
    })
    .returning({ id: applicationCredentials.id });

  return {
    applicationId: application.id,
    credentialId: credential.id,
    actorUserId: user.id,
  };
}

/**
 * An administrative event, in the only shape all three of this table's CHECKs
 * accept: not `validation_failed`, so `reason` may be NULL and `actor_user_id`
 * may be set.
 */
function auditValues(fixture: Fixture, eventType: 'created' | 'rotated' | 'revoked') {
  return {
    applicationId: fixture.applicationId,
    credentialId: fixture.credentialId,
    eventType,
    actorUserId: fixture.actorUserId,
    environment: 'production',
    metadata: {},
  };
}

/* -------------------------------------------------------------------------- */

describe('the credential audit trail is append-only', () => {
  it('has its immutability trigger installed', async () => {
    const rows = await getDb().execute(sql`
      select t.tgname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname = ${CREDENTIAL_AUDIT_TABLE}
    `);
    expect(rows.map((row) => row.tgname)).toContain(CREDENTIAL_AUDIT_TRIGGER);
  });

  it('executes its OWN function, not the ledger’s or the BYOK trail’s', async () => {
    /*
     * The header argues this table must not depend on
     * `provider_connection_audit_row_immutable()` (whose name would be a lie
     * here, and whose retirement would silently take this guard with it) nor on
     * `billing_ledger_row_immutable()` (whose sentence is about money). This is
     * the case that goes red if someone later "tidies" the three into one.
     */
    const rows = await getDb().execute(sql`
      select p.proname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal
        and c.relname = ${CREDENTIAL_AUDIT_TABLE}
        and t.tgname = ${CREDENTIAL_AUDIT_TRIGGER}
    `);
    expect(rows.map((row) => row.proname)).toEqual([TRIGGER_FUNCTION]);
  });

  it('refuses an UPDATE, naming this table and the operation', async () => {
    const fixture = await insertFixture();
    const [event] = await getDb()
      .insert(applicationCredentialAuditEvents)
      .values(auditValues(fixture, 'created'))
      .returning({ id: applicationCredentialAuditEvents.id });

    await expectRefusedByTrigger(
      getDb()
        .update(applicationCredentialAuditEvents)
        // `rotated` satisfies all three CHECKs on this table exactly as
        // `created` does — see the positive control below.
        .set({ eventType: 'rotated' })
        .where(eq(applicationCredentialAuditEvents.id, event.id))
    );
  });

  it('accepts those same values on an INSERT, so only the trigger refused the UPDATE', async () => {
    /*
     * POSITIVE CONTROL, in the same currency as the measurement. Without it,
     * the refusal above is equally consistent with a CHECK constraint rejecting
     * `rotated` — which is precisely the confusion that made a mutation run on
     * PR #997 report fewer reds than it should have.
     */
    const fixture = await insertFixture();
    const [event] = await getDb()
      .insert(applicationCredentialAuditEvents)
      .values(auditValues(fixture, 'rotated'))
      .returning({ eventType: applicationCredentialAuditEvents.eventType });
    expect(event.eventType).toBe('rotated');
  });

  it('refuses an UPDATE that changes nothing', async () => {
    /*
     * `BEFORE UPDATE` fires per row, not per changed column, and this guard is
     * deliberately whole-row rather than column-scoped like
     * `inference_model_revision_identity_immutable`. A no-op UPDATE is the
     * cheapest way to state that: there is no "harmless edit" carve-out for a
     * future writer to aim at.
     */
    const fixture = await insertFixture();
    const [event] = await getDb()
      .insert(applicationCredentialAuditEvents)
      .values(auditValues(fixture, 'created'))
      .returning({ id: applicationCredentialAuditEvents.id });

    await expectRefusedByTrigger(
      getDb()
        .update(applicationCredentialAuditEvents)
        .set({ metadata: {} })
        .where(eq(applicationCredentialAuditEvents.id, event.id))
    );
  });

  it('refuses an UPDATE that would rewrite who performed the transition', async () => {
    /*
     * The row this table exists for. Reassigning `actor_user_id` is the edit
     * someone makes to move a revocation onto another member's name, and it
     * violates no CHECK — `no_actor_on_failure_check` only constrains
     * `validation_failed` rows.
     */
    const fixture = await insertFixture();
    const other = await insertFixture();
    const [event] = await getDb()
      .insert(applicationCredentialAuditEvents)
      .values(auditValues(fixture, 'revoked'))
      .returning({ id: applicationCredentialAuditEvents.id });

    await expectRefusedByTrigger(
      getDb()
        .update(applicationCredentialAuditEvents)
        .set({ actorUserId: other.actorUserId })
        .where(eq(applicationCredentialAuditEvents.id, event.id))
    );
  });

  it('permits a DELETE, because the retention sweep depends on it', async () => {
    /*
     * This is an ASSERTION, not an omission. `db/expiry.ts` sweeps this table at
     * two years and `validation_failed` rows accrue for as long as a
     * misconfigured client retries a dead key, so a DELETE guard would fail that
     * sweep on every run. If someone later widens the trigger to
     * `BEFORE UPDATE OR DELETE`, this case is what says so — before the sweep
     * starts failing in production instead.
     */
    const fixture = await insertFixture();
    const [event] = await getDb()
      .insert(applicationCredentialAuditEvents)
      .values(auditValues(fixture, 'created'))
      .returning({ id: applicationCredentialAuditEvents.id });

    await getDb()
      .delete(applicationCredentialAuditEvents)
      .where(eq(applicationCredentialAuditEvents.id, event.id));

    const remaining = await getDb()
      .select({ id: applicationCredentialAuditEvents.id })
      .from(applicationCredentialAuditEvents)
      .where(eq(applicationCredentialAuditEvents.id, event.id));
    expect(remaining).toHaveLength(0);
  });

  it('lets the application’s own deletion cascade the trail away', async () => {
    /*
     * The other half of why this is `BEFORE UPDATE` only: `application_id` is
     * `ON DELETE CASCADE`, so a DELETE guard would turn deleting an application
     * into a trigger failure rather than a cascade.
     */
    const fixture = await insertFixture();
    await getDb()
      .insert(applicationCredentialAuditEvents)
      .values(auditValues(fixture, 'created'));

    await getDb().delete(applications).where(eq(applications.id, fixture.applicationId));

    const remaining = await getDb()
      .select({ id: applicationCredentialAuditEvents.id })
      .from(applicationCredentialAuditEvents)
      .where(eq(applicationCredentialAuditEvents.applicationId, fixture.applicationId));
    expect(remaining).toHaveLength(0);
  });
});

describe('the migration and the schema agree on the DDL', () => {
  /*
   * The schema module claims to be the authoritative copy "so a regeneration of
   * the table migration has something to restore this file from". That claim
   * rots the moment the two drift, and nothing else in this repository compares
   * them — the three older immutability modules make the same claim with no
   * check behind it.
   */
  const migration = readFileSync(MIGRATION_PATH, 'utf8');

  it('carries the function text the schema declares authoritative', () => {
    expect(migration).toContain(CREDENTIAL_AUDIT_IMMUTABILITY_DDL);
  });

  it('carries the trigger text the schema declares authoritative', () => {
    expect(migration).toContain(CREDENTIAL_AUDIT_IMMUTABILITY_TRIGGER_DDL);
  });

  it('declares a deploy phase, so the deploy knows which side it belongs on', () => {
    expect(migration).toContain('-- oxy:deploy-phase=pre');
  });

  it('guards UPDATE and NOT DELETE', () => {
    // Stated positively AND negatively: the retention sweep in `db/expiry.ts`
    // breaks the day someone widens this, and the schema header is the only
    // other place that reasoning is written down.
    expect(migration).toContain(`BEFORE UPDATE ON ${CREDENTIAL_AUDIT_TABLE}`);
    expect(migration).not.toContain(`BEFORE UPDATE OR DELETE ON ${CREDENTIAL_AUDIT_TABLE}`);
  });
});
