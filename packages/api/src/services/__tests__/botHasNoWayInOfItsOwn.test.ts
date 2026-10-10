/**
 * What a bot CANNOT do today (issue #1520, I01) — against a REAL Postgres.
 *
 * A bot is a complete account, but until a way in of its own is approved
 * (`docs/auth/proposals/bot-autonomous-auth.md`) no path mints an unoperated
 * session for it. These cases pin the negative half of that, so the proposal
 * cannot land by accident and nothing here enables anything:
 *
 *  - a bot created the real way has no key, no email and no password: none of
 *    the human ways in can resolve it;
 *  - the identity root (Commons key) links to a personal account only;
 *  - a bot's session bearer is not a service principal;
 *  - a bot of organization A has no authority in organization B, and a bot that
 *    creates another bot hands it nothing it did not have.
 *
 * Covered elsewhere, not repeated: email sign-in and password sign-in refuse a
 * bot (`routes/__tests__/signIn.test.ts`), an authenticator cannot be enrolled
 * on one (`routes/__tests__/accountSecurity.test.ts`), a forged header never
 * moves the actor (`botAccountParity.test.ts`), and approving a sign-in from an
 * operated session never hands a person a bot's seat
 * (`routes/__tests__/operatedApprovalKeepsOperator.test.ts`).
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { IDENTITY_ERROR_CODES } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { userPasswords } from '../../db/schema/userPasswords';
import { users } from '../../db/schema/users';
import { verifyServiceToken } from '../../middleware/serviceToken';
import { accountService } from '../account.service';
import { linkRootToAccount } from '../identityLink.service';
import sessionService from '../session.service';

jest.setTimeout(60_000);

async function person(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `p${randomUUID().replace(/-/g, '').slice(0, 14)}` })
    .returning({ id: users.id });
  return row.id;
}

function botHandle(): string {
  return `agent${randomUUID().replace(/-/g, '').slice(0, 8)}bot`;
}

/** Created the way `POST /accounts` creates one — the real service, not an insert. */
async function botUnder(parentAccountId: string, creatorUserId: string): Promise<string> {
  const { account } = await accountService.createChildAccount(parentAccountId, creatorUserId, {
    kind: 'bot',
    username: botHandle(),
  });
  return account.id;
}

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET ??= `access-${randomUUID()}`;
  process.env.REFRESH_TOKEN_SECRET ??= `refresh-${randomUUID()}`;
  process.env.DEVICE_ID_SALT ??= 'x'.repeat(48);
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('a bot has no way in of its own today', () => {
  it('is created with no key, no email and no password — nothing a human sign-in can resolve', async () => {
    const owner = await person();
    const bot = await botUnder(owner, owner);

    const [row] = await getDb()
      .select({ kind: users.kind, publicKey: users.publicKey, email: users.email })
      .from(users)
      .where(eq(users.id, bot))
      .limit(1);
    expect(row).toEqual({ kind: 'bot', publicKey: null, email: null });
    expect(
      await getDb().select().from(userPasswords).where(eq(userPasswords.userId, bot)),
    ).toHaveLength(0);
    expect(
      await getDb().select().from(userAuthMethods).where(eq(userAuthMethods.userId, bot)),
    ).toHaveLength(0);
  });

  it('cannot be given the identity root a person signs in with', async () => {
    const owner = await person();
    const bot = await botUnder(owner, owner);
    const publicKey = `04${'b'.repeat(128)}`;

    // The kind check comes before any proof is read, so a placeholder proof is
    // enough to show the refusal is about WHAT the account is.
    await expect(
      getDb().transaction((tx) =>
        linkRootToAccount(tx, {
          userId: bot,
          publicKey,
          proof: {} as never,
          emailReauthVerified: true,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: IDENTITY_ERROR_CODES.notPersonal });

    const [after] = await getDb()
      .select({ publicKey: users.publicKey })
      .from(users)
      .where(eq(users.id, bot))
      .limit(1);
    expect(after.publicKey).toBeNull();
  });

  it("does not turn a bot's session bearer into a service principal", async () => {
    const owner = await person();
    const bot = await botUnder(owner, owner);
    const session = await sessionService.createSession(
      bot,
      { headers: { 'user-agent': 'jest' } } as never,
      { deviceId: `dev-${randomUUID()}`, operatedByUserId: owner },
    );

    const verification = verifyServiceToken(session.accessToken);

    expect(verification.ok).toBe(false);
  });
});

describe('a bot holds no authority it was not given', () => {
  it('has none in an organization it is not a member of', async () => {
    const founderA = await person();
    const founderB = await person();
    const [orgA, orgB] = await Promise.all(
      [founderA, founderB].map(async (founder) => {
        const { account } = await accountService.createChildAccount(founder, founder, {
          kind: 'organization',
          username: `org${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        });
        return account.id;
      }),
    );
    const botA = await botUnder(orgA, founderA);
    await getDb()
      .insert(accountMembers)
      .values({ accountId: orgA, memberUserId: botA, role: 'admin', status: 'active' });

    expect(await accountService.resolveEffectiveAccess(botA, orgA)).not.toBeNull();
    expect(await accountService.resolveEffectiveAccess(botA, orgB)).toBeNull();
    expect(await accountService.verifyActingAs(botA, orgB)).toBeNull();
  });

  it('cannot act as its owner, nor as another bot', async () => {
    const owner = await person();
    const bot = await botUnder(owner, owner);
    const sibling = await botUnder(owner, owner);

    expect(await accountService.verifyActingAs(bot, owner)).toBeNull();
    expect(await accountService.verifyActingAs(bot, sibling)).toBeNull();
  });

  it('hands a bot it creates nothing it does not hold — and an editor creates none', async () => {
    const founder = await person();
    const { account: org } = await accountService.createChildAccount(founder, founder, {
      kind: 'organization',
      username: `org${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    });
    const creator = await botUnder(org.id, founder);
    const editor = await botUnder(org.id, founder);
    await getDb()
      .insert(accountMembers)
      .values([
        { accountId: org.id, memberUserId: creator, role: 'admin', status: 'active' },
        { accountId: org.id, memberUserId: editor, role: 'editor', status: 'active' },
      ]);

    const editorAccess = await accountService.resolveEffectiveAccess(editor, org.id);
    expect(editorAccess?.permissions).not.toContain('children:create');

    const child = await botUnder(org.id, creator);

    // The child is owned by the bot that created it, and holds nothing over the
    // organization or its creator: authority is membership, never ancestry.
    const [ownerRow] = await getDb()
      .select({ memberUserId: accountMembers.memberUserId, role: accountMembers.role })
      .from(accountMembers)
      .where(eq(accountMembers.accountId, child));
    expect(ownerRow).toEqual({ memberUserId: creator, role: 'owner' });
    expect(await accountService.resolveEffectiveAccess(child, org.id)).toBeNull();
    expect(await accountService.verifyActingAs(child, creator)).toBeNull();
    expect(await accountService.verifyActingAs(child, org.id)).toBeNull();
  });

  it('is not, unoperated, the owner of itself (pending the decision in the proposal)', async () => {
    const owner = await person();
    const bot = await botUnder(owner, owner);

    expect(await accountService.resolveEffectiveAccess(bot, bot)).toBeNull();
    // Positive control: a personal account IS the owner of itself.
    expect((await accountService.resolveEffectiveAccess(owner, owner))?.role).toBe('owner');
  });
});
