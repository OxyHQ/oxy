/** The production wiring of the carrier's ports. */

import { createIdentityApi } from './api';
import type { CarrierPorts } from './carrier';
import { indexedDbEnvelopeStore } from './localEnvelope';
import { assertPasskey, createPasskey, evaluatePrf } from './passkey';

const API_URL = (import.meta.env.VITE_OXY_API_URL as string | undefined) ?? 'https://api.oxy.so';

export function createPorts(): CarrierPorts {
  return {
    api: createIdentityApi(API_URL),
    passkeys: { create: createPasskey, assert: assertPasskey, evaluatePrf },
    local: indexedDbEnvelopeStore,
  };
}

/** A user-presentable message for any thrown value. Cancelled ceremonies read as such. */
export function messageOf(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return 'The passkey request was cancelled.';
  }
  if (error instanceof DOMException && error.name === 'InvalidStateError') {
    return 'This passkey is already registered here. Sign in with it instead.';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}
