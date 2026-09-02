/**
 * Environment Configuration Validation
 * 
 * Validates required environment variables on startup to fail fast
 * with clear error messages rather than failing at runtime.
 * 
 * Big tech practice: Validate configuration early and provide actionable errors.
 */

import { logger } from '../utils/logger';

/**
 * Required environment variables
 */
export interface RequiredEnvVars {
  // PostgreSQL connection string, consumed by `config/postgres.ts` (Drizzle
  // over postgres.js) and by the migrator (`db/migrate.ts`). The live store.
  //
  // Every name in the `required` list below must reach the ECS task, which
  // means being synced to SSM by `.github/workflows/deploy-aws.yml`. CI job
  // "Deploy Secrets Sync" reads THIS array and fails the build on any entry
  // that is neither synced nor recorded as a non-secret.
  DATABASE_URL: string;

  // Authentication
  ACCESS_TOKEN_SECRET: string;
  REFRESH_TOKEN_SECRET: string;

  // Access token v2 migration window (issue #937, Phase 6). A token is v2 iff
  // it carries `ver: 2`; anything else is v1. Set to the literal `closed` to
  // refuse every remaining v1 bearer — safe once one refresh-token lifetime
  // (7 days) has passed since deploy, because by then no v1 token can still be
  // live. Absent/anything else keeps the window open. Read per request in
  // `utils/sessionUtils.ts`; NOT a secret, so it is not synced to SSM.
  ACCESS_TOKEN_V1_WINDOW?: string;

  // Legacy cross-domain SSO secret (FedCM / POST /sso/code removed in wave 2).
  // Still synced from GitHub → SSM for environments that haven't dropped it yet;
  // no live route reads it. Safe to omit in new deployments.
  SSO_INTERNAL_SECRET?: string;

  // Device-id derivation salt (security review H1). Required in production
  // (no default). Optional in development (auto-filled with a documented
  // placeholder + WARNING). Must be ≥32 chars whenever it is set.
  DEVICE_ID_SALT: string;

  // AWS/S3 Configuration
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_S3_BUCKET: string;
  AWS_ENDPOINT_URL?: string; // Optional for S3-compatible services

  // Public media CDN. All public asset URLs handed to clients are built from
  // this origin (CloudFront `cloud.oxy.so` over the media bucket's `public/`
  // prefix) so no raw `*.amazonaws.com` S3 URL ever reaches a client. Optional:
  // falls back to the documented default in `config/cdn.ts` when unset.
  ASSET_CDN_URL?: string;

  // Oxy Updates code-signing private key (base64-encoded RSA PEM). OPTIONAL at
  // boot: the process starts without it, but any manifest request that asks for
  // a signature (`expo-expect-signature`) then fails with a 500 until it is set.
  // Production supplies it via SSM `/oxy/oxy-api/UPDATES_CODE_SIGNING_PRIVATE_KEY`.
  // Read directly by `services/updates/signing.service.ts`.
  UPDATES_CODE_SIGNING_PRIVATE_KEY?: string;

  // When `true`, `POST /federation/domain-purge` with `dryRun:false` may execute
  // deletions. Defaults to disabled; read per request in `routes/federation.ts`.
  FEDERATION_DOMAIN_PURGE_ENABLED?: string;

  // The inference platform's six rollout flags (issue #972 workstreams 16 and
  // 12). Declared, parsed and reported in ONE place — `config/rolloutFlags.ts` —
  // and readable at `GET /inference/admin/rollout`. None is a secret: each names
  // a deployment STATE, so all six belong in the ECS task definition's plain
  // environment and never in SSM, and all six are absent from the `required`
  // list below on purpose. Unset means the surface is closed, which is why an
  // absent variable can never open one.
  //
  //  - who may reach the public inference edge at all:
  //    `closed` | `internal` | `first_party` | `allowlist:<appId>,…` | `public`
  //    (unset = closed; `public` additionally requires BOTH charging to be armed
  //    and the privacy/security review to be recorded)
  INFERENCE_EDGE_AUDIENCE?: string;
  //  - whether an `oxy_sk_…` machine credential authenticates: `enabled` |
  //    `disabled` (unset = disabled)
  INFERENCE_MACHINE_CREDENTIAL_AUTH?: string;
  // Independent production kill switch for constructing the signed Kaana hop.
  // Unset and unreadable values are disabled.
  INFERENCE_KAANA_EXECUTION?: string;
  //  - whether this deployment may charge customers, as `<reason>:<YYYY-MM-DD>`.
  //    A bare `true` is REFUSED. Unset means SHADOW METERING: every request is
  //    priced and the amount recorded, and no reservation, receipt or balance
  //    movement is written.
  INFERENCE_CHARGING_AUTHORIZED?: string;
  //  - who is served the published model catalogue: `internal` | `public`
  //    (unset = internal)
  INFERENCE_CATALOGUE_AUDIENCE?: string;
  //  - the privacy and security review a PUBLIC launch is gated on (#972
  //    section 12), as `<reviewer>:<YYYY-MM-DD>`. A bare `true` is REFUSED.
  //    Unset means no review has been recorded, and a `public` audience stays
  //    CLOSED with `public_requires_privacy_review`. A self-attestation, not an
  //    authorization control — see the module header.
  INFERENCE_PRIVACY_REVIEW?: string;

  // Minimum remaining lifetime required of latency, throughput and balanced
  // routing evidence before approval or cutover. No default: the operator must
  // choose a horizon that covers rollout plus the evidence-refresh SLO.
  INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS?: string;

  // How far above its own trailing daily median an account's hourly inference
  // spend has to go before it is recorded as an anomaly (#972 sections 8 and 12).
  // A number above 1; unset means the documented default in
  // `services/spendAnomaly.service.ts`, and an unreadable value falls back to it
  // and is reported. NOT a rollout flag: it tunes a signal that blocks nothing,
  // and it is deliberately not in `config/rolloutFlags.ts`, which declares the
  // six switches that open or close a surface.
  INFERENCE_SPEND_ANOMALY_MULTIPLE?: string;

  // The inference DATA PLANE this deployment forwards to, and the key it signs
  // envelopes with (issue #972 workstream 4, ADR 0015). Resolved once, at router
  // construction, in `config/kaanaDataPlane.ts`.
  //
  // ALL THREE OR NONE. Unset, this deployment has no data plane: every invoke
  // answers a typed `service_unavailable` and `stream: true` is refused, which is
  // exactly the behaviour of every deployment before Kaana existed. A PARTIAL
  // configuration resolves to the same state and is reported at `error` level,
  // because forwarding unsigned envelopes would look like a data-plane outage.
  //
  //  - the data plane's base URL, canonically `https://kaana.ai`. Names a
  //    DEPLOYMENT, not a credential, so it belongs in the ECS task definition's
  //    plain environment and never in SSM.
  KAANA_BASE_URL?: string;
  //  - the id the data plane knows this signing key by (its `kid`). Not a secret
  //    either; it appears in every request header. No colon, comma or whitespace —
  //    the data plane parses its key set as `kid:base64,kid:base64`.
  KAANA_EDGE_SIGNING_KEY_ID?: string;
  //  - the Ed25519 PRIVATE key, as PEM or that PEM base64-encoded. THIS ONE IS A
  //    SECRET: it belongs in SSM at `/oxy/oxy-api/KAANA_EDGE_SIGNING_PRIVATE_KEY`,
  //    which means adding it to BOTH allowlists in `deploy-aws.yml` (the
  //    `SYNC_<NAME>` env block and `API_SECRETS`) when a data plane is first
  //    deployed — `scripts/check-deploy-secrets-sync.mjs` guards that the two
  //    agree. Absent from the `required` list below on purpose: unset means no
  //    data plane, not a broken boot. The data plane holds only the matching
  //    PUBLIC key and so cannot construct an envelope it would itself accept.
  KAANA_EDGE_SIGNING_PRIVATE_KEY?: string;

  // Separate Ed25519 authority for create/rotate/revoke of customer credentials.
  // This is service authentication, never provider key material. Both values
  // are optional and fail closed; the private key is supplied through SSM.
  KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID?: string;
  KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY?: string;

  // Ed25519 authority for short-lived capability tickets and catalog receipts.
  // The key id is public and appears in the JWKS; only the private key belongs in SSM.
  CAPABILITY_TICKET_SIGNING_KEY_ID?: string;
  CAPABILITY_TICKET_SIGNING_PRIVATE_KEY?: string;

  // Follow-graph outbox worker (`follow_events`). OFF by default — acknowledging
  // an event asserts its delivery happened; read by `followOutbox.worker.ts`.
  FOLLOW_OUTBOX_WORKER_ENABLED?: string;
  FOLLOW_OUTBOX_POLL_INTERVAL_MS?: string;
  FOLLOW_OUTBOX_BATCH_SIZE?: string;

  // Server
  PORT?: string;
  NODE_ENV?: string;
}

/**
 * Optional environment variables with defaults
 */
export const ENV_DEFAULTS = {
  // Local dev default only — ECS injects PORT explicitly (oxy-infra
  // terraform-uswest2/app-services.tf sets it to 8080). 4100 is oxy-api's slot
  // in the per-app port map so several Oxy backends can run side by side.
  PORT: '4100',
  NODE_ENV: 'development',
  AWS_REGION: 'us-east-1',
} as const;

/**
 * Configuration errors
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Strict hostname validation (RFC 1123 labels).
 *
 * Accepts only dot-separated alphanumeric labels with internal hyphens
 * (e.g. `oxy.so`, `api.oxy.so`). Rejects schemes, ports, paths, leading
 * dots, spaces, control characters, and cookie-attribute metacharacters
 * (`;`, `,`) — anything that could smuggle attributes into a hand-built
 * `Set-Cookie` header.
 */
const HOSTNAME_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOSTNAME_REGEX = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*$`);
const MAX_HOSTNAME_LENGTH = 253;

/**
 * Minimum acceptable length for `DEVICE_ID_SALT`. 32 chars ≈ 192 bits of
 * entropy when using a base64-ish alphabet, well above what's needed to
 * prevent salt-guessing brute-force against the truncated SHA-256 device id.
 */
const MIN_DEVICE_ID_SALT_LENGTH = 32;

/**
 * Accepted URI schemes for `DATABASE_URL`. Both are the same protocol —
 * `postgres://` is the historical spelling, `postgresql://` the one libpq
 * documents — and Bun's SQL client accepts either.
 */
const POSTGRES_URL_SCHEMES = ['postgres://', 'postgresql://'] as const;

/**
 * Development-only default for `DEVICE_ID_SALT`. NEVER use this in production —
 * production startup will fail-fast if `DEVICE_ID_SALT` is unset (see
 * `validateRequiredEnvVars`). The literal value is intentionally
 * recognisable so accidental prod usage is easy to grep for in logs.
 */
export const DEV_DEVICE_ID_SALT_DEFAULT = 'dev-only-device-id-salt-do-not-use-in-prod';

/**
 * Check whether a value is a strictly valid hostname suitable for
 * interpolation into a `Set-Cookie` `Domain=` attribute.
 */
export function isValidHostname(value: string): boolean {
  return value.length <= MAX_HOSTNAME_LENGTH && HOSTNAME_REGEX.test(value);
}

/**
 * Validate that required environment variables are set
 * 
 * @throws {ConfigurationError} If required variables are missing
 */
export function validateRequiredEnvVars(): void {
  const required: (keyof RequiredEnvVars)[] = [
    'DATABASE_URL',
    'ACCESS_TOKEN_SECRET',
    'REFRESH_TOKEN_SECRET',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_S3_BUCKET',
  ];

  const missing: string[] = [];
  const warnings: string[] = [];

  for (const key of required) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (process.env.DATABASE_URL && !POSTGRES_URL_SCHEMES.some(scheme => process.env.DATABASE_URL?.startsWith(scheme))) {
    warnings.push('DATABASE_URL should start with "postgres://" or "postgresql://"');
  }

  if (process.env.AWS_S3_BUCKET && process.env.AWS_S3_BUCKET.includes('/')) {
    warnings.push('AWS_S3_BUCKET should be just the bucket name, not a full path');
  }

  // ASSET_CDN_URL must be an absolute http(s) URL when set, since every public
  // asset URL is built by interpolating it. A malformed value would emit broken
  // media URLs to every client. Fail fast rather than silently shipping them.
  const assetCdnUrl = process.env.ASSET_CDN_URL;
  if (assetCdnUrl && assetCdnUrl.length > 0) {
    try {
      const parsed = new URL(assetCdnUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        missing.push('ASSET_CDN_URL (invalid: must be an absolute http(s) URL like "https://cloud.oxy.so")');
      }
    } catch {
      missing.push('ASSET_CDN_URL (invalid: must be an absolute http(s) URL like "https://cloud.oxy.so")');
    }
  }

  // Reject default/placeholder JWT secrets in production
  const WEAK_SECRETS = [
    'your-access-token-secret-here',
    'your-refresh-token-secret-here',
    'secret',
    'changeme',
    'password',
  ];
  if (isProduction()) {
    for (const key of ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET'] as const) {
      const val = process.env[key];
      if (val && (WEAK_SECRETS.includes(val) || val.length < 32)) {
        missing.push(`${key} (insecure: must be at least 32 characters and not a default placeholder)`);
      }
    }
  } else {
    // Warn in development too
    for (const key of ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET'] as const) {
      const val = process.env[key];
      if (val && WEAK_SECRETS.includes(val)) {
        warnings.push(`${key} is set to a default placeholder — generate a strong secret with: openssl rand -base64 64`);
      }
    }
  }

  // DEVICE_ID_SALT scopes the derived deviceId hash (see
  // `packages/api/src/utils/deviceUtils.ts`). Without it, two users behind
  // the same NAT/proxy on the same browser collide on the same deviceId and
  // can read each other's session listings (security review H1).
  //
  // - Production: required, no default, ≥32 chars. Fail fast on startup.
  // - Development: optional. If unset, we install a documented placeholder
  //   into `process.env.DEVICE_ID_SALT` and emit a WARNING so the deriver
  //   still functions deterministically across requests during local
  //   development. Operators MUST set a real value in prod.
  // - In every environment, if set it must be ≥32 chars.
  const deviceIdSalt = process.env.DEVICE_ID_SALT;
  if (!deviceIdSalt || deviceIdSalt.length === 0) {
    if (isProduction()) {
      missing.push(
        'DEVICE_ID_SALT (required: generate with `openssl rand -base64 48` — ' +
        'scopes the derived deviceId hash; without it, two users behind the ' +
        'same NAT on the same browser collide on the same deviceId)'
      );
    } else {
      // Dev-mode: install the placeholder so the derivation works in tests
      // and local runs, and warn loudly so it never silently reaches prod.
      process.env.DEVICE_ID_SALT = DEV_DEVICE_ID_SALT_DEFAULT;
      logger.warn(
        'DEVICE_ID_SALT is unset — using a development-only placeholder. ' +
        'Set DEVICE_ID_SALT to a strong random value (≥32 chars) before ' +
        'deploying. Generate one with: openssl rand -base64 48',
        { component: 'env', placeholder: DEV_DEVICE_ID_SALT_DEFAULT }
      );
    }
  } else if (deviceIdSalt.length < MIN_DEVICE_ID_SALT_LENGTH) {
    missing.push(
      `DEVICE_ID_SALT (insecure: must be at least ${MIN_DEVICE_ID_SALT_LENGTH} characters; got ${deviceIdSalt.length})`
    );
  }

  // Log warnings
  if (warnings.length > 0) {
    logger.warn('Environment configuration warnings:', { warnings });
  }

  // Throw error if any required variables are missing
  if (missing.length > 0) {
    const errorMessage = [
      'Missing required environment variables:',
      ...missing.map(key => `  - ${key}`),
      '',
      'Please set these variables in your .env file or environment.',
      'See .env.example for reference.',
    ].join('\n');

    throw new ConfigurationError(errorMessage);
  }
}

/**
 * Get environment variable with default fallback
 * 
 * @param key - Environment variable key
 * @param defaultValue - Default value if not set
 * @returns Environment variable value or default
 */
export function getEnvVar(key: string, defaultValue?: string): string {
  return process.env[key] || defaultValue || '';
}

/**
 * Get environment variable as number
 * 
 * @param key - Environment variable key
 * @param defaultValue - Default value if not set or invalid
 * @returns Parsed number or default
 */
export function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  
  const parsed = Number.parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get environment variable as boolean
 * 
 * @param key - Environment variable key
 * @param defaultValue - Default value if not set
 * @returns Boolean value
 */
export function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  
  return ['true', '1', 'yes'].includes(value.toLowerCase());
}

/**
 * Check if running in production
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Check if running in development
 */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * The WebAuthn Relying Party ID — the registrable domain a passkey is scoped to.
 * Defaults to the Oxy apex `oxy.so` in production (so a single passkey works
 * across every `*.oxy.so` first-party origin) and to `localhost` in development
 * (matching a loopback dev server). Overridable via `WEBAUTHN_RP_ID`, mirroring
 * the other domain-override envs (`FEDERATION_DOMAIN`, `DID_WEB_DOMAIN`) that are
 * read inline at their call sites. The RP ID is a bare hostname — never a scheme,
 * port, or path — so `verifyRegistrationResponse`/`verifyAuthenticationResponse`
 * can match it against the ceremony's `rpIdHash`.
 */
export function getWebauthnRpId(): string {
  const configured = process.env.WEBAUTHN_RP_ID?.trim();
  if (configured) {
    return configured;
  }
  return isDevelopment() ? 'localhost' : 'oxy.so';
}

/**
 * Get sanitized configuration for logging (without sensitive data)
 */
export function getSanitizedConfig(): Record<string, string> {
  return {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || ENV_DEFAULTS.PORT,
    AWS_REGION: process.env.AWS_REGION || ENV_DEFAULTS.AWS_REGION,
    AWS_S3_BUCKET: process.env.AWS_S3_BUCKET || '',
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL || 'default',
    ASSET_CDN_URL: process.env.ASSET_CDN_URL || 'https://cloud.oxy.so',
    DATABASE_URL: process.env.DATABASE_URL ? maskConnectionString(process.env.DATABASE_URL) : '',
  };
}

/**
 * Mask sensitive parts of connection strings for logging
 * 
 * @param connectionString - Connection string to mask
 * @returns Masked connection string
 */
function maskConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = '***';
    }
    if (url.username) {
      // Keep first and last character of username
      const username = url.username;
      if (username.length > 2) {
        url.username = username[0] + '***' + username[username.length - 1];
      }
    }
    return url.toString();
  } catch {
    // If URL parsing fails, just mask the entire string after the protocol
    return connectionString.replace(/:\/\/.*@/, '://***:***@');
  }
}
