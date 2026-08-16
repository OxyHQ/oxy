import type {
  ProviderConnection,
  ProviderConnectionScope,
  ProviderConnectionStatus,
} from '@oxyhq/contracts';

/**
 * The Console's view of a BYOK provider connection — the contract's shape with
 * `secretRef` REMOVED.
 *
 * `providerConnectionSchema` carries a `secretRef`: a `<store>:<locator>`
 * pointer into Vault/KMS. It is not the credential, but it IS the address of the
 * credential, and a customer screen has no use for it — so it never enters a
 * React tree, a DOM node, a clipboard or a screenshot.
 *
 * Two mechanisms keep that true rather than remembered:
 *
 *  - {@link toProviderConnectionView} builds the view field-by-field against
 *    this type. Adding a field to the contract without listing it here is a
 *    `tsc` error at the projection, not a field that silently appears on screen.
 *  - `__tests__/provider-connection.test.ts` asserts the projected object has no
 *    `secretRef` own property, so re-introducing it by spread fails the suite.
 *
 * `keyPrefix` and `fingerprint` are the two fields designed to be shown: the
 * contract caps the prefix at 12 characters (shorter than any usable credential)
 * and the fingerprint is a SHA-256 of the credential, which is what makes a
 * rotation verifiable without ever handling the key.
 */
export type ProviderConnectionView = Omit<ProviderConnection, 'secretRef'>;

/** Project a connection into the shape Console is allowed to render. */
export function toProviderConnectionView(connection: ProviderConnection): ProviderConnectionView {
  return {
    schemaVersion: connection.schemaVersion,
    connectionId: connection.connectionId,
    provider: connection.provider,
    ownerAccountId: connection.ownerAccountId,
    scope: connection.scope,
    environment: connection.environment,
    status: connection.status,
    keyPrefix: connection.keyPrefix,
    fingerprint: connection.fingerprint,
    validation: connection.validation,
    upstreamBillsCustomerDirectly: connection.upstreamBillsCustomerDirectly,
    termsAcknowledgedAt: connection.termsAcknowledgedAt,
    createdAt: connection.createdAt,
    rotatedAt: connection.rotatedAt,
  };
}

/**
 * The machine-readable code the API answers with when this deployment has
 * nowhere safe to put a customer credential.
 *
 * Raised by `POST …/accounts/:id`, `POST …/applications/:id` and
 * `POST …/:connectionId/rotate` BEFORE the request body is read, so an
 * unconfigured deployment never holds a customer secret at all.
 */
export const PROVIDER_SECRET_STORE_UNAVAILABLE = 'provider_secret_store_unavailable';

/**
 * True when the API refused because no managed secret store is wired.
 *
 * Branches on the `code` the API sends (`{ error: '<code>', message, details }`,
 * lifted onto the thrown `Error` by the SDK's `parseHttpErrorBody`), never on
 * the prose, which is operator-facing and free to change.
 */
export function isSecretStoreUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: string }).code;
  return code === PROVIDER_SECRET_STORE_UNAVAILABLE;
}

/**
 * How widely a connection applies, in the words the customer chose.
 *
 * `account` and `project` differ by INHERITANCE, not by id space: an account
 * connection is inherited by every descendant project and application, a project
 * one applies to that account alone.
 */
export function providerConnectionScopeLabel(scope: ProviderConnectionScope): string {
  switch (scope.kind) {
    case 'account':
      return 'Account (inherited by projects and applications)';
    case 'project':
      return 'Project only';
    case 'application':
      return 'This application only';
  }
}

/** Does this connection apply to `applicationId`, either directly or by inheritance? */
export function connectionAppliesToApplication(
  connection: ProviderConnectionView,
  applicationId: string,
  ownerAccountId: string
): boolean {
  if (connection.scope.kind === 'application') {
    return connection.scope.applicationId === applicationId;
  }
  // A project-scoped connection applies to the account it names and nothing
  // below it; an account-scoped one is inherited downward. Both are visible to
  // an application whose owning account holds them — an ANCESTOR account's
  // connection is not in this list at all, because the list is scoped to one
  // account.
  return connection.scope.accountId === ownerAccountId;
}

/** Badge tone for a connection's lifecycle state. */
export function connectionStatusVariant(
  status: ProviderConnectionStatus
): 'default' | 'secondary' | 'destructive' {
  if (status === 'active') {
    return 'default';
  }
  if (status === 'revoked') {
    return 'destructive';
  }
  return 'secondary';
}

/**
 * A fingerprint, shortened for a table cell.
 *
 * Strictly less information than the contract already permits — the point is
 * legibility, not secrecy, and a truncation can never reveal more than the whole.
 */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}
