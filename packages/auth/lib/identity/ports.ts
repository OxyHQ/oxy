/** The production wiring of the carrier's ports. */

import { getApiBaseUrl } from '@/lib/oxy-api-client';
import { createIdentityApi } from './api';
import type { CarrierPorts } from './carrier';
import { indexedDbEnvelopeStore } from './localEnvelope';
import { assertPasskey, createPasskey, evaluatePrf } from './passkey';

export function createPorts(): CarrierPorts {
  return {
    api: createIdentityApi(getApiBaseUrl()),
    passkeys: { create: createPasskey, assert: assertPasskey, evaluatePrf },
    local: indexedDbEnvelopeStore,
  };
}

/** A user-presentable message for any thrown value. Cancelled ceremonies read as such. */
export function messageOf(error: unknown, t: (key: string) => string): string {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return t('identity.errors.cancelled');
  }
  if (error instanceof DOMException && error.name === 'InvalidStateError') {
    return t('identity.errors.alreadyRegistered');
  }
  if (error instanceof Error && error.message) return error.message;
  return t('identity.errors.generic');
}
