/**
 * `oxy.accounts` — the unified account graph (`/accounts`).
 *
 * An account is a relational, tree-structured principal (the `User` document
 * generalised): a `personal` account is a human login at the root of its tree;
 * `organization` / `project` / `bot` / `channel` accounts are non-login
 * principals operated through membership. Accounts form a tree
 * (`parentAccountId`) and expose a single membership model (`AccountMember`)
 * with a unified role set and an explicit-but-inheritable cascade down the
 * subtree. The applications an account owns are `oxy.apps`.
 *
 * Reference accounts by their `_id` (`accountId`, the underlying `User._id`)
 * and members by their member `_id` — never by name, slug, or handle.
 *
 * SWITCHING INTO AN ACCOUNT: `accounts.actAs(accountId)` mints a REAL
 * session for the target account and plants it as the active session — there is
 * no per-request "acting-as" header. Identity is carried by the session/token,
 * so a switch propagates through reload and cross-domain exactly like a login.
 */
import type { User } from '../models/interfaces';
import type { AccountCategoryId, AccountKind, ChildAccountKind } from '@oxy.so/contracts';
import type { SessionLoginResponse } from '../models/session';
import type { OxyContext } from '../client/context';
import { normalizeUserIdentity } from '../utils/userIdentity';
import { evictOxyIdentityCache } from '../utils/identityCacheSweep';
import {
  evictOxyAccountForestCache,
  oxyAccountDetailCacheKey,
  OXY_ACCOUNT_PER_ACCOUNT_CACHE_PREFIX,
} from '../utils/accountCacheSweep';

const MEDIUM_TTL = 2 * 60 * 1000;
const LONG_TTL = 5 * 60 * 1000;

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Account graph types
// ---------------------------------------------------------------------------

/**
 * Account classification, orthogonal to the federation `type`
 * (`local|federated|agent|automated`). `personal` accounts have a direct login;
 * `organization` / `project` / `bot` / `channel` accounts are operated via
 * `AccountMember` and have no direct login. Of those, only the first three may
 * be acted AS by an application (`isDelegatedActAsEligibleKind`), and only the
 * first two may be SWITCHED INTO by a person (`isOperatorSwitchTargetKind`).
 *
 * Single source of truth is `@oxy.so/contracts`.
 */
export type { AccountCategoryId, AccountKind } from '@oxy.so/contracts';
export {
  ACCOUNT_CATEGORY_IDS,
  ACCOUNT_KINDS,
  MAX_ACCOUNT_CATEGORIES,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  isDelegatedActAsEligibleKind,
  isOperatorSwitchTargetKind,
  isSelectableAccountCategoryId,
  kindAcceptsAccountCategories,
} from '@oxy.so/contracts';

/**
 * The calling user's relationship to an account node, as resolved by the API:
 * - `self` — the caller's own personal (root) account.
 * - `owner` — an account the caller owns (e.g. an org/project/bot they created).
 * - `member` — an account shared with the caller via membership (including
 *   external organisations).
 */
export type AccountRelationship = 'self' | 'owner' | 'member';

/** Role a member holds within an account. The unified account role set. */
export type AccountRole = 'owner' | 'admin' | 'editor' | 'developer' | 'billing' | 'viewer';

/** Membership lifecycle status. */
export type AccountMemberStatus = 'active' | 'invited' | 'removed';

/**
 * Origin of a resolved membership. `direct` is a membership row on the account
 * itself; `inherited` is resolved from the nearest ancestor account whose
 * membership row has `inherit: true` (role inheritance cascades down the tree).
 */
export type AccountMemberSource = 'direct' | 'inherited';

/**
 * Client-facing AccountMember shape. `permissions` is the effective permission
 * set (role baseline plus `permissionGrants` minus `permissionRevokes`).
 */
export interface AccountMember {
  _id: string;
  /** The account this membership grants access to (account `_id`). */
  accountId: string;
  /** The member's personal-account `User._id`. */
  memberUserId: string;
  role: AccountRole;
  permissions: string[];
  /** Permissions granted beyond the role baseline. */
  permissionGrants?: string[];
  /** Permissions revoked from the role baseline. */
  permissionRevokes?: string[];
  /**
   * Whether this membership cascades to the account's subtree. `true` (default)
   * lets descendants inherit this role unless a nearer row overrides it; `false`
   * opts this row out of inheritance (it applies to this account only).
   */
  inherit: boolean;
  status: AccountMemberStatus;
  /**
   * Where this membership COMES FROM relative to the account it is being
   * reported for: `direct` when the row lives on that account, `inherited` when
   * it lives on an ancestor whose `inherit` flag cascades it down.
   *
   * Present on every membership the API serialises — a resolved
   * `callerMembership` and every entry of a member list alike. It is not
   * decoration: an `inherited` entry's `accountId` is the ANCESTOR's, and the
   * member-mutation endpoints are scoped to rows on the account named in the
   * path, so `PATCH`/`DELETE .../members/<that row's _id>` against the
   * descendant 404s. **Branch on `source === 'direct'` before offering to edit,
   * remove or transfer to a member**, and count owners for a last-owner check
   * over direct entries only.
   */
  source: AccountMemberSource;
  invitedByUserId?: string | null;
  joinedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A node in the account graph as returned by the `/accounts` API. `account` is
 * the underlying generalised `User` document; `relationship` and
 * `callerMembership` describe the caller's access. On a flat list every node
 * carries `parentAccountId`; with `tree:true`, `children` is populated and
 * `childCount` reflects the number of direct children.
 */
export interface AccountNode {
  /** The account's Mongo `_id` (the underlying `User._id`). */
  accountId: string;
  kind: AccountKind;
  /** Parent account `_id`, or `null` for a root (personal) account. */
  parentAccountId: string | null;
  /** The generalised `User` document backing this account. */
  account: User;
  relationship: AccountRelationship;
  /**
   * The caller's effective membership in this account (direct or inherited), or
   * `null` when the caller has no membership (e.g. their own `self` root, where
   * ownership is implicit). Use `callerMembership.permissions` to gate UI.
   */
  callerMembership: AccountMember | null;
  /** Number of direct child accounts (present when the API computes it). */
  childCount?: number;
  /** Direct children, populated when the list is requested with `tree:true`. */
  children?: AccountNode[];
}

/** Options accepted by `accounts.list`. */
export interface ListAccountsOptions {
  /**
   * When `true`, request the nested tree representation: each returned node has
   * its `children` populated instead of a flat list keyed by `parentAccountId`.
   */
  tree?: boolean;
}

/** Input accepted by `accounts.create`. */
export interface CreateAccountInput {
  /**
   * Classification of the new account. Every CHILD kind is creatable here with
   * the caller's own bearer, `channel` included: a signed-in person has already
   * proven who they are, and minting a child under their own tree is the same
   * operation whichever kind it is.
   *
   * `channel` used to be excluded, on the reasoning that channels are
   * service-provisioned only. What actually makes a channel safe does not depend
   * on who creates it: `createChildAccount` writes no auth method, so it is born
   * with no login, and `POST /accounts/:id/switch` refuses it via
   * both act-as predicates, so no session can ever have a channel as its subject
   * and therefore no bearer exists that could add one. `personal` is excluded
   * because it is a human login, minted at signup.
   */
  kind: ChildAccountKind;
  /**
   * Parent account `_id` to nest the new account under. Omitted → the API roots
   * it under the caller's personal account.
   */
  parentAccountId?: string;
  /** Unique handle for the account (shares the `User.username` unique index). */
  username: string;
  /**
   * A managed account (organization / project / bot / channel) has a TITLE, not
   * a given-and-family name, so it sets `displayName` — the explicit
   * `name_display` column — and leaves `first`/`last` unset. Splitting a title
   * on whitespace into `first`/`last` is what this replaced.
   */
  name?: { first?: string; last?: string; displayName?: string };
  bio?: string;
  avatar?: string;
  /**
   * Named color preset KEY — `'blue'`, `'mint'`, … — never a hex value. The
   * account graph's half of `User.color`, which every account DTO already
   * carries; this is how one gets WRITTEN for an account you administer.
   *
   * Set it HERE rather than after the fact. For a managed account the colour is
   * a visual identity, and an account that is discoverable without one and
   * acquires it on a second request is a face that changes by itself.
   *
   * Omitted is not "no colour": the platform assigns a random preset, exactly as
   * it did before this field existed. A reserved preset is refused unless the
   * account has a claim to it — the administrator's own entitlements are not the
   * ones weighed.
   */
  color?: string;
  /**
   * What the account is about. ORDERED — the FIRST element is the primary
   * category, so a picker must submit them in the order the user arranged them
   * and must not sort. Stable ids, never labels: render each one through the
   * `accounts.accountCategory.<id>` translation key.
   *
   * Offer `SELECTABLE_ACCOUNT_CATEGORY_IDS`, not `ACCOUNT_CATEGORY_IDS` — the
   * latter still contains withdrawn ids so that accounts already carrying one
   * keep working. At most `MAX_ACCOUNT_CATEGORIES`, no duplicates.
   */
  accountCategories?: AccountCategoryId[];
  /**
   * Create the account already opted OUT of discovery — kept out of people
   * search, the follow-graph lists, `/similar` and the recommendation pools,
   * with non-public media follower-gated.
   *
   * Pass `true` when the account is not something its owner has published yet:
   * an agent, an unlaunched project, an organization for something unannounced.
   * OMITTED IS NOT `false` IN MEANING, only in effect — saying nothing leaves
   * the platform default, which is discoverable, and that default is not
   * changed by this option existing.
   *
   * Setting it later is `PUT /users/:userId/privacy`, which needs the ACCOUNT's
   * own bearer. Passing it here is the only way to have the account never be
   * discoverable at all, rather than discoverable until a second call lands.
   */
  isPrivateAccount?: boolean;
}

/** Input accepted by `accounts.update`. Tree placement changes go through `/move`. */
export interface UpdateAccountInput {
  username?: string;
  /**
   * Same shape as `CreateAccountInput['name']`. On update, an EMPTY STRING in
   * `displayName` clears the explicit name and falls back to the composed
   * `first`/`last`; omitting the key leaves the stored value untouched. The two
   * are not interchangeable.
   */
  name?: { first?: string; last?: string; displayName?: string };
  bio?: string | null;
  avatar?: string | null;
  /**
   * Named color preset KEY, same vocabulary as `CreateAccountInput['color']`.
   *
   * NOT nullable, unlike `bio` and `avatar`: the column is `NOT NULL` with a
   * default, so an account always HAS a colour and there is no "clear" to
   * express. Sending the value the account already carries is always accepted,
   * so a client may PATCH back the object it was served.
   */
  color?: string;
  /**
   * Replaces the WHOLE list, in the order given — there is no add/remove verb,
   * because a partial edit cannot express a re-ordering and the order is what
   * names the primary category. `[]` clears it.
   *
   * Not nullable, unlike `bio` and `avatar`: the empty case already has a
   * spelling of its own, so a second one could only ever disagree with it.
   *
   * Rejected for a `personal` account, and rejected when it ADDS a withdrawn
   * id the account did not already carry — keeping or re-ordering one it has is
   * always allowed.
   */
  accountCategories?: AccountCategoryId[];
}

/** Input accepted by `accounts.members.invite`. The owner role cannot be invited. */
export interface InviteAccountMemberInput {
  /**
   * The username or email of the user to invite. Resolved to a personal account
   * server-side; an unknown value yields a 404 "User not found".
   */
  usernameOrEmail: string;
  role: Exclude<AccountRole, 'owner'>;
}

/** Input accepted by `accounts.members.update`. The owner role cannot be assigned. */
export interface UpdateAccountMemberInput {
  role?: Exclude<AccountRole, 'owner'>;
  inherit?: boolean;
  permissionGrants?: string[];
  permissionRevokes?: string[];
}

/** Input accepted by `accounts.transferOwnership`. */
export interface TransferAccountOwnershipInput {
  userId: string;
}

/** Result of an archive/remove/revoke/transfer/delete operation. */
export interface AccountSuccessResult {
  success: boolean;
}

/**
 * Result of {@link AccountsApi.actAs} — the freshly
 * minted session for the target account, in the SAME shape the canonical login
 * / `claimSessionByToken` responses use (`SessionLoginResponse`).
 *
 * `accessToken` is the first access token for the new session (already planted
 * as the active token by `actAs`). The switched session's survival
 * across reload and cross-domain sync is device-first: the server registers
 * it into the operator's `DeviceSession` set directly
 * (`deviceSessionService.addAccount`, broadcast to the device room) — there is
 * no client-side refresh-cookie slot to establish. `user` is the target
 * account.
 */
export interface SwitchAccountResult extends SessionLoginResponse {
  /**
   * Legacy device-local refresh-cookie slot index. The current server switch
   * response never sets this field (device-set registration replaced the
   * cookie-slot model) — kept optional for backward type-compatibility with
   * any caller still reading it, but always `undefined` in practice.
   */
  authuser?: number;
}


/** `oxy.accounts.members` — who can act on an account, and with what role. */
export class AccountMembersApi {
  constructor(private readonly ctx: OxyContext) {}

  /**
   * List the members of an account: the membership rows ON it, plus the rows
   * on its ancestors that cascade into it. Each entry carries `source`
   * (`direct` | `inherited`) saying which it is.
   *
   * Inherited entries are members in every sense the server enforces — an
   * ancestor row with `inherit: true` confers every account permission on the
   * descendant, `account:act_as` included.
   *
   * An entry's `accountId` is the account its ROW lives on, so an inherited
   * entry names an ancestor; and the member-mutation endpoints only accept rows
   * on the account in the path, so gate any edit/remove/transfer affordance on
   * `source === 'direct'`.
   *
   * To ask what the CALLER holds over an account, use `accounts.get`, whose
   * `callerMembership` is the server's own resolution.
   *
   * @param accountId - The account's `_id`.
   */
  async list(accountId: string): Promise<AccountMember[]> {
    const res = await this.ctx.request<{ members?: AccountMember[] }>(
      'GET',
      `/accounts/${enc(accountId)}/members`,
      undefined,
      { cache: true, cacheTTL: MEDIUM_TTL },
    );
    return res.members ?? [];
  }

  /**
   * Add a member to an account.
   * @param accountId - The account's `_id`.
   * @param data - Target user's username or email and role (never `owner`).
   *   The server resolves `usernameOrEmail` to a personal account; an unknown
   *   value yields a 404 "User not found".
   */
  async invite(accountId: string, data: InviteAccountMemberInput): Promise<AccountMember> {
    const res = await this.ctx.request<{ member: AccountMember }>(
      'POST',
      `/accounts/${enc(accountId)}/members`,
      data,
      { cache: false },
    );
    invalidateAccountMembership(this.ctx, accountId);
    return res.member;
  }

  /**
   * Change a member's role or inheritance.
   * @param accountId - The account's `_id`.
   * @param memberId - The member's `_id`.
   * @param data - New role (never `owner`), inheritance, permission overrides.
   */
  async update(accountId: string, memberId: string, data: UpdateAccountMemberInput): Promise<AccountMember> {
    const res = await this.ctx.request<{ member: AccountMember }>(
      'PATCH',
      `/accounts/${enc(accountId)}/members/${enc(memberId)}`,
      data,
      { cache: false },
    );
    invalidateAccountMembership(this.ctx, accountId);
    return res.member;
  }

  /**
   * Remove a member from an account.
   * @param accountId - The account's `_id`.
   * @param memberId - The member's `_id`.
   */
  async remove(accountId: string, memberId: string): Promise<AccountSuccessResult> {
    const result = await this.ctx.request<AccountSuccessResult>(
      'DELETE',
      `/accounts/${enc(accountId)}/members/${enc(memberId)}`,
      undefined,
      { cache: false },
    );
    invalidateAccountMembership(this.ctx, accountId);
    return result;
  }
}

export class AccountsApi {
  /** Who can act on an account, and with what role. */
  readonly members: AccountMembersApi;

  constructor(private readonly ctx: OxyContext) {
    this.members = new AccountMembersApi(ctx);
  }

  /**
   * List the accounts the caller can access: their own personal (root)
   * account, accounts they own, and accounts shared with them (including
   * external organisations), plus the reachable subtree of each.
   *
   * @param opts - `{ tree: true }` requests the nested tree representation
   *   (`children` populated) instead of a flat list. The flag is part of the
   *   path (`?tree=true`), so the flat and tree variants never share a cache key.
   */
  async list(opts?: ListAccountsOptions): Promise<AccountNode[]> {
    const path = opts?.tree ? '/accounts?tree=true' : '/accounts';
    const res = await this.ctx.request<{ accounts?: AccountNode[] }>('GET', path, undefined, {
      cache: true,
      cacheTTL: MEDIUM_TTL,
    });
    return res.accounts ?? [];
  }

  /**
   * Fetch a single account node by id.
   * @param accountId - The account's `_id`.
   */
  async get(accountId: string): Promise<AccountNode> {
    const res = await this.ctx.request<{ account: AccountNode }>('GET', `/accounts/${enc(accountId)}`, undefined, {
      cache: true,
      cacheTTL: LONG_TTL,
    });
    return res.account;
  }

  /**
   * Switch the active session INTO a managed account.
   *
   * `POST /accounts/:id/switch` with the signed-in operator's bearer. The
   * server authorises the operator (must hold `account:act_as` over the
   * target, directly or inherited — else 403; 404 if missing/archived; 403 if
   * the target is a personal account), then mints a REAL session for the
   * target account in the canonical login shape.
   *
   * The returned session IS the new identity: its `accessToken` is planted as
   * the active token, so every subsequent request authenticates as the target
   * account. The server registers the switched session into the operator's
   * device set, so the switch survives a reload and syncs cross-domain like a
   * normal login.
   *
   * The SDK's identity-scoped GET cache is then fully cleared so every cached
   * read re-fetches as the new account (a same-user token refresh deliberately
   * keeps the warm cache, so the sweep here is explicit).
   *
   * @param accountId - The target account's `_id`.
   * @returns The minted session, already planted as the active session.
   */
  async actAs(accountId: string): Promise<SwitchAccountResult> {
    const res = await this.ctx.request<SwitchAccountResult>('POST', `/accounts/${enc(accountId)}/switch`, undefined, {
      cache: false,
    });
    if (res?.accessToken) {
      this.ctx.oxy.session.setAccessToken(res.accessToken);
    }
    const authuser = res?.authuser;
    // Identity changed → drop the entire GET response cache so no entry
    // personalised for the previous identity is reused.
    this.ctx.oxy.cache.clear();
    return {
      ...res,
      ...(typeof authuser === 'number' ? { authuser } : {}),
      user: normalizeUserIdentity(res.user),
    };
  }

  /**
   * Create a new (non-personal) account. The caller becomes its `owner`.
   * @param data - Account configuration: kind, optional parent, and profile.
   */
  async create(data: CreateAccountInput): Promise<AccountNode> {
    const res = await this.ctx.request<{ account: AccountNode }>('POST', '/accounts', data, { cache: false });
    // A new account changes the accessible forest — bust every cached list.
    evictOxyAccountForestCache(this.ctx.http);
    return res.account;
  }

  /**
   * Update an account's mutable profile fields. Tree placement changes
   * (reparenting) go through the dedicated move endpoint, not here.
   *
   * An account IS a user, so this write changes identity: every identity read
   * of it (`GET /users/<id>`, `GET /profiles/username/<handle>`, …) is evicted
   * too, not only the account-graph keys — see `evictOxyIdentityCache`.
   *
   * @param accountId - The account's `_id`.
   * @param data - Subset of updatable profile fields.
   */
  async update(accountId: string, data: UpdateAccountInput): Promise<AccountNode> {
    const res = await this.ctx.request<{ account: AccountNode }>('PATCH', `/accounts/${enc(accountId)}`, data, {
      cache: false,
    });
    evictOxyAccountForestCache(this.ctx.http, accountId);
    // The parent's children list embeds this account's profile and is keyed by
    // the PARENT id, so it is reachable only from the response node.
    const parentAccountId = res.account?.parentAccountId;
    if (parentAccountId) {
      this.ctx.oxy.cache.delete(`GET:/accounts/${enc(parentAccountId)}/children`);
    }
    evictOxyIdentityCache(this.ctx.http, accountId);
    return res.account;
  }

  /**
   * Archive an account (soft delete). Not `users.deleteMe`, which is the GDPR
   * self-deletion flow.
   * @param accountId - The account's `_id`.
   */
  async archive(accountId: string): Promise<AccountSuccessResult> {
    const result = await this.ctx.request<AccountSuccessResult>('DELETE', `/accounts/${enc(accountId)}`, undefined, {
      cache: false,
    });
    this.ctx.http.invalidateCache({
      keys: [`GET:/accounts/${enc(accountId)}/members`, `GET:/accounts/${enc(accountId)}/credentials`],
    });
    evictOxyAccountForestCache(this.ctx.http, accountId);
    return result;
  }

  /**
   * Transfer ownership of an account to another member (owner only).
   * @param accountId - The account's `_id`.
   * @param data - Target user id.
   */
  async transferOwnership(accountId: string, data: TransferAccountOwnershipInput): Promise<AccountSuccessResult> {
    const result = await this.ctx.request<AccountSuccessResult>(
      'POST',
      `/accounts/${enc(accountId)}/transfer-ownership`,
      data,
      { cache: false },
    );
    // Ownership changes roles in the member list AND the detail, and which
    // accounts the caller "owns" in the list view.
    invalidateAccountMembership(this.ctx, accountId);
    evictOxyAccountForestCache(this.ctx.http);
    return result;
  }
}

/**
 * Bust the cached member list and detail after a membership mutation. Inherited
 * rows on descendant rosters derive from this account's membership, so every
 * per-account sub-resource key (`GET:/accounts/<id>…`) goes, in one pass; the
 * forest list keys (`GET:/accounts`, `GET:/accounts?…`) are excluded by the
 * trailing slash on the prefix.
 */
function invalidateAccountMembership(ctx: OxyContext, accountId: string): void {
  ctx.http.invalidateCache({
    keys: [`GET:/accounts/${enc(accountId)}/members`, oxyAccountDetailCacheKey(accountId)],
    prefixes: [OXY_ACCOUNT_PER_ACCOUNT_CACHE_PREFIX],
  });
}
