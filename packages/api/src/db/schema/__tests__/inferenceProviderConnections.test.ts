import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "@oxyhq/db";
import {
  closePostgres,
  connectPostgres,
  getDb,
} from "../../../config/postgres";
import { inferenceProviderConnections } from "../inferenceProviderConnections";
import { inferenceProviderConnectionAuditEvents } from "../inferenceProviderConnectionAuditEvents";
import { inferenceProviderCredentialOperations } from "../inferenceProviderCredentialOperations";
import { inferenceProviders } from "../inferenceProviders";
import { users } from "../users";
import { MIGRATIONS_FOLDER } from "../../migrationsFolder";

beforeAll(connectPostgres);
afterAll(closePostgres);

function tag(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

async function baseValues(overrides: Record<string, unknown> = {}) {
  const idTag = tag();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `kcs-${idTag}`, email: `kcs-${idTag}@example.test` })
    .returning({ id: users.id });
  const provider = `kcsp${idTag}`;
  await getDb().insert(inferenceProviders).values({
    slug: provider,
    displayName: "Custody Schema Fixture",
    kind: "customer_byok",
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });
  return {
    id: uuidv7(),
    provider,
    ownerAccountId: account.id,
    scopeKind: "account" as const,
    applicationId: null,
    environment: "production" as const,
    status: "pending_validation" as const,
    custodyState: "ready" as const,
    credentialHandle: `kcred_${"a".repeat(16)}${idTag.replace(/[0189]/g, "a")}`,
    credentialRevision: 1,
    validationState: "unvalidated" as const,
    ...overrides,
  };
}

async function expectCheck(
  values: Awaited<ReturnType<typeof baseValues>>,
  name: string,
) {
  await expect(
    getDb().insert(inferenceProviderConnections).values(values),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({ code: "23514", constraint_name: name }),
  });
}

describe("inference_provider_connections Kaana custody constraints", () => {
  it("applies the real post migration and leaves no legacy secret_ref column", async () => {
    const columns = await getDb().execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inference_provider_connections'
        and column_name = 'secret_ref'
    `);
    expect(columns).toHaveLength(0);

    const post = readFileSync(
      join(MIGRATIONS_FOLDER, "0068_natural_slapstick.sql"),
      "utf8",
    );
    expect(post).toContain("-- oxy:deploy-phase=post");
    expect(post).toContain('DROP COLUMN "secret_ref"');
  });

  it("creates a PostgreSQL-only durable operation ledger with no credential column", async () => {
    const columns = await getDb().execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inference_provider_credential_operations'
      order by ordinal_position
    `);
    const names = columns.map((column) => column.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "connection_id",
        "action",
        "provider",
        "owner_account_id",
        "environment",
        "operation_actor",
        "credential_handle",
        "expected_revision",
        "state",
        "outcome_credential_handle",
        "outcome_revision",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "secret",
        "secret_base64",
        "secret_sha256",
        "plaintext",
        "ciphertext",
        "api_key",
      ]),
    );
  });

  it("keeps immutable actor attribution without blocking deletion of that member", async () => {
    const connection = await baseValues();
    await getDb().insert(inferenceProviderConnections).values(connection);
    const actorTag = tag();
    const [actor] = await getDb()
      .insert(users)
      .values({
        username: `actor-${actorTag}`,
        email: `actor-${actorTag}@example.test`,
      })
      .returning({ id: users.id });
    await getDb().insert(inferenceProviderConnectionAuditEvents).values({
      connectionId: connection.id,
      ownerAccountId: connection.ownerAccountId,
      eventType: "created",
      actorKind: "user",
      actorUserId: actor.id,
      environment: connection.environment,
      metadata: {},
    });

    await expect(
      getDb().delete(users).where(eq(users.id, actor.id)),
    ).resolves.toBeDefined();
    const [audit] = await getDb()
      .select({
        actorKind: inferenceProviderConnectionAuditEvents.actorKind,
        actorUserId: inferenceProviderConnectionAuditEvents.actorUserId,
      })
      .from(inferenceProviderConnectionAuditEvents)
      .where(
        eq(inferenceProviderConnectionAuditEvents.connectionId, connection.id),
      );
    expect(audit).toEqual({ actorKind: "user", actorUserId: actor.id });
  });

  it("persists exact operation identity and rejects an action-inexact reference", async () => {
    const connection = await baseValues();
    await getDb().insert(inferenceProviderConnections).values(connection);
    const operation = {
      id: uuidv7(),
      connectionId: connection.id,
      action: "create" as const,
      provider: connection.provider,
      ownerAccountId: connection.ownerAccountId,
      environment: connection.environment,
      operationActor: `user:${connection.ownerAccountId}`,
      credentialHandle: null,
      expectedRevision: null,
      previousConnectionStatus: null,
      state: "pending" as const,
    };
    await expect(
      getDb().insert(inferenceProviderCredentialOperations).values(operation),
    ).resolves.toBeDefined();
    await expect(
      getDb()
        .insert(inferenceProviderCredentialOperations)
        .values({
          ...operation,
          id: uuidv7(),
          credentialHandle: connection.credentialHandle,
          expectedRevision: 1,
        }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: "23514",
        constraint_name:
          "inference_provider_credential_operations_reference_action",
      }),
    });
  });

  it("proves the pre-migration inventory guard fails closed on a real PostgreSQL row", async () => {
    await getDb()
      .insert(inferenceProviderConnections)
      .values(await baseValues());
    const pre = readFileSync(
      join(MIGRATIONS_FOLDER, "0067_awesome_rawhide_kid.sql"),
      "utf8",
    );
    const inventoryGuard = pre.split("--> statement-breakpoint", 1)[0];
    await expect(getDb().execute(sql.raw(inventoryGuard))).rejects.toThrow(
      /requires an empty legacy provider-connection inventory/,
    );
  });

  it("stores an opaque handle and exact positive revision", async () => {
    const values = await baseValues();
    const [row] = await getDb()
      .insert(inferenceProviderConnections)
      .values(values)
      .returning();
    expect(row).toMatchObject({
      credentialHandle: values.credentialHandle,
      credentialRevision: 1,
      custodyState: "ready",
    });
  });

  it.each([
    { validationState: "unvalidated" as const },
    { validationState: "expired" as const },
    {
      validationState: "invalid" as const,
      validationFailureCode: "unauthorized" as const,
    },
  ])(
    "refuses an active PostgreSQL row with validation state $validationState",
    async (validation) => {
      await expectCheck(
        await baseValues({ status: "active", ...validation }),
        "inference_provider_connections_active_requires_valid",
      );
    },
  );

  it("stores Kaana revisions across the full JavaScript-safe BIGINT range", async () => {
    const expectedRevision = Number.MAX_SAFE_INTEGER - 1;
    const outcomeRevision = Number.MAX_SAFE_INTEGER;
    const connection = await baseValues({
      credentialRevision: expectedRevision,
    });
    const [storedConnection] = await getDb()
      .insert(inferenceProviderConnections)
      .values(connection)
      .returning();
    expect(storedConnection.credentialRevision).toBe(expectedRevision);

    const [storedOperation] = await getDb()
      .insert(inferenceProviderCredentialOperations)
      .values({
        id: uuidv7(),
        connectionId: connection.id,
        action: "rotate",
        provider: connection.provider,
        ownerAccountId: connection.ownerAccountId,
        environment: connection.environment,
        operationActor: `user:${connection.ownerAccountId}`,
        credentialHandle: connection.credentialHandle,
        expectedRevision,
        previousConnectionStatus: null,
        state: "applied",
        outcomeCredentialHandle: connection.credentialHandle,
        outcomeRevision,
      })
      .returning();
    expect(storedOperation.expectedRevision).toBe(expectedRevision);
    expect(storedOperation.outcomeRevision).toBe(outcomeRevision);
  });

  it("refuses locators and credential-shaped strings as handles", async () => {
    for (const credentialHandle of [
      "vault:oxy/inference/byok/production/account/connection",
      "ssm:/customer/key",
      "customer-provider-key",
    ]) {
      await expectCheck(
        await baseValues({ credentialHandle }),
        "inference_provider_connections_credential_handle_format",
      );
    }
  });

  it("requires handle and revision as one pair", async () => {
    await expectCheck(
      await baseValues({ credentialRevision: null }),
      "inference_provider_connections_credential_reference_pair",
    );
    await expectCheck(
      await baseValues({ credentialHandle: null }),
      "inference_provider_connections_credential_reference_pair",
    );
  });

  it("requires a positive revision and references for ready/revoked", async () => {
    await expectCheck(
      await baseValues({ credentialRevision: 0 }),
      "inference_provider_connections_credential_revision_positive",
    );
    await expectCheck(
      await baseValues({ credentialHandle: null, credentialRevision: null }),
      "inference_provider_connections_custody_reference_required",
    );
  });

  it("admits pending only before Kaana returns a reference", async () => {
    const pending = await baseValues({
      custodyState: "pending",
      credentialHandle: null,
      credentialRevision: null,
    });
    await expect(
      getDb().insert(inferenceProviderConnections).values(pending),
    ).resolves.toBeDefined();
    await expectCheck(
      await baseValues({ custodyState: "pending" }),
      "inference_provider_connections_pending_has_no_reference",
    );
  });

  it("prevents one Kaana handle from authorizing two connections", async () => {
    const first = await baseValues();
    await getDb().insert(inferenceProviderConnections).values(first);
    const second = await baseValues({
      credentialHandle: first.credentialHandle,
    });
    await expect(
      getDb().insert(inferenceProviderConnections).values(second),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: "23505",
        constraint_name: "inference_provider_connections_credential_handle_key",
      }),
    });
  });
});
