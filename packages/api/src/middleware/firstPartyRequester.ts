/**
 * The person an Oxy service acts for on one of Oxy's own routes (ADR 0066).
 *
 * A first-party workload names the account with `X-Oxy-User-Id` (and the
 * person, when they operate that account, with `X-Oxy-Requester-Id`); its
 * registry entry must declare the route's area and effect. Routes ask here
 * instead of reading a header or `req.serviceRequester` themselves.
 */
import type { ServiceAuthRequest } from './auth';
import { resolveDelegatedRequester } from '../services/firstPartyDelegation.service';
import {
  platformReceiver,
  type DelegationEffect,
  type OxyPlatformReceiver,
} from '../utils/firstPartyDelegation';

export interface RequesterAccounts {
  readonly principalAccountId: string;
  readonly subjectAccountId: string;
}

function singleHeader(req: ServiceAuthRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * The accounts a first-party service acts for on `area`, or `undefined` when
 * the caller names no account (or is not a first-party service). Throws
 * `ForbiddenError` when it names one it may not act for.
 */
export async function firstPartyRequesterFor(
  req: ServiceAuthRequest,
  area: OxyPlatformReceiver,
  effect: DelegationEffect,
): Promise<RequesterAccounts | undefined> {
  const service = req.serviceApp;
  if (service?.authority !== 'first_party') return undefined;
  if (req.serviceRequester) return req.serviceRequester;
  const accountId = singleHeader(req, 'x-oxy-user-id');
  if (!accountId) return undefined;
  const key = `${area}:${effect}`;
  const known = req.serviceDelegations?.get(key);
  if (known) return known;
  const requesterAccountId = singleHeader(req, 'x-oxy-requester-id');
  const resolved = await resolveDelegatedRequester({
    applicationId: service.appId,
    on: platformReceiver(area),
    effect,
    accountId,
    ...(requesterAccountId ? { requesterAccountId } : {}),
  });
  req.serviceDelegations ??= new Map();
  req.serviceDelegations.set(key, resolved);
  return resolved;
}
