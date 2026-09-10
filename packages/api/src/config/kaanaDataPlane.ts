/**
 * How this deployment reaches the inference data plane, and what it signs with
 * (issue #972 workstream 4, ADR 0006, ADR 0015).
 *
 * Three variables, all three or none:
 *
 * ```text
 * KAANA_BASE_URL                    https://kaana.ai — no path, no trailing slash needed
 * KAANA_EDGE_SIGNING_KEY_ID         the id Kaana knows this key by (its `kid`)
 * KAANA_EDGE_SIGNING_PRIVATE_KEY    an Ed25519 private key, PEM or base64-of-PEM
 * ```
 *
 * ## Absent is the default, and absent means exactly what it meant before
 *
 * A deployment that sets none of them has no data plane: `createHttpKaanaClient`
 * returns `undefined`, the edge reaches {@link DataPlaneNotConfiguredError} and
 * answers a typed `service_unavailable`, and `stream: true` is refused. This is
 * the fail-closed state for a task without complete bindings: deploying an image
 * alone cannot activate Kaana traffic.
 *
 * ## A PARTIAL configuration is refused, never half-used
 *
 * A base URL with no signing key would produce unsigned envelopes that Kaana
 * refuses one by one — a working-looking deployment answering `internal_error`
 * on every request. So a subset resolves `unreadable`, is reported once at
 * `error` level, and leaves the deployment with no data plane. The safe state and
 * the "somebody mistyped it" state are distinguishable in the log, which is the
 * same rule `config/rolloutFlags.ts` follows and for the same reason: a typo in
 * an inference variable must not take down authentication, email or storage.
 *
 * ## Read at construction, not per request
 *
 * Unlike the rollout flags, this resolves ONCE — `createHttpKaanaClient()` is
 * called where the router is built. A private key parsed per request would be
 * thousands of needless key parses, and re-reading the variable mid-process
 * cannot help: Kaana has to be told the matching PUBLIC key out of band, so a
 * key this process picked up without a restart is a key Kaana has never heard of.
 *
 * ## The private key is the only secret here
 *
 * `KAANA_EDGE_SIGNING_PRIVATE_KEY` is a signing key and belongs in SSM
 * (`/oxy/oxy-api/KAANA_EDGE_SIGNING_PRIVATE_KEY`), which means adding it to BOTH
 * hand-maintained allowlists in `.github/workflows/deploy-aws.yml` — the
 * `SYNC_<NAME>` env block and the `API_SECRETS` list — at the moment a Kaana
 * deployment first needs it. `scripts/check-deploy-secrets-sync.mjs` guards that
 * pair. The base URL and the key id are not secrets and belong in the ECS task
 * definition's plain environment.
 *
 * The key material never leaves this module: {@link KaanaDataPlaneConfig} carries
 * a `KeyObject`, whose `toString()` is `[object Object]` rather than a PEM, and
 * nothing here logs it. What IS logged once at startup is the derived PUBLIC key,
 * because that is what an operator has to paste into Kaana's own
 * `KAANA_EDGE_PUBLIC_KEYS` and a public key is not a secret.
 */

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { logger } from '../utils/logger';

export const KAANA_BASE_URL_VARIABLE = 'KAANA_BASE_URL';
export const KAANA_SIGNING_KEY_ID_VARIABLE = 'KAANA_EDGE_SIGNING_KEY_ID';
export const KAANA_SIGNING_PRIVATE_KEY_VARIABLE = 'KAANA_EDGE_SIGNING_PRIVATE_KEY';

/** What a configured deployment forwards with. */
export interface KaanaDataPlaneConfig {
  /** Kaana's one canonical HTTPS origin. */
  readonly baseUrl: string;
  /** The `kid` Kaana indexes this key by; also the second line of every signature. */
  readonly keyId: string;
  /** Ed25519. Never serialized, never logged. */
  readonly privateKey: KeyObject;
}

export type KaanaDataPlaneResolution =
  | { readonly status: 'configured'; readonly config: KaanaDataPlaneConfig }
  /** Not one of the three variables is set: this deployment has no data plane. */
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly variable: string; readonly expected: string };

/**
 * Kaana parses its key set from a `kid:base64,kid:base64` string, so a key id
 * containing either separator is one Kaana could never be configured with — and
 * a line break would let a key id forge a line of the signing input, which is
 * how a signature over one envelope is made to verify another.
 */
const FORBIDDEN_KEY_ID_CHARACTERS = /[:,\r\n\s]/;

const MAX_KEY_ID_LENGTH = 128;

/** Resolve this deployment's data plane from the environment. */
export function resolveKaanaDataPlane(): KaanaDataPlaneResolution {
  const baseUrl = process.env[KAANA_BASE_URL_VARIABLE]?.trim() ?? '';
  const keyId = process.env[KAANA_SIGNING_KEY_ID_VARIABLE]?.trim() ?? '';
  const rawPrivateKey = process.env[KAANA_SIGNING_PRIVATE_KEY_VARIABLE]?.trim() ?? '';

  if (baseUrl.length === 0 && keyId.length === 0 && rawPrivateKey.length === 0) {
    return { status: 'absent' };
  }

  if (baseUrl.length === 0) {
    return unreadable(KAANA_BASE_URL_VARIABLE, 'Kaana’s canonical origin: https://kaana.ai');
  }
  const origin = parseBaseUrl(baseUrl);
  if (origin === undefined) {
    return unreadable(KAANA_BASE_URL_VARIABLE, 'Kaana’s canonical origin: https://kaana.ai');
  }

  if (keyId.length === 0 || keyId.length > MAX_KEY_ID_LENGTH) {
    return unreadable(
      KAANA_SIGNING_KEY_ID_VARIABLE,
      `1 to ${MAX_KEY_ID_LENGTH} characters naming the key Kaana trusts, e.g. oxy-edge-2026-08`
    );
  }
  if (FORBIDDEN_KEY_ID_CHARACTERS.test(keyId)) {
    return unreadable(
      KAANA_SIGNING_KEY_ID_VARIABLE,
      'a key id with no colon, comma, whitespace or line break — Kaana parses its key set as kid:base64,kid:base64'
    );
  }

  if (rawPrivateKey.length === 0) {
    return unreadable(
      KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
      'an Ed25519 private key as PEM, or that PEM base64-encoded'
    );
  }
  const privateKey = parseEd25519PrivateKey(rawPrivateKey);
  if (privateKey === undefined) {
    return unreadable(
      KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
      'an Ed25519 private key as PEM, or that PEM base64-encoded — generate one with `openssl genpkey -algorithm ed25519`'
    );
  }

  return { status: 'configured', config: { baseUrl: origin, keyId, privateKey } };
}

/**
 * The base64 raw public key matching a configured private key — the second half
 * of the `kid:base64` entry Kaana's own `KAANA_EDGE_PUBLIC_KEYS` takes.
 *
 * Exported because it is the only way an operator can confirm the two sides hold
 * the same pair without being shown key material: a public key is not a secret,
 * and Kaana's `edgeauth` package says so in as many words.
 */
export function kaanaPublicKeyBase64(config: KaanaDataPlaneConfig): string {
  // SPKI DER for Ed25519 is a fixed 12-byte header followed by the 32 raw bytes,
  // and Kaana's ParsePublicKeys expects exactly those 32. Node has no "raw"
  // export for an Ed25519 public key, but the JWK form's `x` IS the raw key in
  // base64url, so the conversion is a re-encode rather than a byte offset nobody
  // would notice drifting.
  const jwk = createPublicKey(config.privateKey).export({ format: 'jwk' });
  const x = jwk.x;
  if (typeof x !== 'string') {
    throw new Error('An Ed25519 public key exported no `x` coordinate.');
  }
  return Buffer.from(x, 'base64url').toString('base64');
}

/**
 * Report an unreadable value once, and resolve to the state that serves nobody.
 *
 * The VALUE is never logged — one of the three is a private key, and an operator
 * who pasted the wrong thing into the wrong variable would otherwise have it
 * copied into CloudWatch.
 */
function unreadable(variable: string, expected: string): KaanaDataPlaneResolution {
  logger.error(
    'inference.kaana.config_unreadable',
    new Error(`${variable} is set to a value this build cannot use; this deployment has no data plane`),
    { component: 'inference-kaana', variable, expected }
  );
  return { status: 'unreadable', variable, expected };
}

/**
 * Kaana's exact canonical origin.
 *
 * Do not normalize a broader URL into it: `https://kaana.ai@evil.example`
 * parses successfully and its origin is the attacker-controlled host. The
 * edge sends signed envelopes and request bodies here, so accepting aliases,
 * ports, credentials or paths would turn a configuration typo into exfiltration.
 */
function parseBaseUrl(value: string): string | undefined {
  if (value !== 'https://kaana.ai') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname !== 'kaana.ai' ||
    url.port.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return undefined;
  }
  return 'https://kaana.ai';
}

/**
 * Read an Ed25519 private key from a PEM, or from that PEM base64-encoded.
 *
 * Both forms, following `services/updates/signing.service.ts`: production hands
 * secrets through SSM where a base64 blob survives every layer unchanged, while a
 * developer pastes what `openssl genpkey` printed. Anything that is neither, or
 * that decodes to a key of another algorithm, returns `undefined` — an RSA key
 * here would sign happily and be rejected by Kaana on every request.
 */
function parseEd25519PrivateKey(raw: string): KeyObject | undefined {
  const pem = raw.includes('-----BEGIN') ? raw : decodeBase64Pem(raw);
  if (pem === undefined) return undefined;

  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    return undefined;
  }
  return key.asymmetricKeyType === 'ed25519' ? key : undefined;
}

function decodeBase64Pem(raw: string): string | undefined {
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  return decoded.includes('-----BEGIN') ? decoded : undefined;
}
