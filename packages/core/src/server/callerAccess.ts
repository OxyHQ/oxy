/**
 * The person behind a request, in an Oxy account and over an Oxy application:
 * `OxyServer.accountAccessFor` and `OxyServer.applicationAccessFor`.
 *
 * Both read Oxy with the request's OWN verified bearer (an `OxyUserClient`),
 * so Oxy resolves the HUMAN operator from the session — a person acting as
 * their organization is answered for themselves — with inheritance, per-member
 * grants and revokes applied. Nothing else the client sends is consulted.
 *
 * ```ts
 * // Can the caller update this store (an Oxy account) in my app?
 * const access = await oxy.accountAccessFor(req, storeAccountId, { fresh: true });
 * if (!access.has('account:update')) throw new OxyAccessError('ACCESS_DENIED', '…');
 *
 * // Can the caller manage webhooks of application A (developer RBAC)?
 * const app = await oxy.applicationAccessFor(req, applicationId);
 * if (!app.has('webhooks:update')) …
 * ```
 *
 * Which reader answers which question is in `./callerAuthority`; the short
 * version: `appPermissionsFor` is about THIS backend's own declared operator
 * keys, `applicationAccessFor` about any application through the account that
 * owns it, `accountAccessFor` about an account. For work with no person
 * present (a background import), `oxy.accounts.accessFor(accountId, userId)`
 * asks with the service's own token instead.
 *
 * Node only; reachable solely from `@oxy.so/core/server`.
 */

import {
  accountAccessGrantSchema,
  type AccountAccessSource,
  type AccountKind,
} from '@oxy.so/contracts';
import type { AccountRelationship } from '../api/accounts';
import type { ApplicationStatus, ApplicationType } from '../api/apps';
import {
  accessFailure,
  CallerAuthorityCache,
  OxyAccessError,
  permissionSet,
  readCallerSession,
  type OxyCallerRequest,
  type OxyCallerSession,
} from './callerAuthority';

/** What the person behind a request may do in one Oxy account. */
export interface OxyAccountAccess {
  readonly accountId: string;
  readonly kind: AccountKind;
  /** `self` for their own personal account, `owner`, or `member` (direct or inherited). */
  readonly relationship: AccountRelationship;
  /** Informational; gate on `permissions` / `has`, never on the role name. */
  readonly role: string;
  /** Where the access comes from: `self`, a `direct` membership, or one `inherited` from an ancestor. */
  readonly source: AccountAccessSource;
  /** The EFFECTIVE account permissions (role baseline, grants, revokes), sorted. */
  readonly permissions: readonly string[];
  has(permission: string): boolean;
}

/** What the person behind a request may do to one Oxy application, through its owning account. */
export interface OxyApplicationAccess {
  readonly applicationId: string;
  /** The account that owns the application; the access derives from the caller's membership there. */
  readonly ownerAccountId: string;
  /**
   * Whether the application is one of Oxy's own: `isOfficial`, `isInternal`,
   * or typed `first_party` / `internal` / `system` — the rule oxy-api applies
   * to every trust decision (`isTrustedApplication`). All of those fields are
   * staff-controlled; a self-service `third_party` application is never
   * official, whatever its owner sets.
   */
  readonly official: boolean;
  /**
   * The application's lifecycle status. A `suspended` or `pending_review`
   * application is still answered (its members may read it); whether it may
   * act is the caller's decision.
   */
  readonly status: ApplicationStatus;
  /** Informational; gate on `permissions` / `has`, never on the role name. */
  readonly role: string;
  /** The application permissions (`app:read`, `app:update`, `webhooks:update`, …), sorted. */
  readonly permissions: readonly string[];
  has(permission: string): boolean;
}

export interface CallerAccessOptions {
  /** Skip the cache and ask Oxy (the answer still refreshes the cache). Use before a write. */
  fresh?: boolean;
}

/** What the readers need from the server they belong to. */
export interface CallerAccessHost {
  /** `GET /accounts/:id` with this bearer, uncached. Rejects with the API error. */
  readAccount(accountId: string, accessToken: string): Promise<unknown>;
  /** `GET /applications/:id` with this bearer, uncached. Rejects with the API error. */
  readApplication(applicationId: string, accessToken: string): Promise<unknown>;
  readonly ttlMs: number;
}

function callerSession(req: OxyCallerRequest): OxyCallerSession {
  const caller = readCallerSession(req);
  if (caller.ok) return caller.session;
  throw new OxyAccessError(
    'ACCESS_SESSION_REQUIRED',
    caller.reason === 'service'
      ? 'This request is authenticated by a service token; account and application access belong to a person in a session'
      : 'No verified user session on this request; mount middleware.auth() first',
  );
}

function requireId(id: unknown, what: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError(`${what} must be a non-empty string`);
  }
  return id;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : null;
}

const RELATIONSHIPS: readonly AccountRelationship[] = ['self', 'owner', 'member'];
const APPLICATION_TYPES: readonly ApplicationType[] = [
  'first_party',
  'third_party',
  'internal',
  'system',
];
const OFFICIAL_TYPES: readonly ApplicationType[] = ['first_party', 'internal', 'system'];
/** `deleted` is absent on purpose: Oxy answers a deleted application 404. */
const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'active',
  'suspended',
  'pending_review',
];

/** `GET /accounts/:id` → the caller's effective access, or `null` for a malformed answer. */
export function parseAccountAccess(accountId: string, answer: unknown): OxyAccountAccess | null {
  const node = record(answer);
  if (!node || node.accountId !== accountId) return null;
  const relationship = node.relationship as AccountRelationship;
  if (!RELATIONSHIPS.includes(relationship) || typeof node.kind !== 'string') return null;
  const grant = accountAccessGrantSchema.safeParse(node.callerAccess);
  if (!grant.success) return null;
  return Object.freeze({
    accountId,
    kind: node.kind as AccountKind,
    relationship,
    role: grant.data.role,
    source: grant.data.source,
    ...permissionSet(grant.data.permissions),
  });
}

/** `GET /applications/:id` → the caller's access over it, or `null` for a malformed answer. */
export function parseApplicationAccess(
  applicationId: string,
  answer: unknown,
): OxyApplicationAccess | null {
  const application = record(answer);
  if (!application || application._id !== applicationId) return null;
  const ownerAccountId = application.ownerAccountId;
  const type = application.type as ApplicationType;
  const status = application.status as ApplicationStatus;
  const membership = record(application.callerMembership);
  const permissions = stringArray(membership?.permissions);
  if (
    typeof ownerAccountId !== 'string' ||
    ownerAccountId === '' ||
    typeof application.isOfficial !== 'boolean' ||
    typeof application.isInternal !== 'boolean' ||
    !APPLICATION_TYPES.includes(type) ||
    !APPLICATION_STATUSES.includes(status) ||
    !membership ||
    typeof membership.role !== 'string' ||
    membership.role === '' ||
    membership.ownerAccountId !== ownerAccountId ||
    !permissions
  ) {
    return null;
  }
  return Object.freeze({
    applicationId,
    ownerAccountId,
    official: application.isOfficial || application.isInternal || OFFICIAL_TYPES.includes(type),
    status,
    role: membership.role,
    ...permissionSet(permissions),
  });
}

/** The caches and lookups behind `accountAccessFor` / `applicationAccessFor`. One per server. */
export class OxyCallerAccessResolver {
  private readonly accounts: CallerAuthorityCache<OxyAccountAccess>;
  private readonly applications: CallerAuthorityCache<OxyApplicationAccess>;

  constructor(private readonly host: CallerAccessHost) {
    this.accounts = new CallerAuthorityCache<OxyAccountAccess>(host.ttlMs);
    this.applications = new CallerAuthorityCache<OxyApplicationAccess>(host.ttlMs);
  }

  async account(
    req: OxyCallerRequest,
    accountId: string,
    options: CallerAccessOptions = {},
  ): Promise<OxyAccountAccess> {
    const id = requireId(accountId, 'accountId');
    const session = callerSession(req);
    return this.accounts.read([id], session, options.fresh === true, async () => {
      const answer = await this.host
        .readAccount(id, session.accessToken)
        .catch((error: unknown) => {
          throw accessFailure(error, `account ${id}`);
        });
      const access = parseAccountAccess(id, answer);
      if (!access) {
        throw new OxyAccessError(
          'ACCESS_UNAVAILABLE',
          `Oxy answered account ${id} without the caller's access`,
        );
      }
      return access;
    });
  }

  async application(
    req: OxyCallerRequest,
    applicationId: string,
    options: CallerAccessOptions = {},
  ): Promise<OxyApplicationAccess> {
    const id = requireId(applicationId, 'applicationId');
    const session = callerSession(req);
    return this.applications.read([id], session, options.fresh === true, async () => {
      const answer = await this.host
        .readApplication(id, session.accessToken)
        .catch((error: unknown) => {
          throw accessFailure(error, `application ${id}`);
        });
      const access = parseApplicationAccess(id, answer);
      if (!access) {
        throw new OxyAccessError(
          'ACCESS_UNAVAILABLE',
          `Oxy answered application ${id} without the caller's access`,
        );
      }
      return access;
    });
  }

  invalidate(filter: { userId?: string } = {}): void {
    this.accounts.invalidate(filter);
    this.applications.invalidate(filter);
  }
}
