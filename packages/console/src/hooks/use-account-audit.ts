import { useInfiniteQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { isPermissionRefused } from '@/lib/api-error';

// ===========================================================================
// The two ACCOUNT-LEVEL audit reads (issue #972, "audit dashboards for
// credential and billing changes").
//
//   GET /accounts/:id/audit          — what changed, and who did it.
//   GET /accounts/:id/billing/audit  — what changed about the money.
//
// Both are computed server-side and cursor-paginated, and neither shape is
// published in `@oxyhq/contracts`: they are projections owned by
// `services/accountAuditTrail.service.ts` and
// `services/accountBillingAudit.service.ts`. So the wire types are restated
// here — the same thing `CredentialAuditEvent` does in `use-applications.ts` —
// rather than imported from a package that does not export them.
//
// ## The cursor is OPAQUE, and this file is where that is kept true
//
// Both cursors encode a compound keyset — `(createdAt, source, id)` for the
// trail, `(createdAt, id)` for the ledger — base64url-encoded, compared row-wise
// in SQL. Rows genuinely share an instant (a rotation writes two rows in one
// transaction; the trail unions two tables that share none of their ids), so a
// client that paged on `createdAt` alone, or re-sorted a page after fetching it,
// would drop whichever tied row the next query happened to order first. Silently:
// the page still looks like a page.
//
// The page param is therefore typed `string | null` and NEVER inspected,
// decoded, compared or reconstructed anywhere in the Console. It goes back to
// the server exactly as it arrived, and `getNextPageParam` reads the server's
// own `nextCursor` rather than deriving one from the last row.
// ===========================================================================

/** Which of the two audit tables an entry came from. Also the ordering's tiebreak. */
export type AccountAuditSource = 'application_credential' | 'provider_connection';

/**
 * Who caused an event — a DISCRIMINATED union, not a nullable user id.
 *
 * The server projects it this way because the two source tables do not share an
 * actor model, and flattening them loses the distinction that matters:
 *
 *  - `user` — a named person, with their id.
 *  - `service` — the account's own service credential. Only a connection event
 *    can be this; the credential table cannot record one.
 *  - `platform` — Oxy's own machinery, with no principal at all.
 *  - `none` — NOBODY acted. A refused credential validation: a request arrived
 *    and was turned away, so there is no actor to name.
 *  - `unknown` — the row predates `actor_kind` (#1043) and never recorded one.
 *
 * Three of those five carry no user id, which is exactly why the kind travels to
 * the client. Reading "is there an id" instead is the bug #1063 fixed on the
 * per-connection screen, where every `used` event — the most numerous row on a
 * connection actually serving traffic — is written `platform` and was being
 * labelled as the customer's own service credential.
 */
export type AccountAuditActor =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'service' }
  | { readonly kind: 'platform' }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' };

/** One entry of an account's trail. */
export interface AccountAuditEntry {
  readonly source: AccountAuditSource;
  /** Each source's own closed vocabulary; the two are never merged into one enum. */
  readonly eventType: string;
  readonly actor: AccountAuditActor;
  /** The credential or the connection the event is about. */
  readonly subjectId: string;
  /** The owning application, for a credential event. Null for a connection. */
  readonly applicationId: string | null;
  /** Why a credential validation was refused. Null everywhere else. */
  readonly reason: string | null;
  readonly environment: string | null;
  readonly createdAt: string;
}

/** Which way value moved across the boundary of the customer's own accounts. */
export type BillingAuditDirection = 'in' | 'out' | 'none';

/**
 * The four customer-facing ledger entry kinds. The other five — the reservation
 * kinds, `settlement` and `invoice_rounding` — are withheld by the server and
 * never reach this file.
 */
export type BillingAuditKind =
  | 'top_up'
  | 'promotional_grant'
  | 'settlement_reversal'
  | 'invoice_payment';

/**
 * Who authored a ledger entry, coarsely — and coarsely is the whole point.
 *
 * `staff` means a named person at Oxy did this; the API does not project the
 * name, and nothing here asks for it. `machine` means no person authored it: a
 * processor webhook, the expiry sweep, the inference edge. `unknown` means the
 * row predates the actor columns and never recorded one, which is a different
 * statement from `machine` and is kept different.
 */
export type BillingAuditActorKind = 'staff' | 'machine' | 'unknown';

/** One customer-facing change to an account's money. */
export interface BillingAuditEntry {
  /** `billing_ledger_entries.id` — the reference a customer quotes to support. */
  readonly id: string;
  readonly kind: BillingAuditKind;
  readonly currency: string;
  /**
   * An exact, NON-NEGATIVE decimal string. Never a `number`, and never given a
   * sign: `direction` carries which way it went, because a signed amount is how
   * a reversal silently becomes a second charge.
   */
  readonly amount: string;
  readonly direction: BillingAuditDirection;
  readonly actorKind: BillingAuditActorKind;
  /** The settled charge a reversal reverses. Null for every other kind. */
  readonly receiptId: string | null;
  /** The refund a reversal produced. Null for every other kind. */
  readonly refundId: string | null;
  /** The invoice a payment settled. Null for every other kind. */
  readonly invoiceId: string | null;
  readonly createdAt: string;
}

/** The envelope both routes answer with. `nextCursor` is null when exhausted. */
interface AuditPageResponse<TEntry> {
  readonly data: ReadonlyArray<TEntry>;
  readonly count: number;
  readonly nextCursor: string | null;
}

const queryKeys = {
  trail: (accountId: string) => ['account-audit', accountId] as const,
  billing: (accountId: string) => ['account-billing-audit', accountId] as const,
};

/**
 * How many entries one page asks for.
 *
 * Both routes accept 1–200 and default to 50. These pages are read by scrolling
 * rather than analysed in bulk, and a page that arrives is worth more than a
 * bigger one that takes longer; more is one click away.
 */
const AUDIT_PAGE_SIZE = 50;

/**
 * Retry policy for both reads.
 *
 * A refusal is an ANSWER, not a failure: `/accounts/:id/audit` demands both
 * `credentials:read` and `inference:providers:read` and refuses rather than
 * narrowing, and `/accounts/:id/billing/audit` demands `billing:read`. Retrying
 * a 403 cannot change it — it only delays the message by a second while the
 * screen says "loading", which reads as a system fault rather than as the
 * deliberate refusal it is.
 *
 * The SDK's own transport already declines to retry a 4xx (`retryAsync`'s
 * default `shouldRetry`); this is the same rule at the React Query layer, which
 * has its own.
 */
function retryUnlessRefused(failureCount: number, error: Error): boolean {
  return !isPermissionRefused(error) && failureCount < 1;
}

/** GET params for a page — `cursor` omitted entirely on the first one. */
function pageParams(cursor: string | null): Record<string, string | number> {
  return cursor === null
    ? { limit: AUDIT_PAGE_SIZE }
    : { limit: AUDIT_PAGE_SIZE, cursor };
}

/**
 * An account's audit trail: credential events and provider-connection events,
 * newest first, in one order.
 *
 * Requires BOTH `credentials:read` and `inference:providers:read`. The caller
 * passes `enabled: false` when the membership lacks either, so the refusal is
 * rendered as a refusal without a round trip — and the server still refuses if
 * the membership changed underneath, which the page also handles.
 */
export function useAccountAuditTrail(accountId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useInfiniteQuery({
    queryKey: queryKeys.trail(accountId ?? ''),
    queryFn: ({ pageParam }) =>
      oxyServices.makeRequest<AuditPageResponse<AccountAuditEntry>>(
        'GET',
        `/accounts/${accountId ?? ''}/audit`,
        pageParams(pageParam),
        { cache: false }
      ),
    initialPageParam: null as string | null,
    // The server's own cursor, handed back verbatim. Never rebuilt from the last
    // entry's `createdAt`, which is not a total order across the two sources.
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 30,
    retry: retryUnlessRefused,
  });
}

/**
 * An account's billing changes: top-ups, promotional grants, reversals of
 * settled charges and invoice payments, newest first.
 *
 * Requires `billing:read` — deliberately narrower than `account:read`, which is
 * baseline for every role and would hand a viewer the account's funding history.
 */
export function useAccountBillingAudit(accountId: string | undefined, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useInfiniteQuery({
    queryKey: queryKeys.billing(accountId ?? ''),
    queryFn: ({ pageParam }) =>
      oxyServices.makeRequest<AuditPageResponse<BillingAuditEntry>>(
        'GET',
        `/accounts/${accountId ?? ''}/billing/audit`,
        pageParams(pageParam),
        { cache: false }
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 30,
    retry: retryUnlessRefused,
  });
}
