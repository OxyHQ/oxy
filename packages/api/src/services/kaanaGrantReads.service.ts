/**
 * The two authorizations that hold nothing (Kaana ADR 0002, decisions 7 and
 * the table "De dónde lee Oxy hoy la política"):
 *
 *  - `catalogue.read` — what the credential may SEE on `GET kaana.ai/v1/models`
 *    and `/v1/power-levels`: the catalogue audience (`public` or
 *    `platform_internal`, from the application exactly as the old catalogue
 *    derived it) and the power levels its Console policy allows. Kaana caches
 *    the answer for at most 60 s per credential.
 *  - `receipt.read` — a generation record, amount included, for
 *    `GET kaana.ai/v1/generations/{id}` and `?idempotency_key=`. The same
 *    lookups the old edge serves (`inference:usage:read`, scoped to the
 *    caller's own credential), in the public record shape: no provider.
 */

import {
  type CatalogueAccess,
  type CatalogueAuthorizationRequest,
  catalogueAccessSchema,
  type ReceiptAccess,
  type ReceiptAuthorizationRequest,
  receiptAccessSchema,
} from '@kaana.ai/contracts/internal';
import type { GenerationReceipt } from '../schemas/inferenceEdge.schemas';
import {
  type EdgePrincipal,
  readGenerationReceipt,
  readGenerationReceiptByIdempotencyKey,
  viewerForPrincipal,
} from './inferenceEdge.service';
import { CONCRETE_POWER_LEVELS, powerLevelProfileIds } from './inferencePowerLevels.service';
import { resolveEffectiveRoutingPolicy } from './inferenceRoutingPolicy.service';

/** How long Kaana may cache a catalogue answer (the contract's ceiling). */
export const CATALOGUE_ACCESS_TTL_MS = 60_000;

export async function authorizeCatalogueRead(
  _request: CatalogueAuthorizationRequest,
  principal: EdgePrincipal,
  now: number = Date.now(),
): Promise<CatalogueAccess> {
  const viewer = viewerForPrincipal(principal);
  const policy = await resolveEffectiveRoutingPolicy(principal.applicationId);
  const allowedIds =
    policy.status === 'resolved' ? policy.stored.policy.allowedRoutingProfileIds : [];
  let allowedLevels: string[] = [];
  if (allowedIds.length > 0) {
    const ids = await powerLevelProfileIds();
    allowedLevels = (['auto', ...CONCRETE_POWER_LEVELS] as const).filter((level) => {
      const id = ids.get(level);
      return id !== undefined && allowedIds.includes(id);
    });
  }
  return catalogueAccessSchema.parse({
    schemaVersion: 1,
    kind: 'catalogue.read',
    audience: viewer.scopes.includes('platform_internal') ? 'platform_internal' : 'public',
    allowedLevels,
    expiresAt: new Date(now + CATALOGUE_ACCESS_TTL_MS).toISOString(),
  });
}

/** Oxy's record as the public contract states it: the same facts, no provider. */
export function publicGenerationRecord(receipt: GenerationReceipt): ReceiptAccess['record'] {
  if ('kind' in receipt && receipt.kind === 'metered_usage') {
    return receiptAccessSchema.shape.record.parse({
      schemaVersion: 1,
      kind: 'metered_usage',
      requestId: receipt.requestId,
      ...(receipt.generationId === undefined ? {} : { generationId: receipt.generationId }),
      applicationId: receipt.applicationId,
      credentialId: receipt.credentialId,
      ...(receipt.delegatedUserId === undefined
        ? {}
        : { delegatedUserId: receipt.delegatedUserId }),
      environment: receipt.environment,
      outcome: receipt.outcome,
      usageSource: receipt.usageSource,
      units: receipt.units,
      model: receipt.resolvedModelReference,
      settledAt: receipt.settledAt,
      meteredUsageId: receipt.meteredUsageId,
      ...(receipt.parentRequestId === undefined
        ? {}
        : { parentRequestId: receipt.parentRequestId }),
      tariff: receipt.tariff,
      customerCharge: receipt.customerCharge,
    });
  }
  const charged = receipt as Exclude<GenerationReceipt, { kind: 'metered_usage' }>;
  return receiptAccessSchema.shape.record.parse({
    schemaVersion: 1,
    kind: 'charge',
    requestId: charged.requestId,
    ...(charged.generationId === undefined ? {} : { generationId: charged.generationId }),
    applicationId: charged.applicationId,
    credentialId: charged.credentialId,
    ...(charged.delegatedUserId === undefined ? {} : { delegatedUserId: charged.delegatedUserId }),
    environment: charged.environment,
    outcome: charged.outcome,
    usageSource: charged.usageSource,
    units: charged.units,
    model: charged.resolvedModelReference,
    settledAt: charged.settledAt,
    receiptId: charged.receiptId,
    priceSnapshot: charged.priceSnapshot,
    billedAmount: charged.billedAmount,
    currency: charged.currency,
    platformFeeOnly: charged.platformFeeOnly,
  });
}

export type ReceiptReadDecision =
  | { readonly status: 'found'; readonly access: ReceiptAccess }
  | { readonly status: 'not-found' };

export async function authorizeReceiptRead(
  request: ReceiptAuthorizationRequest,
  principal: EdgePrincipal,
): Promise<ReceiptReadDecision> {
  const lookup =
    request.generationId !== undefined
      ? await readGenerationReceipt(principal, request.generationId, request.onBehalfOfUserId)
      : await readGenerationReceiptByIdempotencyKey(
          principal,
          request.idempotencyKey ?? '',
          request.onBehalfOfUserId,
        );
  if (lookup.status === 'not-found') return { status: 'not-found' };
  return {
    status: 'found',
    access: receiptAccessSchema.parse({
      schemaVersion: 1,
      kind: 'receipt.read',
      record: publicGenerationRecord(lookup.receipt),
    }),
  };
}
