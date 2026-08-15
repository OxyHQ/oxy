/**
 * Accounts Methods Mixin
 *
 * The single client surface for the unified Oxy **account graph** (`/accounts`)
 * and the **applications** owned within it (`/applications`).
 *
 * An account is a relational, tree-structured principal (the `User` document
 * generalised): a `personal` account is a human login at the root of its tree;
 * `organization` / `project` / `bot` accounts are non-login principals operated
 * through membership. Accounts form a tree (`parentAccountId`), own
 * applications/bots, and expose a single membership model (`AccountMember`) with
 * a unified role set and an explicit-but-inheritable cascade down the subtree.
 *
 * This mixin is the clean-cut replacement for the former `managedAccounts`,
 * `workspaces`, and `applications` (account-management) mixins. Applications are
 * now owned by an account (`Application.ownerAccountId`) and their access derives
 * from the caller's `AccountMember` on that owning account — there is no separate
 * application-membership surface. The OAuth-consent surface a user sees for
 * THIRD-PARTY apps they authorized (`getPublicApplication`, `listConnectedApps`,
 * `revokeAppGrant`) is unrelated to account ownership and lives in
 * `OxyServices.connectedApps.ts`.
 *
 * Reference accounts by their Mongo `_id` (`accountId`, the underlying
 * `User._id`), applications by their `_id` (`applicationId`), members by their
 * member `_id`, and credentials by their `credentialId`. Never by name, slug, or
 * handle.
 *
 * SWITCHING INTO AN ACCOUNT: `switchToAccount(accountId)` mints a REAL session
 * for the target account and plants it as the active session — there is no
 * per-request "acting-as" header. Identity is carried by the session/token, not
 * a delegation header, so a switch propagates through reload and cross-domain
 * exactly like a login, via the device-first session model (the server
 * registers the switched session into the operator's device-set directly).
 */
import type { User } from '../models/interfaces';
import type { AccountCategoryId, AccountKind, ChildAccountKind } from '@oxyhq/contracts';
import type { SessionLoginResponse } from '../models/session';
import type { OxyServicesBase } from '../OxyServices.base';
import { normalizeUserIdentity } from '../utils/userIdentity';
import { evictOxyIdentityCache } from '../utils/identityCacheSweep';
import { evictOxyAccountForestCache, oxyAccountDetailCacheKey, OXY_ACCOUNT_PER_ACCOUNT_CACHE_PREFIX } from '../utils/accountCacheSweep';
import { CACHE_TIMES } from './mixinHelpers';

// ---------------------------------------------------------------------------
// Account graph types
// ---------------------------------------------------------------------------

/**
 * Account classification, orthogonal to the federation `type`
 * (`local|federated|agent|automated`). `personal` accounts have a direct login;
 * `organization` / `project` / `bot` / `channel` accounts are operated via
 * `AccountMember` and have no direct login. Of those, only the first three may
 * be acted AS — see `isActAsEligibleKind`.
 *
 * Single source of truth is `@oxyhq/contracts`.
 */
export type { AccountCategoryId, AccountKind } from '@oxyhq/contracts';
export {
  ACCOUNT_CATEGORY_IDS,
  ACCOUNT_KINDS,
  MAX_ACCOUNT_CATEGORIES,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  isActAsEligibleKind,
  isSelectableAccountCategoryId,
  kindAcceptsAccountCategories,
} from '@oxyhq/contracts';

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

/** Options accepted by `listAccounts`. */
export interface ListAccountsOptions {
  /**
   * When `true`, request the nested tree representation: each returned node has
   * its `children` populated instead of a flat list keyed by `parentAccountId`.
   */
  tree?: boolean;
}

/** Input accepted by `createAccount`. */
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
   * `isActAsEligibleKind`, so no session can ever have a channel as its subject
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
}

/** Input accepted by `updateAccount`. Tree placement changes go through `/move`. */
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

/** Input accepted by `provisionChannelAccount` (service token + `accounts:provision`). */
export interface ProvisionChannelInput {
  /** Personal account `_id` whose tree owns the new channel. */
  ownerUserId: string;
  username: string;
  name?: { first?: string; last?: string; displayName?: string };
  bio?: string;
  description?: string;
  avatar?: string;
}

/** Input accepted by `provisionChannelMember` (service token + `accounts:provision`). */
export interface ProvisionChannelMemberInput {
  memberUserId: string;
  role: Exclude<AccountRole, 'owner'>;
  inherit?: boolean;
}

/** Result of `provisionChannelAccount`. */
export interface ProvisionChannelResult {
  account: User;
  membership: AccountMember;
}

/** Input accepted by `inviteAccountMember`. The owner role cannot be invited. */
export interface InviteAccountMemberInput {
  /**
   * The username or email of the user to invite. Resolved to a personal account
   * server-side; an unknown value yields a 404 "User not found".
   */
  usernameOrEmail: string;
  role: Exclude<AccountRole, 'owner'>;
}

/** Input accepted by `updateAccountMember`. The owner role cannot be assigned. */
export interface UpdateAccountMemberInput {
  role?: Exclude<AccountRole, 'owner'>;
  inherit?: boolean;
  permissionGrants?: string[];
  permissionRevokes?: string[];
}

/** Input accepted by `transferAccountOwnership`. */
export interface TransferAccountOwnershipInput {
  userId: string;
}

// ---------------------------------------------------------------------------
// Bot (account) service-credential types
// ---------------------------------------------------------------------------

/** Credential kind. Account (bot) credentials are always `service` tokens. */
export type AccountCredentialType = 'service';

/** Deployment environment a bot credential is scoped to. */
export type AccountCredentialEnvironment = 'development' | 'staging' | 'production';

/** Bot credential lifecycle status. */
export type AccountCredentialStatus = 'active' | 'deprecated' | 'revoked';

/** Input accepted by `createAccountCredential`. Credential `type` is always `service`. */
export interface CreateAccountCredentialInput {
  name: string;
  environment: AccountCredentialEnvironment;
  scopes?: string[];
}

/**
 * Client-facing AccountCredential shape (a bot account's service token). The raw
 * secret is NEVER part of this shape — it is returned exactly once, separately,
 * at creation/rotation.
 */
export interface AccountCredential {
  _id: string;
  /** The bot account this credential authenticates as (account `_id`). */
  accountId: string;
  name: string;
  publicKey: string;
  type: AccountCredentialType;
  environment: AccountCredentialEnvironment;
  scopes: string[];
  status: AccountCredentialStatus;
  lastUsedAt?: string;
  expiresAt?: string;
  /**
   * Audit link to the credential this one was rotated FROM. Populated on
   * credentials created via rotation; absent on original credentials.
   */
  rotatedFromCredentialId?: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** Result of creating a bot credential — `secret` is returned ONCE. */
export interface AccountCredentialWithSecret {
  credential: AccountCredential;
  secret: string;
}

/**
 * Result of rotating a bot credential. Extends the create result with audit
 * fields: the new plaintext `secret` is returned ONCE, plus `rotatedFrom` (the
 * previous credential's `credentialId`) and `graceExpiresAt` (ISO string marking
 * when the old credential stops being honoured during the rotation grace window).
 */
export interface RotateAccountCredentialResult extends AccountCredentialWithSecret {
  /** The previous credential's `credentialId` that this rotation supersedes. */
  rotatedFrom: string;
  /** ISO timestamp at which the rotated-from credential's grace window ends. */
  graceExpiresAt: string;
}

// ---------------------------------------------------------------------------
// Application (owned by an account) types
// ---------------------------------------------------------------------------

/**
 * Application classification. Set only by Oxy platform staff — never editable
 * through the normal member-facing update path.
 */
export type ApplicationType = 'first_party' | 'third_party' | 'internal' | 'system';

/** Lifecycle status of an application. */
export type ApplicationStatus = 'active' | 'suspended' | 'deleted' | 'pending_review';

/**
 * Credential kind.
 *
 * The first three are OAuth clients: the `oxy_dk_…` `publicKey` is the
 * `client_id`, and any secret is presented BESIDE it. `service` credentials
 * additionally mint service tokens.
 *
 * `machine` is the OpenAI-SDK-compatible API key (issue #972 §2.3): its
 * credential material is ONE `oxy_sk_…` bearer string returned in `token`
 * exactly once on create/rotate, never in `secret`.
 */
export type ApplicationCredentialType = 'public' | 'confidential' | 'service' | 'machine';

/** Deployment environment an application credential is scoped to. */
export type ApplicationEnvironment = 'development' | 'staging' | 'production';

/** Application credential lifecycle status. */
export type ApplicationCredentialStatus = 'active' | 'deprecated' | 'revoked';

/**
 * Client-facing Application shape returned by the `/applications` API. An
 * application is the OAuth client; it is OWNED by an account
 * (`ownerAccountId`), and the caller's access derives from their `AccountMember`
 * on that owning account (with inheritance).
 */
export interface Application {
  _id: string;
  name: string;
  description?: string;
  websiteUrl?: string;
  /** Public privacy-policy URL, rendered as a legal link on the OAuth consent screen. */
  privacyPolicyUrl?: string;
  /** Public terms-of-service URL, rendered as a legal link on the OAuth consent screen. */
  termsUrl?: string;
  icon?: string;
  type: ApplicationType;
  status: ApplicationStatus;
  isOfficial: boolean;
  isInternal: boolean;
  capabilities: string[];
  redirectUris: string[];
  scopes: string[];
  webhookUrl?: string;
  devWebhookUrl?: string;
  createdByUserId: string;
  /**
   * The account that owns this application (account `_id`). Access to the
   * application derives from the caller's `AccountMember` on this account, with
   * inheritance up the account tree.
   */
  ownerAccountId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The caller's effective membership in the OWNING account (direct or
   * inherited), embedded by the API on list/detail responses, or `null` when the
   * caller has no membership. Use `callerMembership.permissions` to gate UI.
   */
  callerMembership?: AccountMember | null;
}

/**
 * Client-facing ApplicationCredential shape (an application's OAuth client
 * credentials). The raw secret is NEVER part of this shape — it is returned
 * exactly once, separately, at creation/rotation.
 */
export interface ApplicationCredential {
  _id: string;
  applicationId: string;
  name: string;
  publicKey: string;
  /**
   * `oxy_sk_<id>` — the PUBLIC lookup half of a `machine` credential's bearer
   * token, present only on that type. Safe to render: the secret half is 256
   * bits that were shown exactly once and are never returned again.
   */
  tokenPrefix?: string;
  type: ApplicationCredentialType;
  environment: ApplicationEnvironment;
  scopes: string[];
  status: ApplicationCredentialStatus;
  lastUsedAt?: string;
  expiresAt?: string;
  /**
   * Audit link to the credential this one was rotated FROM. Populated on
   * credentials created via rotation; absent on original credentials.
   */
  rotatedFromCredentialId?: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** Input accepted by `createApp`. Staff-only fields are not settable here. */
export interface CreateApplicationInput {
  name: string;
  description?: string;
  websiteUrl?: string;
  /** Public privacy-policy URL (absolute `https://`). Shown on the OAuth consent screen. */
  privacyPolicyUrl?: string;
  /** Public terms-of-service URL (absolute `https://`). Shown on the OAuth consent screen. */
  termsUrl?: string;
  icon?: string;
  redirectUris?: string[];
  scopes?: string[];
  /**
   * Owning account `_id`. Omitted → the API defaults to the caller's personal
   * account.
   */
  ownerAccountId?: string;
}

/** Input accepted by `updateApp`. Staff-only fields are not settable here. */
export interface UpdateApplicationInput {
  name?: string;
  description?: string;
  websiteUrl?: string;
  /** Public privacy-policy URL (absolute `https://`, or `''` to clear). Shown on the OAuth consent screen. */
  privacyPolicyUrl?: string;
  /** Public terms-of-service URL (absolute `https://`, or `''` to clear). Shown on the OAuth consent screen. */
  termsUrl?: string;
  icon?: string;
  redirectUris?: string[];
  scopes?: string[];
  webhookUrl?: string;
  devWebhookUrl?: string;
  status?: ApplicationStatus;
}

/** Input accepted by `createAppCredential`. */
export interface CreateApplicationCredentialInput {
  name: string;
  type: ApplicationCredentialType;
  environment: ApplicationEnvironment;
  scopes?: string[];
  /**
   * Lifetime of a `machine` credential, in seconds — 60 to 730 days. Omit for a
   * key that does not expire on its own.
   *
   * **`machine` only.** On every other credential type `expires_at` means the
   * rotation grace deadline, so a caller setting it at creation would make a
   * brand-new credential indistinguishable from a rotated one. The server
   * REJECTS it for those types rather than ignoring it, so sending it with the
   * wrong `type` is a 400, not a silently dropped field.
   */
  expiresInSeconds?: number;
}

/** Input accepted by `rotateAppCredential`. */
export interface RotateApplicationCredentialInput {
  /**
   * How long the superseded `machine` token keeps working, in seconds — 1 to 30
   * days. Omitting it revokes the previous token the instant the replacement is
   * minted, which is the safe default for a leaked key.
   *
   * **`machine` only, and opt-in.** `confidential`/`service` credentials always
   * retire on the platform's fixed seven-day grace and the server REJECTS this
   * field for them, so their contract is unchanged.
   */
  graceSeconds?: number;
}

/**
 * Result of creating an application credential — credential material is returned
 * ONCE and can never be read back.
 *
 * Exactly one of the two fields carries it, decided by
 * {@link ApplicationCredentialType}: `secret` for a `confidential`/`service`
 * client, `token` for a `machine` API key, and NEITHER for a `public` client
 * (`secret` is `null`). They are separate fields rather than one, so a surface
 * that renders "the secret" cannot silently render an API key's bearer token
 * under the wrong label, or a `null` where a token should be.
 */
export interface ApplicationCredentialWithSecret {
  credential: ApplicationCredential;
  /** The OAuth client secret. `null` for `public` and `machine` credentials. */
  secret: string | null;
  /** The full `oxy_sk_…` bearer token. Present ONLY for a `machine` credential. */
  token?: string;
}

/**
 * Result of rotating an application credential. Extends the create result with
 * audit fields: the new credential material is returned ONCE, plus `rotatedFrom`
 * (the previous credential's `credentialId`) and `graceExpiresAt`.
 */
export interface RotateApplicationCredentialResult extends ApplicationCredentialWithSecret {
  /** The previous credential's `credentialId` that this rotation supersedes. */
  rotatedFrom: string;
  /**
   * ISO timestamp at which the rotated-from credential stops being honoured, or
   * `null` when no grace window was configured and it was revoked outright.
   *
   * Nullable because a `machine` credential's grace is OPT-IN (issue #972 §2.3):
   * rotating an API key without asking for a window kills the old token
   * immediately, and there is then no deadline to report. The OAuth/service
   * types always carry their fixed seven-day deadline.
   */
  graceExpiresAt: string | null;
}

/** Time window for application usage statistics. */
export type ApplicationUsagePeriod = '24h' | '7d' | '30d' | '90d';

/** Aggregate totals for an application over the requested period. */
export interface ApplicationUsageSummary {
  totalRequests: number;
  totalTokens: number;
  totalCredits: number;
  avgResponseTime: number;
  successfulRequests: number;
  errorRequests: number;
}

/** Per-day usage bucket. `_id` is the day key (e.g. `YYYY-MM-DD`). */
export interface ApplicationUsageByDay {
  _id: string;
  requests: number;
  tokens: number;
  credits: number;
}

/** Per-endpoint usage bucket. `_id` is the endpoint identifier. */
export interface ApplicationUsageByEndpoint {
  _id: string;
  requests: number;
  tokens: number;
}

/** Usage statistics for an application over a period. */
export interface ApplicationUsageStats {
  summary: ApplicationUsageSummary;
  byDay: ApplicationUsageByDay[];
  byEndpoint: ApplicationUsageByEndpoint[];
}

/** Result of an archive/remove/revoke/transfer/delete operation. */
export interface AccountSuccessResult {
  success: boolean;
}

/**
 * Result of {@link OxyServicesAccountsMixin.switchToAccount} — the freshly
 * minted session for the target account, in the SAME shape the canonical login
 * / `claimSessionByToken` responses use (`SessionLoginResponse`).
 *
 * `accessToken` is the first access token for the new session (already planted
 * as the active token by `switchToAccount`). The switched session's survival
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

export function OxyServicesAccountsMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Inherited from the auth mixin at runtime. Declared here so service-scoped
     * account provisioning methods can call it with correct typing.
     */
    declare makeServiceRequest: <R = unknown>(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      data?: unknown,
      userId?: string,
    ) => Promise<R>;

    // =========================================================================
    // Accounts
    // =========================================================================

    /**
     * List the accounts the caller can access: their own personal (root)
     * account, accounts they own, and accounts shared with them (including
     * external organisations), plus the reachable subtree of each.
     *
     * @param opts - `{ tree: true }` requests the nested tree representation
     *   (`children` populated) instead of a flat list. The flag is appended to
     *   the path as `?tree=true`, so the response cache keys on it automatically —
     *   the flat and tree variants never collide.
     */
    async listAccounts(opts?: ListAccountsOptions): Promise<AccountNode[]> {
      try {
        const path = opts?.tree ? '/accounts?tree=true' : '/accounts';
        const res = await this.makeRequest<{ accounts?: AccountNode[] }>(
          'GET',
          path,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
        return res.accounts ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Fetch a single account node by id.
     * @param accountId - The account's Mongo `_id`.
     */
    async getAccount(accountId: string): Promise<AccountNode> {
      try {
        const res = await this.makeRequest<{ account: AccountNode }>(
          'GET',
          `/accounts/${encodeURIComponent(accountId)}`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.LONG },
        );
        return res.account;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Switch the active session INTO a managed account.
     *
     * Calls `POST /accounts/:id/switch` with the signed-in operator's bearer.
     * The server authorises the operator (must hold `account:act_as` over the
     * target, directly or inherited — else 403; 404 if missing/archived; 403 if
     * the target is a personal account), then mints a REAL session for the
     * target account and returns it in the canonical login / `claimSessionByToken`
     * shape (`{ sessionId, deviceId, expiresAt, accessToken, user }`).
     *
     * Unlike the removed `X-Acting-As` delegation header, the returned session
     * IS the new identity: this plants `accessToken` as the active token —
     * exactly like `claimSessionByToken` / `verifyChallenge` — so every
     * subsequent request authenticates as the target account.
     *
     * A single call is all that's needed: the server registers the switched
     * session into the operator's `DeviceSession` set directly, inheriting the
     * operator's central `deviceId` so the switch survives a reload and syncs
     * cross-domain via the same device-first session model as a normal login —
     * there is no separate client-side cookie/slot step to make it stick.
     *
     * After planting, the SDK's identity-scoped GET cache is fully cleared so
     * every cached read re-fetches as the new account. (The consuming
     * `OxyContext` additionally invalidates its React Query cache and updates
     * session state from the returned `user`; this clears the SDK's own HTTP
     * cache at the source — `setTokens` deliberately preserves the warm cache for
     * same-user silent refreshes, so the sweep here is explicit.)
     *
     * @param accountId - The target account's Mongo `_id`.
     * @returns The minted session, already planted as the active session.
     */
    async switchToAccount(accountId: string): Promise<SwitchAccountResult> {
      try {
        const res = await this.makeRequest<SwitchAccountResult>(
          'POST',
          `/accounts/${encodeURIComponent(accountId)}/switch`,
          undefined,
          { cache: false },
        );

        // Plant the freshly minted session as the ACTIVE session, mirroring
        // `claimSessionByToken` / `verifyChallenge`: the response body carries
        // the first access token.
        if (res?.accessToken) {
          this.setTokens(res.accessToken);
        }

        // The switch route now registers the switched session in the device's
        // server-side DeviceSession set directly (device-first), so there is no
        // client-side refresh-cookie slot to establish — the `authuser` comes
        // from the switch response (optional-chained to match `res?.accessToken`).
        const authuser = res?.authuser;

        // Identity changed → drop the entire GET response cache so no entry
        // personalised for the previous identity is reused. Cache keys are
        // identity-scoped, so a different identity could not READ the old
        // entries anyway, but clearing guarantees a clean refetch as the new
        // account and frees the prior identity's resident data.
        this.clearCache();

        return {
          ...res,
          ...(typeof authuser === 'number' ? { authuser } : {}),
          user: normalizeUserIdentity(res.user),
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Create a new (non-personal) account. The caller becomes its `owner`.
     * @param data - Account configuration: kind, optional parent, and profile.
     */
    async createAccount(data: CreateAccountInput): Promise<AccountNode> {
      try {
        const res = await this.makeRequest<{ account: AccountNode }>(
          'POST',
          '/accounts',
          data,
          { cache: false },
        );
        // A new account changes the accessible forest — bust every cached list
        // (flat + tree) so it appears on the next `listAccounts()` read.
        evictOxyAccountForestCache(this);
        return res.account;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Mint a `channel` account under `ownerUserId` via service auth
     * (`accounts:provision` scope). Requires `configureServiceAuth` first.
     */
    async provisionChannelAccount(data: ProvisionChannelInput): Promise<ProvisionChannelResult> {
      try {
        return await this.makeServiceRequest<ProvisionChannelResult>(
          'POST',
          '/accounts/service/channels',
          data,
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Grant membership on a channel account via service auth
     * (`accounts:provision` scope).
     */
    async provisionChannelMember(
      channelAccountId: string,
      data: ProvisionChannelMemberInput,
    ): Promise<{ member: AccountMember }> {
      try {
        return await this.makeServiceRequest<{ member: AccountMember }>(
          'POST',
          `/accounts/service/channels/${encodeURIComponent(channelAccountId)}/members`,
          data,
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Revoke membership on a channel account via service auth
     * (`accounts:provision` scope).
     */
    async revokeChannelMember(
      channelAccountId: string,
      memberUserId: string,
    ): Promise<AccountSuccessResult> {
      try {
        return await this.makeServiceRequest<AccountSuccessResult>(
          'DELETE',
          `/accounts/service/channels/${encodeURIComponent(channelAccountId)}/members/${encodeURIComponent(memberUserId)}`,
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Update an account's mutable profile fields. Tree placement changes
     * (reparenting) go through the dedicated move endpoint, not here.
     *
     * An account IS a user, so this write changes identity — and a profile
     * screen never reads `/accounts/<id>`. It reads `GET /users/<id>` and
     * `GET /profiles/username/<handle>`, both cached for 5 minutes in the
     * CALLER'S OWN process, so busting only the account-graph keys left every
     * profile surface serving the pre-edit avatar and name for the full TTL
     * with a perfectly healthy server (the cross-service `oxy:user:invalidate`
     * signal does not help: it evicts BACKEND caches, and cannot reach a cache
     * living in a browser tab). {@link evictOxyIdentityCache} owns that key
     * list — see its docs for why the handle-keyed entries are prefix-swept
     * (a RENAME leaves the old handle's entry unreachable by any targeted key).
     *
     * @param accountId - The account's Mongo `_id`.
     * @param data - Subset of updatable profile fields.
     */
    async updateAccount(
      accountId: string,
      data: UpdateAccountInput,
    ): Promise<AccountNode> {
      try {
        const res = await this.makeRequest<{ account: AccountNode }>(
          'PATCH',
          `/accounts/${encodeURIComponent(accountId)}`,
          data,
          { cache: false },
        );
        // Bust the cached detail and every list (which embeds account profile
        // data) so neither serves the pre-update snapshot.
        evictOxyAccountForestCache(this, accountId);
        // The parent's children list embeds this account's profile and is keyed
        // by the PARENT id, so it is reachable only from the response node.
        const parentAccountId = res.account?.parentAccountId;
        if (parentAccountId) {
          this.clearCacheEntry(
            `GET:/accounts/${encodeURIComponent(parentAccountId)}/children`,
          );
        }
        // Every identity read of this account, whichever key it lands under.
        evictOxyIdentityCache(this, accountId);
        return res.account;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Archive an account (soft delete). Named `archiveAccount` — NOT
     * `deleteAccount`, which is reserved for the GDPR self-deletion flow on the
     * user mixin (`OxyServices.user.ts`).
     * @param accountId - The account's Mongo `_id`.
     */
    async archiveAccount(accountId: string): Promise<AccountSuccessResult> {
      try {
        const result = await this.makeRequest<AccountSuccessResult>(
          'DELETE',
          `/accounts/${encodeURIComponent(accountId)}`,
          undefined,
          { cache: false },
        );
        // Bust every cached representation of the archived account.
        this.clearCacheEntry(`GET:/accounts/${encodeURIComponent(accountId)}/members`);
        this.clearCacheEntry(`GET:/accounts/${encodeURIComponent(accountId)}/credentials`);
        evictOxyAccountForestCache(this, accountId);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * List the direct child accounts of an account.
     * @param accountId - The parent account's Mongo `_id`.
     */
    async listChildAccounts(accountId: string): Promise<AccountNode[]> {
      try {
        const res = await this.makeRequest<{ accounts?: AccountNode[] }>(
          'GET',
          `/accounts/${encodeURIComponent(accountId)}/children`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
        return res.accounts ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // Account members
    // =========================================================================

    /**
     * List the members of an account: the membership rows ON it, plus the rows
     * on its ancestors that cascade into it. Each entry carries `source`
     * (`direct` | `inherited`) saying which it is.
     *
     * Inherited entries are members in every sense the server enforces — an
     * ancestor row with `inherit: true` resolves through
     * `resolveEffectiveAccess` and confers every account permission on the
     * descendant, `account:act_as` included — so a roster that omitted them
     * answered `[]` for accounts several people could act on.
     *
     * Two things follow for a caller. An entry's `accountId` is the account its
     * ROW lives on, so an inherited entry names an ancestor rather than the
     * account you asked about; and the member-mutation endpoints only accept
     * rows on the account in the path, so gate any edit/remove/transfer
     * affordance on `source === 'direct'`.
     *
     * Asking what the CALLER holds over an account is a different question, and
     * scanning this list for yourself is the wrong way to answer it — use
     * {@link OxyServicesAccountsMixin.getAccount}, whose `callerMembership` is
     * the server's own resolution.
     *
     * @param accountId - The account's Mongo `_id`.
     */
    async listAccountMembers(accountId: string): Promise<AccountMember[]> {
      try {
        const res = await this.makeRequest<{ members?: AccountMember[] }>(
          'GET',
          `/accounts/${encodeURIComponent(accountId)}/members`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
        return res.members ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Add a member to an account.
     * @param accountId - The account's Mongo `_id`.
     * @param data - Target user's username or email and role (never `owner`).
     *   The server resolves `usernameOrEmail` to a personal account; an unknown
     *   value yields a 404 "User not found".
     */
    async inviteAccountMember(
      accountId: string,
      data: InviteAccountMemberInput,
    ): Promise<AccountMember> {
      try {
        const res = await this.makeRequest<{ member: AccountMember }>(
          'POST',
          `/accounts/${encodeURIComponent(accountId)}/members`,
          data,
          { cache: false },
        );
        this._invalidateAccountMembership(accountId);
        return res.member;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Change a member's role.
     * @param accountId - The account's Mongo `_id`.
     * @param memberId - The member's Mongo `_id`.
     * @param data - New role (never `owner`).
     */
    async updateAccountMember(
      accountId: string,
      memberId: string,
      data: UpdateAccountMemberInput,
    ): Promise<AccountMember> {
      try {
        const res = await this.makeRequest<{ member: AccountMember }>(
          'PATCH',
          `/accounts/${encodeURIComponent(accountId)}/members/${encodeURIComponent(memberId)}`,
          data,
          { cache: false },
        );
        this._invalidateAccountMembership(accountId);
        return res.member;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Remove a member from an account.
     * @param accountId - The account's Mongo `_id`.
     * @param memberId - The member's Mongo `_id`.
     */
    async removeAccountMember(
      accountId: string,
      memberId: string,
    ): Promise<AccountSuccessResult> {
      try {
        const result = await this.makeRequest<AccountSuccessResult>(
          'DELETE',
          `/accounts/${encodeURIComponent(accountId)}/members/${encodeURIComponent(memberId)}`,
          undefined,
          { cache: false },
        );
        this._invalidateAccountMembership(accountId);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Transfer ownership of an account to another member (owner only).
     * @param accountId - The account's Mongo `_id`.
     * @param data - Target user id.
     */
    async transferAccountOwnership(
      accountId: string,
      data: TransferAccountOwnershipInput,
    ): Promise<AccountSuccessResult> {
      try {
        const result = await this.makeRequest<AccountSuccessResult>(
          'POST',
          `/accounts/${encodeURIComponent(accountId)}/transfer-ownership`,
          data,
          { cache: false },
        );
        // Ownership change alters roles in the member list AND the detail, and
        // can change which accounts the caller "owns" in the list view.
        this._invalidateAccountMembership(accountId);
        evictOxyAccountForestCache(this);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // Bot (account) service credentials  —  /accounts/:id/credentials
    // =========================================================================

    /**
     * List a bot account's service credentials. The response NEVER includes
     * secrets.
     * @param accountId - The account's Mongo `_id`.
     */
    async listAccountCredentials(accountId: string): Promise<AccountCredential[]> {
      try {
        const res = await this.makeRequest<{ credentials?: AccountCredential[] }>(
          'GET',
          `/accounts/${encodeURIComponent(accountId)}/credentials`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
        return res.credentials ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Create a service credential for a bot account. The plaintext `secret` is
     * returned exactly ONCE; the server stores only a hash and will never return
     * it again.
     * @param accountId - The account's Mongo `_id`.
     * @param data - Credential configuration (`type` is always `service`).
     */
    async createAccountCredential(
      accountId: string,
      data: CreateAccountCredentialInput,
    ): Promise<AccountCredentialWithSecret> {
      try {
        const result = await this.makeRequest<AccountCredentialWithSecret>(
          'POST',
          `/accounts/${encodeURIComponent(accountId)}/credentials`,
          data,
          { cache: false },
        );
        this.clearCacheEntry(`GET:/accounts/${encodeURIComponent(accountId)}/credentials`);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Rotate a bot credential's secret. The new plaintext `secret` is returned
     * exactly ONCE, along with audit fields: `rotatedFrom` (the previous
     * credentialId) and `graceExpiresAt` (ISO string for the grace window during
     * which the old credential is still honoured).
     * @param accountId - The account's Mongo `_id`.
     * @param credentialId - The credential's Mongo `_id`.
     */
    async rotateAccountCredential(
      accountId: string,
      credentialId: string,
    ): Promise<RotateAccountCredentialResult> {
      try {
        const result = await this.makeRequest<RotateAccountCredentialResult>(
          'POST',
          `/accounts/${encodeURIComponent(accountId)}/credentials/${encodeURIComponent(credentialId)}/rotate`,
          undefined,
          { cache: false },
        );
        // Rotation changes credential status/audit fields surfaced by the list.
        this.clearCacheEntry(`GET:/accounts/${encodeURIComponent(accountId)}/credentials`);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Revoke a bot credential (`status='revoked'`). Revoked credentials can no
     * longer authenticate.
     * @param accountId - The account's Mongo `_id`.
     * @param credentialId - The credential's Mongo `_id`.
     */
    async revokeAccountCredential(
      accountId: string,
      credentialId: string,
    ): Promise<AccountSuccessResult> {
      try {
        const result = await this.makeRequest<AccountSuccessResult>(
          'DELETE',
          `/accounts/${encodeURIComponent(accountId)}/credentials/${encodeURIComponent(credentialId)}`,
          undefined,
          { cache: false },
        );
        // Revocation flips the credential's status in the cached list.
        this.clearCacheEntry(`GET:/accounts/${encodeURIComponent(accountId)}/credentials`);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // Applications owned by an account  —  /applications
    // =========================================================================

    /**
     * List the applications owned by an account. Backed by
     * `GET /applications?ownerAccountId=<id>`.
     * @param accountId - The owning account's Mongo `_id`.
     */
    async listAccountApps(accountId: string): Promise<Application[]> {
      try {
        const res = await this.makeRequest<{ applications?: Application[] }>(
          'GET',
          `/applications?ownerAccountId=${encodeURIComponent(accountId)}`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
        return res.applications ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Create a new application owned by an account.
     * @param data - Application configuration. `ownerAccountId` defaults to the
     *   caller's personal account when omitted. Staff-only fields are ignored.
     */
    async createApp(data: CreateApplicationInput): Promise<Application> {
      try {
        const res = await this.makeRequest<{ application: Application }>(
          'POST',
          '/applications',
          data,
          { cache: false },
        );
        // Bust every cached application list (per owning account) so the new app
        // appears on the next `listAccountApps()` read.
        this._invalidateAppLists();
        return res.application;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Fetch a single application by id.
     * @param applicationId - The application's Mongo `_id`.
     */
    async getApp(applicationId: string): Promise<Application> {
      try {
        const res = await this.makeRequest<{ application: Application }>(
          'GET',
          `/applications/${encodeURIComponent(applicationId)}`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.LONG },
        );
        return res.application;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Update an application's mutable fields.
     * @param applicationId - The application's Mongo `_id`.
     * @param data - Subset of updatable fields. Staff-only fields are ignored.
     */
    async updateApp(
      applicationId: string,
      data: UpdateApplicationInput,
    ): Promise<Application> {
      try {
        const res = await this.makeRequest<{ application: Application }>(
          'PATCH',
          `/applications/${encodeURIComponent(applicationId)}`,
          data,
          { cache: false },
        );
        // Bust the cached detail and every list (which embeds application fields).
        this.clearCacheEntry(`GET:/applications/${encodeURIComponent(applicationId)}`);
        this._invalidateAppLists();
        return res.application;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Soft-delete an application.
     * @param applicationId - The application's Mongo `_id`.
     */
    async deleteApp(applicationId: string): Promise<AccountSuccessResult> {
      try {
        const result = await this.makeRequest<AccountSuccessResult>(
          'DELETE',
          `/applications/${encodeURIComponent(applicationId)}`,
          undefined,
          { cache: false },
        );
        // Bust every cached representation of the deleted application.
        this.clearCacheEntry(`GET:/applications/${encodeURIComponent(applicationId)}`);
        this.clearCacheEntry(`GET:/applications/${encodeURIComponent(applicationId)}/credentials`);
        this._invalidateAppLists();
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // Application OAuth credentials  —  /applications/:appId/credentials
    // =========================================================================

    /**
     * List an application's OAuth credentials. The response NEVER includes
     * secrets.
     * @param applicationId - The application's Mongo `_id`.
     */
    async listAppCredentials(applicationId: string): Promise<ApplicationCredential[]> {
      try {
        const res = await this.makeRequest<{ credentials?: ApplicationCredential[] }>(
          'GET',
          `/applications/${encodeURIComponent(applicationId)}/credentials`,
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
        return res.credentials ?? [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Create an application credential. The plaintext `secret` is returned
     * exactly ONCE; the server stores only a hash and will never return it again.
     * @param applicationId - The application's Mongo `_id`.
     * @param data - Credential configuration.
     */
    async createAppCredential(
      applicationId: string,
      data: CreateApplicationCredentialInput,
    ): Promise<ApplicationCredentialWithSecret> {
      try {
        const result = await this.makeRequest<ApplicationCredentialWithSecret>(
          'POST',
          `/applications/${encodeURIComponent(applicationId)}/credentials`,
          data,
          { cache: false },
        );
        this.clearCacheEntry(`GET:/applications/${encodeURIComponent(applicationId)}/credentials`);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Rotate an application credential's secret. The new plaintext `secret` is
     * returned exactly ONCE, along with audit fields: `rotatedFrom` (the previous
     * credentialId) and `graceExpiresAt` (ISO string for the grace window during
     * which the old credential is still honoured).
     * @param applicationId - The application's Mongo `_id`.
     * @param credentialId - The credential's Mongo `_id`.
     * @param options - `graceSeconds` keeps a superseded `machine` token working
     *   for that long. Omitted, the previous token dies the moment the
     *   replacement is minted.
     */
    async rotateAppCredential(
      applicationId: string,
      credentialId: string,
      options?: RotateApplicationCredentialInput,
    ): Promise<RotateApplicationCredentialResult> {
      try {
        const result = await this.makeRequest<RotateApplicationCredentialResult>(
          'POST',
          `/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(credentialId)}/rotate`,
          options,
          { cache: false },
        );
        // Rotation changes credential status/audit fields surfaced by the list.
        this.clearCacheEntry(`GET:/applications/${encodeURIComponent(applicationId)}/credentials`);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Revoke an application credential (`status='revoked'`). Revoked credentials
     * can no longer authenticate.
     * @param applicationId - The application's Mongo `_id`.
     * @param credentialId - The credential's Mongo `_id`.
     */
    async revokeAppCredential(
      applicationId: string,
      credentialId: string,
    ): Promise<AccountSuccessResult> {
      try {
        const result = await this.makeRequest<AccountSuccessResult>(
          'DELETE',
          `/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(credentialId)}`,
          undefined,
          { cache: false },
        );
        // Revocation flips the credential's status in the cached list.
        this.clearCacheEntry(`GET:/applications/${encodeURIComponent(applicationId)}/credentials`);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Fetch usage statistics for an application.
     * @param applicationId - The application's Mongo `_id`.
     * @param period - Time window (defaults to the server default).
     */
    async getAppUsage(
      applicationId: string,
      period?: ApplicationUsagePeriod,
    ): Promise<ApplicationUsageStats> {
      try {
        return await this.makeRequest<ApplicationUsageStats>(
          'GET',
          `/applications/${encodeURIComponent(applicationId)}/usage`,
          period ? { period } : undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =========================================================================
    // Cache-invalidation helpers
    // =========================================================================

    /**
     * Bust the cached member list and detail for an account after a membership
     * mutation. The member list (`listAccountMembers`) and the detail
     * (`getAccount`, which can embed the caller's membership) both go stale when
     * the member set or a member's role changes.
     *
     * Internal helper (leading underscore); not part of the supported public
     * surface. Public rather than `private` because mixins compose into an
     * exported anonymous class, where TypeScript cannot represent a private
     * member in the emitted declaration file (TS4094).
     *
     * The forest keys themselves are NOT owned here — see
     * `utils/accountCacheSweep`, which the user mixin has to reach as well.
     */
    _invalidateAccountMembership(accountId: string): void {
      this.clearCacheEntry(`GET:/accounts/${encodeURIComponent(accountId)}/members`);
      this.clearCacheEntry(oxyAccountDetailCacheKey(accountId));
      // Inherited rows on descendant rosters are derived from this account's
      // membership table — a targeted clear of only the mutated account's keys
      // leaves every other cached `…/members` list serving stale inherited
      // roles until MEDIUM TTL. Sweep all per-account sub-resource keys instead;
      // the forest list keys (`GET:/accounts`, `GET:/accounts?…`) are excluded
      // by the trailing slash on the prefix (see accountCacheSweep).
      this.clearCacheByPrefix(OXY_ACCOUNT_PER_ACCOUNT_CACHE_PREFIX);
    }

    /**
     * Bust every cached application list. `listAccountApps(accountId)` keys each
     * owner-scoped list as `GET:/applications?ownerAccountId=<id>` (the query
     * string is part of the URL path). A change to any list (create/delete)
     * invalidates them all, so we clear the unscoped entry plus every `?`-query
     * variant via a prefix sweep. The prefix `GET:/applications?` matches only the
     * query-string list variants, never the `GET:/applications/<id>…`
     * detail/sub-resource keys.
     *
     * Internal helper (leading underscore); see `_invalidateAccountMembership`
     * for why this is public rather than `private`.
     */
    _invalidateAppLists(): void {
      this.clearCacheEntry('GET:/applications');
      this.clearCacheByPrefix('GET:/applications?');
    }
  };
}
