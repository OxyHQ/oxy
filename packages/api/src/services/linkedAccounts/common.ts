/**
 * Shared vocabulary of the linked-accounts providers.
 */

import type { LinkedAccountCallbackError, LinkedAccountNetwork } from '@oxy.so/contracts';

/** The public origin of this API — the host of every callback and client-metadata URL. */
export function oxyApiOrigin(): string {
  return (process.env.OXY_API_URL ?? 'https://api.oxy.so').replace(/\/$/, '');
}

export function linkedAccountCallbackUrl(network: LinkedAccountNetwork): string {
  return `${oxyApiOrigin()}/linked-accounts/${network}/callback`;
}

/**
 * The identity a provider VERIFIED — read from the network after the code
 * exchange, never from anything the user supplied.
 */
export interface VerifiedExternalAccount {
  network: LinkedAccountNetwork;
  accountKey: string;
  actorUri: string;
  handle: string;
  host: string;
}

/**
 * A callback failure with the code the browser is sent back with. `cause` is
 * for the log only; it never reaches the redirect.
 */
export class LinkedAccountCallbackFailure extends Error {
  readonly code: LinkedAccountCallbackError;
  constructor(code: LinkedAccountCallbackError, message: string) {
    super(message);
    this.name = 'LinkedAccountCallbackFailure';
    this.code = code;
  }
}

/** A start request that cannot proceed (bad instance, unresolvable handle). */
export class LinkedAccountStartRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedAccountStartRefusal';
  }
}
