/** PostgreSQL is the final write barrier for agency audit and limit JSON. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';

const CHECK_VIOLATION = '23514';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

async function rejected(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected PostgreSQL to reject the agency payload shape.');
}

async function insertDelegationValue(value: unknown): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`create temporary table agency_limit_test
      (like delegation_limits including all) on commit drop`);
    await tx.execute(sql`insert into agency_limit_test
      (id, grant_id, tool, key, value, created_at)
      values (${randomUUID()}, 'grant-test', 'searchEmails', 'limit', ${JSON.stringify(value)}::jsonb, now())`);
  });
}

async function insertAuthorizationLimits(limits: unknown): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`create temporary table agency_authorization_test
      (like capability_execution_authorizations including all) on commit drop`);
    await tx.execute(sql`insert into agency_authorization_test (
      id, kind, requester_account_id, owner_account_id, coordinator_application_id,
      coordinator_credential_id, actor_type, resource_app, effective_account_id,
      resource_type, resource_key, tool, run_id, maximum_autonomy, limits,
      expires_at, created_at, updated_at
    ) values (
      ${randomUUID()}, 'direct_request', 'requester-test', 'owner-test', 'app-test',
      'credential-test', 'alia', 'inbox', 'account-test', 'mailbox', 'mailbox-test',
      'searchEmails', 'run-test', 'execute_on_request', ${JSON.stringify(limits)}::jsonb,
      now() + interval '5 minutes', now(), now()
    )`);
  });
}

async function insertAuditEvent(event: unknown): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`create temporary table agency_audit_test
      (like capability_audit_events including all) on commit drop`);
    await tx.execute(sql`insert into agency_audit_test
      (id, event_key, effective_account_key, run_key, event, created_at)
      values (${randomUUID()}, ${randomUUID()}, 'account-test', 'run-test', ${JSON.stringify(event)}::jsonb, now())`);
  });
}

describe('agency JSON payload bounds', () => {
  it('admits only numeric and boolean delegation values', async () => {
    await expect(insertDelegationValue(25)).resolves.toBeUndefined();
    await expect(insertDelegationValue(true)).resolves.toBeUndefined();
    expect(pgErrorCode(await rejected(() => insertDelegationValue('PRIVATE_PROMPT_MARKER')))).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(await rejected(() => insertDelegationValue(['private@example.test'])))).toBe(CHECK_VIOLATION);
  });

  it('admits exact authorization limit objects and rejects arguments or extra keys', async () => {
    await expect(insertAuthorizationLimits([
      { tool: 'searchEmails', key: 'limit', value: 25 },
      { tool: 'searchEmails', key: 'hasAttachment', value: true },
    ])).resolves.toBeUndefined();
    expect(pgErrorCode(await rejected(() => insertAuthorizationLimits([
      { tool: 'searchEmails', key: 'q', value: 'PRIVATE_PROMPT_MARKER' },
    ])))).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(await rejected(() => insertAuthorizationLimits([
      { tool: 'searchEmails', key: 'limit', value: 25, prompt: 'PRIVATE_PROMPT_MARKER' },
    ])))).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(await rejected(() => insertAuthorizationLimits([1])))).toBe(CHECK_VIOLATION);
  });

  it('admits bounded audit metadata and rejects raw messages, keys and nested prompts', async () => {
    await expect(insertAuditEvent({
      result: { status: 'succeeded', code: '200' },
      correlation: {
        runId: 'run-test',
        idempotencyKeyHash: 'a'.repeat(64),
      },
    })).resolves.toBeUndefined();
    expect(pgErrorCode(await rejected(() => insertAuditEvent({
      result: { status: 'failed', message: 'PRIVATE_PROMPT_MARKER' },
      correlation: { runId: 'run-test' },
    })))).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(await rejected(() => insertAuditEvent({
      result: { status: 'failed' },
      correlation: { runId: 'run-test', idempotencyKey: 'PRIVATE_PROMPT_MARKER' },
    })))).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(await rejected(() => insertAuditEvent({
      result: { status: 'failed' },
      correlation: { runId: 'run-test' },
      resource: { prompt: 'PRIVATE_PROMPT_MARKER' },
    })))).toBe(CHECK_VIOLATION);
  });
});
