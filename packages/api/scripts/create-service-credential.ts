#!/usr/bin/env bun
/**
 * Provision a `service`-type ApplicationCredential under an EXISTING active
 * Application, using the EXACT same creation logic as the real
 * credential-create route (`routes/applications.ts` → `generateCredentialMaterial`):
 *   publicKey  = 'oxy_dk_' + 24 random bytes hex   (the apiKey; SAFE to log)
 *   secret     = 32 random bytes hex               (NEVER logged in plaintext)
 *   secretHash = sha256(secret) hex                (the only thing persisted)
 *
 * The plaintext secret only ever lives in a local variable and is fed straight
 * into an AES-256-GCM cipher; ONLY the encrypted form is emitted (so it can be
 * exfiltrated safely via task logs and decrypted out-of-band with the key).
 *
 * Idempotency: a usable (`isCredentialUsable`) service credential is reused only
 * when its scope set EXACTLY matches the requested set. A usable credential with
 * broader, narrower or ambiguous authority makes the run fail closed; operators
 * must rotate/revoke it explicitly. The existing secret is NOT recoverable (only
 * its hash is stored), so `secretEnc` is `null` on reuse.
 *
 * ## One environment per invocation, on purpose
 *
 * `application_credentials.environment` is a real isolation boundary — a service
 * token carries it as a verified claim (`middleware/serviceToken.ts`) — so
 * development, staging and production credentials of one application are three
 * separate rows. This script mints ONE of them per run, named by `ENVIRONMENT`,
 * rather than all three: each run emits exactly one secret, and a secret that
 * has to reach one deployment environment should not be sitting in the same
 * output as the two that must not.
 *
 * Safety:
 *   - Never creates an Application — it must already exist and be `active`.
 *   - No deletes, no drops, no modification of unrelated rows.
 *   - DRY_RUN=true reports the plan without writing and without emitting a secret.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/scripts/create-service-credential.ts
 *
 * Env:
 *   DATABASE_URL           required (injected by ECS from SSM)
 *   APP_ID                 required exact application id for machine principals
 *   SCOPES                 required, comma-separated, e.g. "federation:write,user:read"
 *   ENVIRONMENT            development | staging | production (default 'production')
 *   CREDENTIAL_NAME        credential name (default 'Service (<environment>)')
 *   OUTPUT_ENCRYPTION_KEY  required, 64 hex chars (32 bytes) — AES-256-GCM key
 *   DRY_RUN=true           plan only, no writes, no secret emitted
 */

import crypto from "crypto";
import { and, eq, ne } from "drizzle-orm";
import { closePostgres, connectPostgres, getDb } from "../src/config/postgres";
import {
  APPLICATION_CREDENTIAL_ENVIRONMENTS,
  applicationCredentials,
  type ApplicationCredentialEnvironment,
} from "../src/db/schema/applicationCredentials";
import { applications } from "../src/db/schema/applications";
import { users } from "../src/db/schema/users";
import { APPLICATION_SCOPES } from "../src/utils/applicationScopes";
import { isCredentialUsable } from "../src/utils/credentialUsability";
import { logger } from "../src/utils/logger";

// ── Mirror routes/applications.ts credential generation EXACTLY ──────────────
const CREDENTIAL_PUBLIC_KEY_PREFIX = "oxy_dk_";
const PUBLIC_KEY_RANDOM_BYTES = 24;
const SECRET_RANDOM_BYTES = 32;

/** Generate a fresh credential public key + plaintext secret + its hash. */
function generateCredentialMaterial(): {
  publicKey: string;
  secret: string;
  secretHash: string;
} {
  const publicKey =
    CREDENTIAL_PUBLIC_KEY_PREFIX +
    crypto.randomBytes(PUBLIC_KEY_RANDOM_BYTES).toString("hex");
  const secret = crypto.randomBytes(SECRET_RANDOM_BYTES).toString("hex");
  const secretHash = crypto.createHash("sha256").update(secret).digest("hex");
  return { publicKey, secret, secretHash };
}

const ENCRYPTION_KEY_HEX_LENGTH = 64; // 32 bytes
const GCM_IV_BYTES = 12;

interface SecretEnvelope {
  ivB64: string;
  ciphertextB64: string;
  tagB64: string;
}

/**
 * AES-256-GCM encrypt the plaintext secret for safe exfiltration via logs. The
 * key (`OUTPUT_ENCRYPTION_KEY`) is held only by the operator; the emitted
 * envelope is useless without it.
 */
function encryptSecret(secret: string, keyHex: string): SecretEnvelope {
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ivB64: iv.toString("base64"),
    ciphertextB64: ciphertext.toString("base64"),
    tagB64: tag.toString("base64"),
  };
}

/** Parse + validate the comma-separated SCOPES env against the allowlist. */
function parseAndValidateScopes(raw: string | undefined): string[] {
  const scopes = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (scopes.length === 0) {
    throw new Error(
      'SCOPES is required — provide a comma-separated list, e.g. "federation:write,user:read".',
    );
  }

  const allowed = new Set<string>(APPLICATION_SCOPES);
  const invalid = scopes.filter((s) => !allowed.has(s));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid scope(s): ${invalid.join(", ")}. ` +
        `Allowed scopes: ${APPLICATION_SCOPES.join(", ")}.`,
    );
  }

  // De-duplicate while preserving order.
  return Array.from(new Set(scopes));
}

function hasExactScopeSet(
  actual: readonly string[],
  requested: readonly string[],
): boolean {
  if (actual.length !== requested.length) return false;
  const requestedScopes = new Set(requested);
  return actual.every((scope) => requestedScopes.has(scope));
}

/**
 * Narrow `ENVIRONMENT` against the column's own closed set.
 *
 * Refuses an unrecognised value rather than defaulting to production. The
 * dangerous typo is the one that reads like a smaller blast radius — `dev`,
 * `prod`, `staging-2` — and silently mints the credential a real deployment then
 * authenticates with.
 */
function parseAndValidateEnvironment(
  raw: string | undefined,
): ApplicationCredentialEnvironment {
  if (raw === undefined || raw.trim().length === 0) {
    return "production";
  }
  const value = raw.trim();
  const allowed: readonly string[] = APPLICATION_CREDENTIAL_ENVIRONMENTS;
  if (!allowed.includes(value)) {
    throw new Error(
      `Invalid ENVIRONMENT "${value}". Allowed: ${APPLICATION_CREDENTIAL_ENVIRONMENTS.join(", ")}.`,
    );
  }
  return value as ApplicationCredentialEnvironment;
}

interface ResultRow {
  app: string;
  applicationId: string;
  ownerUsername: string | null;
  ownerId: string;
  credentialId: string | null;
  publicKey: string | null;
  type: "service";
  environment: ApplicationCredentialEnvironment;
  scopes: string[];
  reused: boolean;
  secretEnc: SecretEnvelope | null;
}

function writeResult(row: ResultRow): void {
  process.stdout.write(`SERVICE_CRED_JSON=${JSON.stringify(row)}\n`);
}

async function run(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";
  // Application ids are opaque identities. A whitespace-modified value is a
  // different (unknown) id; never repair it into somebody else's authority.
  const requestedAppId = process.env.APP_ID;
  const environment = parseAndValidateEnvironment(process.env.ENVIRONMENT);
  // Defaulted from the environment so three credentials of one application are
  // distinguishable in Console, where the only other thing telling them apart is
  // a column an operator has to go looking for.
  const credentialName =
    process.env.CREDENTIAL_NAME || `Service (${environment})`;
  const encryptionKeyHex = process.env.OUTPUT_ENCRYPTION_KEY;

  if (dryRun) {
    logger.info(
      "DRY RUN — no writes will be performed, no secret will be emitted",
    );
  }

  if (requestedAppId === undefined || requestedAppId.length === 0) {
    throw new Error("APP_ID is required.");
  }

  // Validate the encryption key up-front (only required when we may emit a secret).
  if (!dryRun) {
    if (!encryptionKeyHex || !/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
      throw new Error(
        "OUTPUT_ENCRYPTION_KEY is required and must be exactly " +
          `${ENCRYPTION_KEY_HEX_LENGTH} hex characters (32 bytes for AES-256-GCM).`,
      );
    }
  }

  const scopes = parseAndValidateScopes(process.env.SCOPES);
  logger.info("Validated requested scopes", { scopes, environment });

  await getDb().transaction(async (db) => {
    // ── 1. Resolve the EXISTING Application by its exact immutable id. ──
    const [application] = await db
      .select({
        id: applications.id,
        name: applications.name,
        status: applications.status,
        ownerAccountId: applications.ownerAccountId,
      })
      .from(applications)
      .where(
        and(
          eq(applications.id, requestedAppId),
          ne(applications.status, "deleted"),
        ),
      )
      .limit(1)
      .for("update");

    if (!application) {
      throw new Error(`Application id "${requestedAppId}" was not found.`);
    }
    const appName = application.name;

    // The owner comes from the exact application row. A username supplied by a
    // workflow operator must never rebind credential authority.
    const [owner] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, application.ownerAccountId))
      .limit(1);
    if (!owner) {
      throw new Error(
        `Application id "${application.id}" has no resolvable owner account.`,
      );
    }
    const ownerUsername = owner.username;
    logger.info("Resolved exact application owner", {
      applicationId: application.id,
      ownerId: owner.id,
    });

    if (application.status !== "active") {
      logger.warn("Application is not active", {
        app: appName,
        applicationId: application.id,
        status: application.status,
      });
      throw new Error(
        `Application "${appName}" is not active ` +
          `(status: ${application.status}). Refusing to provision a credential.`,
      );
    }

    logger.info("Resolved active Application", {
      app: appName,
      applicationId: application.id,
    });

    // ── 2. Idempotency: reuse one exact-scope usable service credential ──
    const existingRows = await db
      .select({
        id: applicationCredentials.id,
        name: applicationCredentials.name,
        publicKey: applicationCredentials.publicKey,
        scopes: applicationCredentials.scopes,
        status: applicationCredentials.status,
        expiresAt: applicationCredentials.expiresAt,
      })
      .from(applicationCredentials)
      .where(
        and(
          eq(applicationCredentials.applicationId, application.id),
          eq(applicationCredentials.type, "service"),
          eq(applicationCredentials.environment, environment),
          ne(applicationCredentials.status, "revoked"),
        ),
      );

    const isolateCredentialName = process.env.ISOLATE_CREDENTIAL_NAME === "true";
    const candidateRows = isolateCredentialName
      ? existingRows.filter((row) => row.name === credentialName)
      : existingRows;
    const usableCredentials = candidateRows.filter(isCredentialUsable);
    const exactScopeCredentials = usableCredentials.filter((credential) =>
      hasExactScopeSet(credential.scopes, scopes),
    );
    if (exactScopeCredentials.length > 1) {
      throw new Error(
        `Application "${appName}" has multiple usable ${environment} service credentials ` +
          `with the requested scopes (${exactScopeCredentials.map((credential) => credential.id).join(", ")}). ` +
          "Refusing an ambiguous reuse; revoke or rotate them explicitly.",
      );
    }
    const existing = exactScopeCredentials[0];
    if (existing) {
      logger.info(
        "Reusing existing usable service credential — NOT minting a new one",
        {
          applicationId: application.id,
          credentialId: existing.id,
          publicKey: existing.publicKey,
          environment,
        },
      );
      logger.info(
        "NOTE: the secret of an existing credential is not recoverable (only its hash is stored). " +
          "Rotate the credential if a fresh secret is required.",
      );

      const reusedResult: ResultRow = {
        app: appName,
        applicationId: application.id,
        ownerUsername,
        ownerId: owner.id,
        credentialId: existing.id,
        publicKey: existing.publicKey,
        type: "service",
        environment,
        scopes: existing.scopes,
        reused: true,
        secretEnc: null,
      };

      writeResult(reusedResult);
      return;
    }

    if (usableCredentials.length > 0) {
      throw new Error(
        `Application "${appName}" already has a usable ${environment} service credential, ` +
          "but its scopes do not exactly match the requested set. Refusing to reuse broader or " +
          "narrower authority and refusing to mint a parallel credential; rotate it explicitly.",
      );
    }

    // ── 3. No usable service credential — plan (dry-run) or mint ──
    if (dryRun) {
      logger.info("DRY RUN — would mint a new service credential", {
        app: appName,
        applicationId: application.id,
        credentialName,
        scopes,
        environment,
      });

      const planResult: ResultRow = {
        app: appName,
        applicationId: application.id,
        ownerUsername,
        ownerId: owner.id,
        credentialId: null,
        publicKey: null,
        type: "service",
        environment,
        scopes,
        reused: false,
        secretEnc: null,
      };

      writeResult(planResult);
      return;
    }

    if (!encryptionKeyHex) {
      throw new Error(
        "OUTPUT_ENCRYPTION_KEY passed validation but is unavailable",
      );
    }

    const { publicKey, secret, secretHash } = generateCredentialMaterial();

    const [credential] = await db
      .insert(applicationCredentials)
      .values({
        applicationId: application.id,
        name: credentialName,
        publicKey,
        secretHash,
        type: "service",
        environment,
        scopes,
        status: "active",
        createdByUserId: owner.id,
      })
      .returning({
        id: applicationCredentials.id,
        publicKey: applicationCredentials.publicKey,
      });

    if (!credential) {
      throw new Error("Failed to insert service credential");
    }

    logger.info("Service credential created", {
      app: appName,
      applicationId: application.id,
      credentialId: credential.id,
      publicKey: credential.publicKey,
      scopes,
      environment,
    });

    // Encrypt the plaintext secret — it is NEVER logged in plaintext anywhere.
    const secretEnc = encryptSecret(secret, encryptionKeyHex);

    const result: ResultRow = {
      app: appName,
      applicationId: application.id,
      ownerUsername,
      ownerId: owner.id,
      credentialId: credential.id,
      publicKey: credential.publicKey,
      type: "service",
      environment,
      scopes,
      reused: false,
      secretEnc,
    };

    writeResult(result);
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.error("DATABASE_URL is required");
    process.exit(1);
  }

  await connectPostgres();
  logger.info("Connected to Postgres");

  try {
    await run();
  } finally {
    await closePostgres();
    logger.info("Postgres connection closed");
  }
}

main().catch((error) => {
  logger.error(
    "Service credential provisioning failed",
    error instanceof Error ? error : new Error(String(error)),
    { component: "create-service-credential", method: "main" },
  );
  process.exit(1);
});
