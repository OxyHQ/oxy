/**
 * Account creation — what every path that mints a `users` row shares.
 *
 * Seven paths create an account: a child account under a parent
 * (`AccountService.createChildAccount`), email sign-up (`routes/signIn.ts`),
 * key registration (`SessionController.register`), a neutral directory
 * organization and its bulk import (`organization-directory.service.ts`), a
 * federated actor (`externalIdentityRegistry.service.ts`) and an agent or
 * automated profile (`PUT /users/resolve`). Each keeps what is genuinely its own
 * — a sign-up ticket, a signature, a parent's authority, a remote actor's merge —
 * and takes the rest from here, so these rules exist once:
 *
 *  - A handle a person chose is canonicalised and judged by ONE policy,
 *    {@link canonicalUsername}.
 *  - The unique index decides availability. There is no probe before the
 *    insert: a probe is a round trip that cannot close the race anyway, and the
 *    index's answer becomes the same {@link UsernameTakenError} a probe gave.
 *  - A new account's tree path and organization profile are INSERTed. Nothing is
 *    deleted that cannot exist yet, and nothing waits for a trigger to create a
 *    row it then patches.
 *  - A new person is welcomed once, best effort, after the account commits.
 */

import { randomUUID } from 'node:crypto';
import { normalizeLocale } from '@oxy.so/core';
import type { CampaignAttribution } from '@oxy.so/contracts';
import { accountAcquisition } from '../db/schema/accountAcquisition';
import { usernameSchemaForAccountKind, type CreateOrganization } from '@oxy.so/contracts';
import { isUniqueViolation } from '@oxy.so/db';
import { eq, sql } from 'drizzle-orm';
import { publicColumns } from '@oxy.so/db/assert';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { notifications } from '../db/schema/notifications';
import { organizationProfiles } from '../db/schema/organizationProfiles';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { userAncestors } from '../db/schema/userAncestors';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users, type AccountKind } from '../db/schema/users';
import { BadRequestError, ConflictError } from '../utils/error';
import { logger } from '../utils/logger';
import { untrustedNameColumns } from '../utils/displayNameSanitize';
import { normalizeUsername } from '../utils/username';
import type { AccountRow } from './account.service';

/**
 * The unique index `users.username` is held by — `lower(btrim(username))`,
 * `db/schema/users.ts`. Postgres reports an expression index's own name in
 * `constraint_name`, which is what lets a lost race be told apart from every
 * other constraint on the table.
 */
export const USERNAME_UNIQUE_INDEX = 'users_lower_username_key';

/**
 * The 409 a taken handle produces, on every path.
 *
 * Only `users_lower_username_key` becomes this. A `users` write can violate
 * `users_lower_public_key_key` or `users_federation_actor_uri_key` just as
 * easily, and reporting either as "that username is taken" would send the
 * caller to fix a field that was never the problem. `field` tells a client
 * WHICH input to change; a surface with its own wire shape (sign-up's error
 * code, registration's `{ message }`) maps this one class to it.
 */
export class UsernameTakenError extends ConflictError {
  constructor(readonly username: string) {
    super(`The username "${username}" is already taken`, { field: 'username' });
    this.name = 'UsernameTakenError';
  }
}

/** A handle that has been canonicalised and passed the policy for its kind. */
export type CanonicalUsername = string & { readonly __canonicalUsername: true };

/**
 * The stored form of a requested handle, or a 400 naming what is wrong with it.
 *
 * Canonicalisation (`normalizeUsername`: NFC + whitespace collapse) then the one
 * policy, `usernameSchemaForAccountKind` — a `bot` handle must also end in `bot`.
 * The kind is passed in, never guessed from the string: guessing would make
 * `abbot` a bot and a bot called `luna` a person.
 *
 * The ISSUE's message, not a base constant: a handle can fail several rules,
 * and the first one Zod reports is the one actually broken.
 */
export function canonicalUsername(
  requested: string,
  kind: AccountKind | null | undefined,
): CanonicalUsername {
  const parsed = usernameSchemaForAccountKind(kind).safeParse(normalizeUsername(requested));
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0].message, { field: 'username' });
  }
  return parsed.data as CanonicalUsername;
}

/**
 * Run a write that stores `username`, turning a violation of
 * {@link USERNAME_UNIQUE_INDEX} into {@link UsernameTakenError}. Everything else
 * propagates untouched.
 *
 * `username` may be absent: a write that does not set it cannot lose this race.
 */
export async function rejectingTakenUsername<T>(
  username: string | null | undefined,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (typeof username === 'string' && isUniqueViolation(error, USERNAME_UNIQUE_INDEX)) {
      throw new UsernameTakenError(username);
    }
    throw error;
  }
}

/** The columns of a new `users` row. */
export type NewAccount = typeof users.$inferInsert;

/**
 * Insert one account and return it WITHOUT the protected columns (see
 * {@link AccountRow}).
 */
export async function insertAccount(
  db: DatabaseOrTransaction,
  values: NewAccount,
): Promise<AccountRow> {
  const [created] = await rejectingTakenUsername(values.username, () =>
    db.insert(users).values(values).returning(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)),
  );
  if (!created) throw new Error('Account insert returned no row');
  return created;
}

/**
 * The materialised path of a NEW account, root first. A new account has no path
 * yet, so this only inserts; replacing a path on a move is `writeAncestors` in
 * `account.service.ts`.
 */
export async function insertAncestors(
  db: DatabaseOrTransaction,
  accountId: string,
  ancestors: readonly string[],
): Promise<void> {
  if (ancestors.length === 0) return;
  await db
    .insert(userAncestors)
    .values(ancestors.map((ancestorId, depth) => ({ userId: accountId, depth, ancestorId })));
}

/**
 * The directory profile of new organization accounts.
 *
 * Every `kind: 'organization'` row needs one in the same transaction
 * (`organization_directory_required`, a deferred constraint trigger). An owned
 * organization is born `claimed`; a directory identity nobody operates yet is
 * born `unclaimed`.
 */
export async function insertOrganizationProfiles(
  db: DatabaseOrTransaction,
  profiles: (typeof organizationProfiles.$inferInsert)[],
): Promise<void> {
  if (profiles.length === 0) return;
  await db.insert(organizationProfiles).values(profiles);
}

/**
 * The id of a new neutral directory organization.
 *
 * A random UUID, NOT the table's uuidv7 default: the handle is derived from the
 * id ({@link insertNeutralOrganizations}), and a uuidv7's leading hex is its
 * timestamp, so a batch minted in one millisecond would share most of it and
 * collide on the handle.
 */
export function neutralOrganizationId(): string {
  return randomUUID();
}

/** A directory organization nobody operates yet, with the id it will carry. */
export interface NeutralOrganization {
  accountId: string;
  organization: CreateOrganization;
  /** An Oxy file id; the caller has already checked it is a public image. */
  avatar?: string | null;
}

/**
 * Neutral directory organizations — `unclaimed`, parentless, no owner — in two
 * bulk statements however many there are. One creation and a batch import are
 * the same write; a single organization is a batch of one.
 */
export async function insertNeutralOrganizations(
  db: DatabaseOrTransaction,
  items: readonly NeutralOrganization[],
): Promise<void> {
  if (items.length === 0) return;
  await db.insert(users).values(
    items.map(({ accountId, organization, avatar }) => ({
      id: accountId,
      kind: 'organization' as const,
      type: 'local' as const,
      username: `org${accountId.replace(/-/g, '').slice(0, 20)}`,
      nameDisplay: organization.name,
      avatar: avatar ?? null,
      verified: false,
      parentAccountId: null,
      rootAccountId: null,
      privacyIsPrivateAccount: false,
    })),
  );
  await insertOrganizationProfiles(
    db,
    items.map(({ accountId, organization }) => ({
      accountId,
      organizationType: organization.organizationType,
      legalName: organization.legalName ?? null,
      websiteUrl: organization.websiteUrl ?? null,
      countryCode: organization.countryCode ?? null,
      aliases: organization.aliases ?? [],
      claimStatus: 'unclaimed' as const,
    })),
  );
}

/** The account types a service connector may find-or-create by handle. */
export type AutomatedAccountType = 'agent' | 'automated';

/**
 * What a connector may write on an agent or automated profile; never an auth
 * field. `displayName` is the connector's UNCLEANED name: it is cleaned and
 * shaped by the row's kind here, where the row is read.
 */
export type AutomatedAccountFields = Pick<NewAccount, 'automationOwnerId' | 'bio' | 'avatar'> & {
  displayName?: string;
};

/**
 * Find-or-create an agent or automated profile by handle (`PUT /users/resolve`).
 *
 * ONE read decides: the unique index on `lower(btrim(username))` admits at most
 * one row, so the row that holds the handle is the only one to ask about.
 *  - A local or federated account holds it → 409. Re-typing that row through a
 *    connector would be account takeover via the federation pipeline.
 *  - An account of the OTHER automated type holds it → 409. `type` is written
 *    only at birth; nothing re-types an existing account.
 *  - The same type holds it → update. Nobody → insert.
 *
 * Two connectors resolving the same new handle race to the insert. The loser
 * re-reads once and takes the same decision against the winner's row, rather
 * than surfacing the unique violation as a 500.
 *
 * The handle is NOT held to `canonicalUsername`: these names come from remote
 * systems and keep the policy this path always had.
 */
export async function upsertAutomatedAccount(
  type: AutomatedAccountType,
  username: string,
  fields: AutomatedAccountFields,
): Promise<{ id: string; created: boolean; previousAvatar: string | null }> {
  const db = getDb();
  const holder = async () => {
    const [existing] = await db
      .select({ id: users.id, type: users.type, kind: users.kind, avatar: users.avatar })
      .from(users)
      .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
      .limit(1);
    if (!existing) return null;
    if (existing.type !== 'agent' && existing.type !== 'automated') {
      throw new ConflictError('Username is already taken by a non-automated user');
    }
    if (existing.type !== type) {
      throw new ConflictError('Cannot change the type of an existing user');
    }
    return existing;
  };

  // A connector never names the kind, so a new row takes the column default.
  const columns = ({ displayName, ...rest }: AutomatedAccountFields, kind: AccountKind) => ({
    ...rest,
    ...(displayName === undefined ? {} : untrustedNameColumns(displayName, kind)),
  });
  let existing = await holder();
  if (!existing) {
    try {
      const created = await insertAccount(db, { ...columns(fields, 'personal'), username, type });
      return { id: created.id, created: true, previousAvatar: null };
    } catch (error) {
      if (!(error instanceof UsernameTakenError)) throw error;
      existing = await holder();
      if (!existing) throw error;
    }
  }
  await db
    .update(users)
    .set({ ...columns(fields, existing.kind), username })
    .where(eq(users.id, existing.id));
  return { id: existing.id, created: false, previousAvatar: existing.avatar };
}

/** How a new person signs in: the email a sign-up ticket confirmed, or an identity key. */
export type PersonalCredential = { email: string } | { publicKey: string };

/**
 * A new `personal` account — a human login — with its credential.
 *
 * With a key, the `identity` auth method is written in the same transaction:
 * an account whose only credential failed to insert could never be signed into.
 * The caller supplies that transaction, because each sign-up path has its own
 * work to do in it (spending a ticket, capping accounts per address).
 */
export async function createPersonalAccount(
  tx: DatabaseOrTransaction,
  username: CanonicalUsername,
  credential: PersonalCredential,
  acquisition?: { languages?: string[]; campaignAttribution?: CampaignAttribution },
): Promise<AccountRow> {
  const languages = acquisition?.languages?.map((locale) => {
    const canonical = normalizeLocale(locale);
    if (!canonical) throw new BadRequestError('Unsupported language', { field: 'languages' });
    return canonical;
  });
  const account = await insertAccount(tx, {
    username,
    ...credential,
    ...(languages ? { languages: [...new Set(languages)] } : {}),
  });
  const campaign = acquisition?.campaignAttribution;
  if (campaign) {
    await tx.insert(accountAcquisition).values({
      userId: account.id,
      utmSource: campaign.utmSource,
      utmMedium: campaign.utmMedium,
      utmCampaign: campaign.utmCampaign,
      utmContent: campaign.utmContent,
      utmTerm: campaign.utmTerm,
      fbclid: campaign.fbclid,
    });
  }
  if ('publicKey' in credential) {
    await tx.insert(userAuthMethods).values({
      userId: account.id,
      type: 'identity',
      methodPublicKey: credential.publicKey,
    });
  }
  return account;
}

/**
 * Welcome a new person: one `welcome` notification, attributed to themselves.
 *
 * Best effort and AFTER the account commits: a sign-up never fails because its
 * greeting did. `on conflict do nothing` keeps it once per account.
 */
export async function welcomeNewAccount(accountId: string): Promise<void> {
  try {
    await getDb()
      .insert(notifications)
      .values({
        recipientId: accountId,
        actorId: accountId,
        type: 'welcome',
        entityId: accountId,
        entityType: 'profile',
        read: false,
      })
      .onConflictDoNothing();
  } catch (error) {
    logger.error(
      'Failed to create welcome notification for a new account',
      error instanceof Error ? error : new Error(String(error)),
      { component: 'accountCreation', userId: accountId },
    );
  }
}
