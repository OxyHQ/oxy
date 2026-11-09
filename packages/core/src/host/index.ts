/**
 * `@oxy.so/core/host` — the session host contract (ADR 0058 decision 1).
 *
 * A runtime that holds the person's Oxy session itself — OxyOS's Bloom host,
 * Astro's page — registers an {@link OxySessionHost} BEFORE the application's
 * bundle first imports `@oxy.so/services`. `OxyProvider` (`sessionMode:
 * 'account'`) then takes its session from the host: the host's token, the
 * host's account, and sign-in, switch and sign-out handed to the host's own UI.
 * The application does not choose and does not know which platform it is on.
 *
 * The registration lives on `globalThis[Symbol.for('oxy.so/session-host')]`,
 * not in a module variable: the runtime and the application bundle each carry
 * their own copy of this package, and the two copies must agree.
 *
 * This entry imports nothing: no React, no React Native, no optional peer, no
 * Zod, and its ESM build loads nothing through CommonJS.
 */

/** The contract version this copy of the SDK speaks. */
export const OXY_SESSION_HOST_CONTRACT = 1;

/** The platforms that may hold an Oxy session for their applications. */
export type OxyHostPlatform = 'oxyos' | 'astro';

/** Why the SDK asks the host for a token. */
export type OxyHostTokenReason = 'boot' | 'preflight' | 'response-401';

/** What an application asks the platform's own UI to do. */
export type OxyHostRequest = 'sign_in' | 'switch_account' | 'sign_out' | 'manage_account';

/** The account the platform's session acts as, from the platform's last online read. */
export interface OxyHostAccount {
  id: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  /**
   * The account's languages, primary first, as the platform last read its
   * profile. With them, on a host that does not name its own
   * {@link OxyHostSnapshot.preferredLanguages}, the SDK knows the language an
   * app speaks (ADR 0022) from the first render, offline too, without waiting
   * for the token or a profile read; without either it waits for both.
   */
  languages?: string[];
}

/**
 * The platform's session, as one value.
 *
 * - `status` — `'unavailable'` means the platform cannot answer (its service is
 *   down); the SDK treats it as signed out, never as a reason to sign in itself.
 * - `revision` — bumps on every account change; the SDK treats a new revision
 *   as one context transition (ADR 0002's token-before-notify order).
 * - `account` — present while signed in, online or not.
 * - `online` — offline, the person is still `signed_in` and the token is null.
 * - `preferredLanguages` — the platform's own languages (ADR 0058 R11).
 */
export interface OxyHostSnapshot {
  status: 'signed_in' | 'signed_out' | 'unavailable';
  revision: number;
  account: OxyHostAccount | null;
  online: boolean;
  /**
   * The platform's preferred languages, primary first, as BCP 47 tags: the
   * language the person chose for the whole system (OxyOS's Language &
   * Region, as a Mac's preferred languages). Where the platform names them
   * they are the language every app speaks, signed in or out, online or not,
   * from the first render: the account's languages are never consulted for it
   * and nothing waits for the token or a profile read (R11). A change is a new
   * snapshot of the same revision. Optional; contract 1 is unchanged.
   */
  preferredLanguages?: string[];
}

/** A token the platform minted for this application, and its own `exp` (ISO-8601). */
export interface OxyHostToken {
  accessToken: string;
  expiresAt: string;
}

/** The interface a platform implements and registers (contract 1). */
export interface OxySessionHost {
  readonly contract: 1;
  readonly platform: OxyHostPlatform;
  /** The current snapshot, synchronously. */
  snapshot(): OxyHostSnapshot;
  /** Called with no argument on every snapshot change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * A token for this application and the snapshot's account, or `null`
   * (offline, signed out, refused). `response-401` asks for a fresh mint.
   */
  getAccessToken(request: { reason: OxyHostTokenReason }): Promise<OxyHostToken | null>;
  /** Show the platform's own UI for `action`; the outcome arrives as a snapshot. */
  request(action: OxyHostRequest): Promise<void>;
}

/** What {@link getOxySessionHost} finds. */
export type OxySessionHostLookup = { host: OxySessionHost } | { unknownContract: true } | null;

const HOST_KEY = Symbol.for('oxy.so/session-host');

function hasRegistration(): boolean {
  return Object.prototype.hasOwnProperty.call(globalThis, HOST_KEY);
}

function registration(): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[HOST_KEY];
}

/**
 * Register the platform's session host. Once per process: a second call
 * throws, whichever copy of the SDK made the first.
 *
 * Call it before the application bundle's first import of `@oxy.so/services`
 * (an `OxyProvider` already mounted keeps the session source it found).
 */
export function registerOxySessionHost(host: OxySessionHost): void {
  if (host === null || typeof host !== 'object') {
    throw new TypeError('registerOxySessionHost expects a session host object');
  }
  if (hasRegistration()) {
    throw new Error('An Oxy session host is already registered in this process');
  }
  Object.defineProperty(globalThis, HOST_KEY, {
    value: host,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}

/**
 * The registered host, `{ unknownContract: true }` when something is registered
 * that this copy of the SDK cannot speak to (another contract number, or not a
 * host at all), or `null` when nothing is registered.
 *
 * An unknown contract means a platform holds the session and forbids a second
 * credential: the SDK runs signed out, never its own sign-in.
 */
export function getOxySessionHost(): OxySessionHostLookup {
  if (!hasRegistration()) return null;
  const candidate = registration() as Partial<OxySessionHost> | null | undefined;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    candidate.contract !== OXY_SESSION_HOST_CONTRACT ||
    (candidate.platform !== 'oxyos' && candidate.platform !== 'astro') ||
    !isFunction(candidate.snapshot) ||
    !isFunction(candidate.subscribe) ||
    !isFunction(candidate.getAccessToken) ||
    !isFunction(candidate.request)
  ) {
    return { unknownContract: true };
  }
  return { host: candidate as OxySessionHost };
}
