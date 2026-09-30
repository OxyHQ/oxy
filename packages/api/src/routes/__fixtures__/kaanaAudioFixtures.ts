// Keep reusable helpers outside __tests__ so Jest does not collect them as a suite.
//
// Fixtures for the audio chat and realtime edge suites (contract set 3.2.0,
// OxyHQ/Kaana#90): a model whose capability DECLARATIONS, modalities and unit
// prices are all chosen per test, on real Postgres rows, so a refusal is always
// traceable to the one declaration or price a case left out.

import http from 'node:http';
import { randomUUID, verify as verifySignature, type KeyObject } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { UsageUnit } from '@oxy.so/contracts';
import { getDb } from '../../config/postgres';
import { accountBalances } from '../../db/schema/accountBalances';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
} from '../../db/schema';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { usageReservations } from '../../db/schema/usageReservations';
import { users } from '../../db/schema/users';
import {
  KAANA_KEY_ID_HEADER,
  KAANA_SIGNATURE_HEADER,
  KAANA_TIMESTAMP_HEADER,
  kaanaSigningInput,
} from '../../services/httpKaanaClient';
import { provisionBillingProfile, recordTopUp } from '../../services/inferenceLedger.service';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { createNeutralRoutingPolicy, insertValidRoutingScorecard } from './kaanaRuntimeFixtures';

/**
 * The rollout flags an edge suite runs with. All four default to serving and
 * charging nobody, so an assertion about routing, holds or settlement would
 * otherwise pass for the wrong reason. See `kaanaStreaming.test.ts`.
 */
export const EDGE_ROLLOUT_ENVIRONMENT = {
  INFERENCE_EDGE_AUDIENCE: 'public',
  INFERENCE_MACHINE_CREDENTIAL_AUTH: 'enabled',
  INFERENCE_CHARGING_AUTHORIZED: 'kaana-audio-fixture:2026-08-01',
  INFERENCE_PRIVACY_REVIEW: 'kaana-audio-fixture:2026-08-01',
} as const;

/** Per-million prices, as decimal strings. Every unit an audio model can meter. */
export const AUDIO_PRICES: Readonly<Partial<Record<UsageUnit, string>>> = {
  requests: '0',
  input_tokens: '3',
  cached_input_tokens: '1',
  output_tokens: '15',
  reasoning_tokens: '15',
  audio_input_tokens: '40',
  cached_audio_input_tokens: '4',
  audio_output_tokens: '80',
  // Contract set 3.3.0: a realtime session holds its wall clock on every route,
  // so a route whose provider bills no session time prices it explicitly at zero.
  session_milliseconds: '0',
};

export interface AudioFixtureOptions {
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
  /** `null` (the default) leaves the declaration absent. */
  readonly apiFormats?: readonly string[] | null;
  readonly realtime?: { readonly transports: readonly string[]; readonly sessionKinds: readonly string[] } | null;
  /** Per-million prices. Omitting a unit leaves it UNPRICED on every route. */
  readonly prices?: Readonly<Partial<Record<UsageUnit, string>>>;
  /** How many same-model routes, one provider each. */
  readonly routes?: number;
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
  /** USD balance. */
  readonly topUp?: string;
}

export interface AudioFixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly token: string;
  readonly modelReference: string;
  readonly pinnedModelReference: string;
  readonly providers: readonly string[];
  readonly deploymentIds: readonly string[];
}

const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);
export const AUDIO_REVISION = '2026-09-30';

export async function makeAudioFixture(options: AudioFixtureOptions = {}): Promise<AudioFixture> {
  const db = getDb();
  const tag = suffix();
  const prices = options.prices ?? AUDIO_PRICES;

  const [account] = await db
    .insert(users)
    .values({ username: `audio-${tag}`, email: `audio-${tag}@example.test` })
    .returning({ id: users.id });
  const scopes = ['inference:invoke', 'inference:usage:read'];
  const [application] = await db
    .insert(applications)
    .values({ name: `Audio ${tag}`, ownerAccountId: account.id, scopes })
    .returning({ id: applications.id });
  const minted = generateMachineCredentialToken();
  const [credential] = await db
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: `key-${tag}`,
      publicKey: `oxy_dk_${tag}`,
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      type: 'machine',
      environment: 'development',
      scopes,
      status: 'active',
    })
    .returning({ id: applicationCredentials.id });

  const publisherSlug = `apub${tag}`;
  const modelSlug = `voice-${tag}`;
  await db.insert(inferencePublishers).values({ slug: publisherSlug, displayName: `Publisher ${tag}` });

  const realtime = options.realtime ?? null;
  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: modelSlug,
      displayName: `Voice ${tag}`,
      inputModalities: [...(options.inputModalities ?? ['text', 'audio'])],
      outputModalities: [...(options.outputModalities ?? ['text', 'audio'])],
      supportsTools: true,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsJsonMode: false,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsPromptCaching: true,
      maxContextTokens: options.maxContextTokens ?? 32_000,
      maxOutputTokens: options.maxOutputTokens ?? 4_096,
      ...(options.apiFormats === undefined || options.apiFormats === null
        ? {}
        : { apiFormats: [...options.apiFormats] }),
      ...(realtime === null
        ? {}
        : {
            realtimeTransports: [...realtime.transports],
            realtimeSessionKinds: [...realtime.sessionKinds],
          }),
      licenseId: 'LicenseRef-Fixture',
      licenseDisplayName: 'Fixture',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'third_party_hosted',
    })
    .returning({ id: inferenceModels.id });

  const [revision] = await db
    .insert(inferenceModelRevisions)
    .values({
      modelId: model.id,
      revision: AUDIO_REVISION,
      releasedAt: new Date(),
      isCurrent: true,
      provenanceMarking: 'none',
      contentFilteringDefault: 'none',
    })
    .returning({ id: inferenceModelRevisions.id });

  const providers: string[] = [];
  const deploymentIds: string[] = [];
  for (let index = 0; index < (options.routes ?? 1); index += 1) {
    const providerSlug = `aprov${index}${tag}`;
    const deploymentId = `kaana-audio-${index}-${tag}`;
    await db.insert(inferenceProviders).values({
      slug: providerSlug,
      displayName: `Provider ${index} ${tag}`,
      kind: 'third_party',
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
    });
    const [priceVersion] = await db
      .insert(priceVersions)
      .values({
        modelReference: `${publisherSlug}/${modelSlug}@${AUDIO_REVISION}`,
        provider: providerSlug,
        status: 'active',
        effectiveFrom: new Date(Date.now() - 60_000),
      })
      .returning({ id: priceVersions.id });
    const rows = Object.entries(prices).map(([unit, amount]) => ({
      priceVersionId: priceVersion.id,
      unit: unit as UsageUnit,
      amount: amount.includes('.') ? amount : `${amount}.000000000000`,
      per: unit === 'requests' ? 1 : 1_000_000,
    }));
    if (rows.length > 0) await db.insert(priceVersionUnitPrices).values(rows);
    await db.insert(inferenceDeployments).values({
      modelRevisionId: revision.id,
      providerSlug,
      internalRouteId: deploymentId,
      regions: ['us-west-2'],
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      status: 'active',
      legalReviewStatus: 'approved',
      legalReviewedAt: new Date(),
      legalReviewEvidenceRef: `contract-register/${tag}`,
      permissionState: 'approved',
      priceVersionId: priceVersion.id,
    });
    await insertValidRoutingScorecard({
      deploymentId,
      priceVersionId: priceVersion.id,
      changedByUserId: account.id,
      score: 100 - index,
    });
    providers.push(providerSlug);
    deploymentIds.push(deploymentId);
  }

  await createNeutralRoutingPolicy({ accountId: account.id, applicationId: application.id });
  await provisionBillingProfile({ accountId: account.id });
  await recordTopUp({
    idempotencyKey: `audio-top-up-${tag}`,
    accountId: account.id,
    currency: 'USD',
    amount: options.topUp ?? '100.000000000000',
    actor: { kind: 'machine' },
  });

  return {
    accountId: account.id,
    applicationId: application.id,
    credentialId: credential.id,
    token: minted.token,
    modelReference: `${publisherSlug}/${modelSlug}`,
    pinnedModelReference: `${publisherSlug}/${modelSlug}@${AUDIO_REVISION}`,
    providers,
    deploymentIds,
  };
}

export async function receiptsFor(accountId: string) {
  return getDb()
    .select({
      requestId: usageReceipts.requestId,
      billedAmount: usageReceipts.billedAmount,
      outcome: usageReceipts.outcome,
      usageSource: usageReceipts.usageSource,
      inputTokens: usageReceipts.inputTokens,
      outputTokens: usageReceipts.outputTokens,
      audioInputTokens: usageReceipts.audioInputTokens,
      cachedAudioInputTokens: usageReceipts.cachedAudioInputTokens,
      audioOutputTokens: usageReceipts.audioOutputTokens,
      sessionMilliseconds: usageReceipts.sessionMilliseconds,
      servingProvider: usageReceipts.servingProvider,
    })
    .from(usageReceipts)
    .where(eq(usageReceipts.accountId, accountId));
}

export async function reservationsFor(accountId: string) {
  return getDb()
    .select({
      requestId: usageReservations.requestId,
      reservedAmount: usageReservations.reservedAmount,
      status: usageReservations.status,
      expiresAt: usageReservations.expiresAt,
    })
    .from(usageReservations)
    .where(eq(usageReservations.accountId, accountId));
}

export async function balanceFor(accountId: string): Promise<{ purchased: string; reserved: string }> {
  const [row] = await getDb()
    .select()
    .from(accountBalances)
    .where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.currency, 'USD')))
    .limit(1);
  return { purchased: row.purchasedBalance, reserved: row.reservedBalance };
}

/** Kaana's own bound: five minutes either way (ADR 0015). */
const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify signed edge material the way Kaana's `internal/edgeauth` does: key id,
 * skew, and an Ed25519 signature over `kaanaSigningInput` of the exact bytes.
 */
export function verifyEdgeSignature(
  keyId: string,
  publicKey: KeyObject,
  headers: http.IncomingHttpHeaders,
  body: Buffer
): boolean {
  if (headers[KAANA_KEY_ID_HEADER.toLowerCase()] !== keyId) return false;
  const timestamp = Number(headers[KAANA_TIMESTAMP_HEADER.toLowerCase()]);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_SKEW_MS) return false;
  const raw = headers[KAANA_SIGNATURE_HEADER.toLowerCase()];
  if (typeof raw !== 'string' || !raw.startsWith('v1=')) return false;
  const signature = Buffer.from(raw.slice('v1='.length), 'base64');
  if (signature.length !== 64) return false;
  return verifySignature(null, kaanaSigningInput(keyId, timestamp, body), publicKey, signature);
}

/** A bounded poll that fails with its own message instead of a jest timeout. */
export async function waitFor<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
