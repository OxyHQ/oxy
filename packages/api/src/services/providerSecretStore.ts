/**
 * The seam between Oxy and managed secret storage (issue #972 workstream 10).
 *
 * ## THE STATE OF THIS, PLAINLY
 *
 * **No secret backend is wired in this deployment, and this module does not
 * pretend otherwise.** {@link PROVIDER_SECRET_STORE_BACKENDS} is empty, so
 * {@link resolveProviderSecretStore} never returns `available` and every path
 * that would accept a customer credential REFUSES with
 * {@link ProviderSecretStoreUnavailableError}. That refusal is the feature. A
 * BYOK implementation that fell back to Postgres, or to a column somebody
 * promised to encrypt later, would be far worse than one that says it cannot
 * hold a secret yet.
 *
 * ## What the deployment actually has, and why it is not this
 *
 * `oxy-api` runs on ECS Fargate and receives its OWN secrets from SSM Parameter
 * Store (`/oxy/oxy-api/*`, `/oxy/_shared/*`), injected by the task definition at
 * LAUNCH. That is a launch-time read of parameters an operator created; it is
 * not a runtime write path, and the task role is not granted `ssm:PutParameter`.
 * The package's AWS dependencies are the three S3 clients and nothing else —
 * there is no Secrets Manager, SSM, KMS or Vault client in the tree, so this
 * process could not write a customer secret anywhere even if it were asked to.
 *
 * ## What would wire it
 *
 * One entry in {@link PROVIDER_SECRET_STORE_BACKENDS}, and the three things that
 * entry needs to be honest:
 *
 *  1. A client (`@aws-sdk/client-secrets-manager`, or a Vault client) added to
 *     `packages/api/package.json`, and to the Dockerfile's lean workspace
 *     install.
 *  2. An IAM policy on the ECS task role scoped to the partition prefix
 *     {@link providerSecretReference} builds — `oxy/inference/byok/<environment>/<accountId>/<connectionId>`
 *     — so the process can write ONLY inside a customer's own partition. The
 *     partition is in the path precisely so that policy is expressible.
 *  3. `INFERENCE_PROVIDER_SECRET_STORE` set to that backend's name in the task
 *     definition. It names a STORE, not a credential, so it is a plain ECS
 *     environment variable and not an SSM parameter.
 *
 * Nothing else in this workstream changes: the metadata side, the routes, the
 * audit trail and the scope enforcement are complete and tested without it.
 *
 * ## The secret never becomes a plain string anywhere it could be logged
 *
 * A credential that transits this process at all does so inside
 * {@link ProviderSecretValue}, whose `toString`, `toJSON` and
 * `util.inspect.custom` all return a redaction marker. So a template literal, a
 * `JSON.stringify`, a pino field and a REPL dump all print `[redacted]`;
 * {@link ProviderSecretValue.reveal} is the single, greppable way to get the
 * bytes, and it is called in exactly two places (the fingerprint, and the store
 * write). This is a structural guard, not a convention: there is no accidental
 * path to the plaintext.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { PROVIDER_SECRET_STORE_NAMES } from '../db/schema/inferenceProviderConnections';
import type { ProviderSecretStoreName } from '../db/schema/inferenceProviderConnections';

export { PROVIDER_SECRET_STORE_NAMES };
export type { ProviderSecretStoreName };

/**
 * Credential material, in the only shape this codebase passes it around in.
 *
 * Not an interface or a branded string — a class, because the protection is the
 * three overridden serialisers, and a type alias cannot carry those.
 */
export class ProviderSecretValue {
  /** Truly private: `#` is enforced at runtime, not merely by `tsc`. */
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) {
      throw new Error('a provider secret cannot be empty');
    }
    this.#value = value;
  }

  /**
   * The plaintext. The ONE accessor, named so a review can grep every call site
   * in one search. Two exist: {@link fingerprintProviderSecret} and a store
   * backend's own write.
   */
  reveal(): string {
    return this.#value;
  }

  /** The leading characters, for recognition. Capped at the contract's 12. */
  prefix(): string {
    return this.#value.slice(0, PROVIDER_SECRET_PREFIX_LENGTH);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** `util.inspect`, which `console.log` and several loggers reach for. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

/** What every serialiser of a {@link ProviderSecretValue} prints instead. */
export const REDACTED = '[redacted provider secret]';

/**
 * The contract caps `keyPrefix` at 12 characters. Restated here because this is
 * the code that produces the value, and a producer that could emit 13 would make
 * the cap a validation error rather than a design.
 */
export const PROVIDER_SECRET_PREFIX_LENGTH = 12;

/** SHA-256, lowercase hex — the `fingerprint` column's format, exactly. */
export function fingerprintProviderSecret(secret: ProviderSecretValue): string {
  return createHash('sha256').update(secret.reveal(), 'utf8').digest('hex');
}

/**
 * Whether two fingerprints are the same, in constant time.
 *
 * Used by rotation to refuse replacing a credential with itself. Constant-time
 * because the alternative teaches nothing to anyone but is free to get right,
 * and `verifySecret`'s reasoning applies to any digest comparison.
 */
export function fingerprintsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Which account/environment partition a connection's secret lives in. */
export interface ProviderSecretPartition {
  readonly environment: string;
  readonly ownerAccountId: string;
  readonly connectionId: string;
}

/**
 * The locator for one connection's secret.
 *
 * The account and environment are IN THE PATH, in that order, and the
 * `inference_provider_connections_secret_ref_partition` CHECK requires the
 * stored value to end with exactly this suffix. Two things follow: a row can
 * never name another account's or another environment's secret, and a store-side
 * policy can be written per partition without Oxy having to be trusted to filter.
 */
export function providerSecretReference(
  storeName: ProviderSecretStoreName,
  partition: ProviderSecretPartition
): string {
  return `${storeName}:oxy/inference/byok/${partition.environment}/${partition.ownerAccountId}/${partition.connectionId}`;
}

/**
 * A managed secret store, as this codebase needs it.
 *
 * Deliberately WRITE-ONLY plus destroy. There is no `get`, and that absence is a
 * decision: reading a customer credential back into this process is the one
 * operation BYOK exists to avoid, and an interface that offered it would make
 * "just re-validate it here" a one-line change. Whoever holds the secret at use
 * time — the data plane — is who validates it; Oxy records the verdict.
 */
export interface ProviderSecretStore {
  readonly name: ProviderSecretStoreName;
  /** Write `secret` at `reference`, replacing whatever is there. */
  put(reference: string, secret: ProviderSecretValue): Promise<void>;
  /** Destroy the credential `reference` names. Idempotent. */
  destroy(reference: string): Promise<void>;
}

/**
 * The backends compiled into this build.
 *
 * EMPTY, and that is the honest state of this deployment — see the module
 * header. It is a `Map` rather than an `if` so adding a backend is one entry
 * and touches nothing else, and so the emptiness is a fact a test can assert
 * rather than a branch a reader has to infer.
 */
const PROVIDER_SECRET_STORE_BACKENDS: ReadonlyMap<ProviderSecretStoreName, ProviderSecretStore> =
  new Map();

/**
 * Why no store is available, when none is.
 *
 * Four arms rather than a boolean, because an operator's next action differs in
 * each: set the variable, correct a typo, ship a build with the client in it, or
 * nothing at all.
 */
export type ProviderSecretStoreResolution =
  | { readonly status: 'available'; readonly store: ProviderSecretStore }
  | { readonly status: 'not-configured' }
  | { readonly status: 'unknown-store'; readonly configured: string }
  | { readonly status: 'backend-missing'; readonly storeName: ProviderSecretStoreName };

/** True when `value` names one of the stores a reference may point into. */
export function isProviderSecretStoreName(value: string): value is ProviderSecretStoreName {
  return (PROVIDER_SECRET_STORE_NAMES as readonly string[]).includes(value);
}

/**
 * Which secret store this deployment writes customer credentials to.
 *
 * Read per call rather than cached at module load, so a test can set the
 * variable and so a task definition change takes effect on restart without a
 * second mechanism deciding it did not.
 */
export function resolveProviderSecretStore(): ProviderSecretStoreResolution {
  const configured = process.env.INFERENCE_PROVIDER_SECRET_STORE;
  if (configured === undefined || configured.length === 0) {
    return { status: 'not-configured' };
  }
  if (!isProviderSecretStoreName(configured)) {
    return { status: 'unknown-store', configured };
  }
  const store = PROVIDER_SECRET_STORE_BACKENDS.get(configured);
  if (store === undefined) {
    return { status: 'backend-missing', storeName: configured };
  }
  return { status: 'available', store };
}

/**
 * Raised by any path that would have to hold a customer credential, when there
 * is nowhere safe to put it.
 *
 * Carries a machine-readable `code` so the route answers with the same typed
 * shape the inference edge uses for a missing data plane, rather than a prose
 * 500 a client has to string-match.
 */
export class ProviderSecretStoreUnavailableError extends Error {
  readonly code = 'provider_secret_store_unavailable' as const;
  readonly resolution: Exclude<ProviderSecretStoreResolution, { status: 'available' }>;

  constructor(resolution: Exclude<ProviderSecretStoreResolution, { status: 'available' }>) {
    super(describeUnavailableStore(resolution));
    this.name = 'ProviderSecretStoreUnavailableError';
    this.resolution = resolution;
  }
}

/** The operator-facing sentence for each refusal. Never names a secret. */
export function describeUnavailableStore(
  resolution: Exclude<ProviderSecretStoreResolution, { status: 'available' }>
): string {
  switch (resolution.status) {
    case 'not-configured':
      // Deliberately does NOT say "set INFERENCE_PROVIDER_SECRET_STORE and this
      // will work": no backend ships in this build, so setting it moves the
      // refusal to `backend-missing` rather than removing it. A message that
      // implied otherwise would send an operator to change a task definition
      // for nothing.
      return (
        'This deployment has no managed secret store configured, so it cannot accept a ' +
        'provider credential. Oxy stores only a reference to a secret and never the secret ' +
        'itself. Wiring one means both a store client in the build and ' +
        'INFERENCE_PROVIDER_SECRET_STORE naming it.'
      );
    case 'unknown-store':
      return (
        `INFERENCE_PROVIDER_SECRET_STORE names "${resolution.configured}", which is not one of ` +
        `${PROVIDER_SECRET_STORE_NAMES.join(', ')}.`
      );
    case 'backend-missing':
      return (
        `INFERENCE_PROVIDER_SECRET_STORE names "${resolution.storeName}", but this build ships ` +
        'no client for it, so no provider credential can be written.'
      );
  }
}

/**
 * The store, or the typed refusal. Every caller that would accept a credential
 * goes through this — the resolution's non-`available` arms are never handled
 * individually, because the answer to all three is the same: refuse before
 * reading the credential out of the request.
 */
export function requireProviderSecretStore(): ProviderSecretStore {
  const resolution = resolveProviderSecretStore();
  if (resolution.status !== 'available') {
    throw new ProviderSecretStoreUnavailableError(resolution);
  }
  return resolution.store;
}
