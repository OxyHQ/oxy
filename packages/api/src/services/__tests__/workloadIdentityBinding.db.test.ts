/**
 * Creating the binding row, against a real Postgres.
 *
 * `workloadIdentity.db.test.ts` covers what the mint does with a binding. This
 * file is about writing one, which is an operator action on a live database run
 * from a terminal — so the failures worth testing are the ones a tired human at
 * 2am produces:
 *
 *  1. **Re-running must be safe.** A bind is part of deploying a service, so it
 *     will be run twice. If the second run errored, somebody would start
 *     deleting rows to make it pass.
 *  2. **A subject must never be repointed.** Binding a role that already belongs
 *     to another application would take that application's identity away
 *     silently: the old service keeps attesting, keeps receiving tokens, and the
 *     tokens now carry somebody else's `applicationId`. Nothing throws, nothing
 *     alerts, and the writes land in the wrong tenant with confident audit
 *     attribution. It is the one mistake here that cannot be noticed.
 *  3. **The subject stored must be the subject attested.** An operator copies
 *     the ARN a task reports, which names a per-task session. Stored verbatim it
 *     matches exactly one task, forever — a rollout that appears to work in
 *     testing and dies at the next deploy.
 *  4. **A row the mint will refuse must not be written.** A binding on an
 *     inactive or third-party application looks like a finished rollout and
 *     fails later, somewhere else, at 403.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import {
  bindWorkloadIdentity,
  listWorkloadIdentityBindings,
  parseBindWorkloadIdentityArgv,
  WorkloadBindingError,
  WorkloadBindingUsageError,
} from '../workloadIdentityBinding.service';

const ACCOUNT = '237343248947';
const roleName = () => `oxy-test-${randomUUID()}`;
const roleArn = (role: string) => `arn:aws:iam::${ACCOUNT}:role/${role}`;
const assumedRoleArn = (role: string) => `arn:aws:sts::${ACCOUNT}:assumed-role/${role}/${randomUUID()}`;

const createdApplicationIds: string[] = [];

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  for (const id of createdApplicationIds) {
    await getDb().delete(applications).where(eq(applications.id, id));
  }
  await closePostgres();
});

async function applicationFixture(overrides: Partial<typeof applications.$inferInsert> = {}) {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `Binding test ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: 'active',
      isOfficial: true,
      scopes: ['user:read'],
      ...overrides,
    })
    .returning({ id: applications.id, name: applications.name });
  createdApplicationIds.push(application.id);
  return application;
}

/** The refusal, or a failure naming what happened instead of one. */
async function refusalOf(promise: Promise<unknown>): Promise<WorkloadBindingError> {
  try {
    const value = await promise;
    throw new Error(`Expected a refusal, got ${JSON.stringify(value)}`);
  } catch (error: unknown) {
    if (error instanceof WorkloadBindingError) return error;
    throw error;
  }
}

describe('bindWorkloadIdentity', () => {
  it('writes the binding a workload will resolve against', async () => {
    const application = await applicationFixture();
    const role = roleName();

    const result = await bindWorkloadIdentity({
      applicationId: application.id,
      subject: roleArn(role),
      description: 'Mention ECS task role',
    });

    expect(result.state).toBe('created');
    expect(result.binding).toMatchObject({
      applicationId: application.id,
      provider: 'aws-iam',
      subject: roleArn(role),
      description: 'Mention ECS task role',
      expiresAt: null,
    });

    const [stored] = await getDb()
      .select({ subject: applicationWorkloadIdentities.subject })
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, result.binding.id));
    expect(stored.subject).toBe(roleArn(role));
  });

  it('stores the role when handed the per-task ARN a running task reports', async () => {
    const application = await applicationFixture();
    const role = roleName();

    const result = await bindWorkloadIdentity({
      applicationId: application.id,
      subject: assumedRoleArn(role),
    });

    // Through the verifier's own `canonicalAwsSubject`, not a second copy of it:
    // a subject an operator types and a subject AWS vouches for have to be the
    // same string, and the only way to be sure is for one function to make both.
    expect(result.binding.subject).toBe(roleArn(role));
  });

  it('accepts a GovCloud role, whose partition is not the commercial one', async () => {
    const application = await applicationFixture();
    const role = roleName();

    const result = await bindWorkloadIdentity({
      applicationId: application.id,
      subject: `arn:aws-us-gov:sts::${ACCOUNT}:assumed-role/${role}/${randomUUID()}`,
    });

    expect(result.binding.subject).toBe(`arn:aws-us-gov:iam::${ACCOUNT}:role/${role}`);
  });

  it('accepts a subject with surrounding whitespace, which is how a copied ARN arrives', async () => {
    const application = await applicationFixture();
    const role = roleName();

    const result = await bindWorkloadIdentity({ applicationId: application.id, subject: `  ${roleArn(role)}\n` });

    expect(result.binding.subject).toBe(roleArn(role));
  });

  it('treats a second task’s ARN as the same binding, not a second one', async () => {
    const application = await applicationFixture();
    const role = roleName();

    const first = await bindWorkloadIdentity({ applicationId: application.id, subject: assumedRoleArn(role) });
    // A different session: the same workload on the next deploy.
    const second = await bindWorkloadIdentity({ applicationId: application.id, subject: assumedRoleArn(role) });

    expect(first.state).toBe('created');
    expect(second.state).toBe('unchanged');
    expect(second.binding.id).toBe(first.binding.id);
  });

  it('is a no-op on the identical re-run, reporting the row already there', async () => {
    const application = await applicationFixture();
    const subject = roleArn(roleName());

    const first = await bindWorkloadIdentity({ applicationId: application.id, subject, description: 'first' });
    const second = await bindWorkloadIdentity({ applicationId: application.id, subject, description: 'first' });

    expect(second).toMatchObject({ state: 'unchanged', binding: { id: first.binding.id, description: 'first' } });
    expect(second.ignoredChanges).toBeUndefined();

    const rows = await getDb()
      .select({ id: applicationWorkloadIdentities.id })
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, subject));
    expect(rows).toHaveLength(1);
  });

  it('names what a re-run asked to change rather than silently editing or silently ignoring', async () => {
    const application = await applicationFixture();
    const subject = roleArn(roleName());
    await bindWorkloadIdentity({ applicationId: application.id, subject, description: 'first' });

    const again = await bindWorkloadIdentity({
      applicationId: application.id,
      subject,
      description: 'second',
      expiresAt: '2099-01-01T00:00:00Z',
    });

    expect(again.state).toBe('unchanged');
    expect(again.ignoredChanges).toEqual(
      expect.arrayContaining([expect.stringContaining('description'), expect.stringContaining('expiresAt')]),
    );
    expect(again.binding.description).toBe('first');
    expect(again.binding.expiresAt).toBeNull();
  });

  it('refuses to repoint a subject that already belongs to another application', async () => {
    const owner = await applicationFixture();
    const usurper = await applicationFixture();
    const subject = roleArn(roleName());
    await bindWorkloadIdentity({ applicationId: owner.id, subject });

    const refusal = await refusalOf(bindWorkloadIdentity({ applicationId: usurper.id, subject }));

    expect(refusal.reason).toBe('subject_bound_elsewhere');
    expect(refusal.message).toContain(owner.id);
    expect(refusal.message).toContain(usurper.id);

    const [stored] = await getDb()
      .select({ applicationId: applicationWorkloadIdentities.applicationId })
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, subject));
    expect(stored.applicationId).toBe(owner.id);
  });

  it('refuses an application id nobody has, and writes nothing', async () => {
    const subject = roleArn(roleName());

    const refusal = await refusalOf(bindWorkloadIdentity({ applicationId: randomUUID(), subject }));

    expect(refusal.reason).toBe('unknown_application');
    const rows = await getDb()
      .select({ id: applicationWorkloadIdentities.id })
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, subject));
    expect(rows).toHaveLength(0);
  });

  it.each([
    ['an application the mint would refuse as inactive', { status: 'suspended' as const }, 'application_inactive'],
    [
      'a third-party application, which runs where we cannot attest',
      { isOfficial: false, type: 'third_party' as const },
      'untrusted_application',
    ],
  ])('refuses %s', async (_label, overrides, reason) => {
    const application = await applicationFixture(overrides);

    const refusal = await refusalOf(
      bindWorkloadIdentity({ applicationId: application.id, subject: roleArn(roleName()) }),
    );

    expect(refusal.reason).toBe(reason);
  });

  /**
   * `canonicalAwsSubject` passes an unrecognised ARN through unchanged, which is
   * the right answer when it is reporting what AWS said and the wrong one when
   * an operator is typing. Each of these would otherwise be written happily and
   * match nothing an attestation can ever present.
   */
  it.each([
    ['an IAM user, which implies a long-lived secret', 'arn:aws:iam::237343248947:user/nate'],
    ['the account root', 'arn:aws:iam::237343248947:root'],
    // The assumed-role ARN omits the path, so only the pathless form can match.
    ['a role ARN carrying an IAM path', 'arn:aws:iam::237343248947:role/service/oxy-mention-task'],
    ['an assumed-role ARN with no session, which does not reduce', 'arn:aws:sts::237343248947:assumed-role/oxy-x'],
    ['a federated user, which is a human', 'arn:aws:sts::237343248947:federated-user/nate'],
    ['something that is not an ARN', 'oxy-mention-task'],
  ])('refuses %s', async (_label, subject) => {
    const application = await applicationFixture();

    const refusal = await refusalOf(bindWorkloadIdentity({ applicationId: application.id, subject }));

    expect(refusal.reason).toBe('uncanonical_subject');
  });

  it.each([
    ['a provider with no verifier', { provider: 'kubernetes' }, 'unsupported_provider'],
    ['an expiry that is not a date', { expiresAt: 'next tuesday' }, 'invalid_expiry'],
    ['an expiry already in the past', { expiresAt: '2020-01-01T00:00:00Z' }, 'invalid_expiry'],
  ])('refuses %s', async (_label, overrides, reason) => {
    const application = await applicationFixture();

    const refusal = await refusalOf(
      bindWorkloadIdentity({ applicationId: application.id, subject: roleArn(roleName()), ...overrides }),
    );

    expect(refusal.reason).toBe(reason);
  });

  it('honours an expiry in the future, so a retiring workload can be wound down', async () => {
    const application = await applicationFixture();

    const result = await bindWorkloadIdentity({
      applicationId: application.id,
      subject: roleArn(roleName()),
      expiresAt: '2099-01-01T00:00:00Z',
    });

    expect(result.binding.expiresAt?.toISOString()).toBe('2099-01-01T00:00:00.000Z');
  });
});

describe('listWorkloadIdentityBindings', () => {
  it('reports every binding an application holds', async () => {
    const application = await applicationFixture();
    const other = await applicationFixture();
    const mine = [roleArn(roleName()), roleArn(roleName())].sort();
    for (const subject of mine) await bindWorkloadIdentity({ applicationId: application.id, subject });
    await bindWorkloadIdentity({ applicationId: other.id, subject: roleArn(roleName()) });

    const bindings = await listWorkloadIdentityBindings(application.id);

    expect(bindings.map((binding) => binding.subject)).toEqual(mine);
  });

  it('refuses an unknown application rather than reporting it has no bindings', async () => {
    const refusal = await refusalOf(listWorkloadIdentityBindings(randomUUID()));
    expect(refusal.reason).toBe('unknown_application');
  });
});

/**
 * The command line, with no process and no database.
 *
 * Argv is the only part of this script an operator composes by hand, so it is
 * the part that gets a flag wrong.
 */
describe('parseBindWorkloadIdentityArgv', () => {
  it('reads a bind', () => {
    expect(
      parseBindWorkloadIdentityArgv([
        '--app-id', 'app_1',
        '--role-arn', 'arn:aws:iam::237343248947:role/oxy-mention-task',
        '--description', 'Mention ECS task role',
        '--expires-at', '2099-01-01T00:00:00Z',
      ]),
    ).toEqual({
      mode: 'bind',
      request: {
        applicationId: 'app_1',
        subject: 'arn:aws:iam::237343248947:role/oxy-mention-task',
        description: 'Mention ECS task role',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    });
  });

  it('reads --flag=value as well, because operators type both', () => {
    expect(parseBindWorkloadIdentityArgv(['--app-id=app_1', '--subject=arn', '--provider=aws-iam'])).toEqual({
      mode: 'bind',
      request: { applicationId: 'app_1', subject: 'arn', provider: 'aws-iam' },
    });
  });

  it('reads a --list', () => {
    expect(parseBindWorkloadIdentityArgv(['--app-id', 'app_1', '--list'])).toEqual({
      mode: 'list',
      applicationId: 'app_1',
    });
  });

  it.each([
    ['an unrecognised flag, rather than skipping it', ['--app-id', 'app_1', '--expires', '2099-01-01']],
    ['a flag with no value', ['--app-id']],
    ['a flag whose value is the next flag', ['--app-id', '--list']],
    ['a repeated flag', ['--app-id', 'app_1', '--app-id', 'app_2', '--subject', 'arn']],
    ['--role-arn and --subject disagreeing', ['--app-id', 'a', '--role-arn', 'one', '--subject', 'two']],
    ['no application', ['--subject', 'arn']],
    ['a bind with nothing to bind', ['--app-id', 'app_1']],
    ['a --list that also asks to write', ['--app-id', 'app_1', '--list', '--subject', 'arn']],
    ['--list given a value', ['--app-id', 'app_1', '--list=yes']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseBindWorkloadIdentityArgv(argv)).toThrow(WorkloadBindingUsageError);
  });
});
