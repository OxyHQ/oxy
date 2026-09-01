/**
 * Official first-party web origin allowlist — shared by OAuth redirect
 * validation and the server-side trusted-origin checks.
 */

import { CENTRAL_IDP_APEX } from './authWebUrl';
import { registrableApex } from './registrableApex';

/** Official first-party registrable apexes (mirrors API trusted origins). */
const OFFICIAL_APEXES = new Set([
  'oxy.so',
  'fairco.in',
  'mention.earth',
  'homiio.com',
  'alia.onl',
  'syra.fm',
  'allo.you',
  'tnp.network',
  'moovo.now',
  'mercaria.co',
]);

/**
 * Whether an origin is a loopback / local-dev origin (`localhost`, `127.0.0.1`,
 * or `[::1]` on any port, http or https).
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Whether an origin belongs to the official Oxy web ecosystem. */
export function isOfficialWebOrigin(origin: string): boolean {
  if (isLoopbackOrigin(origin)) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === CENTRAL_IDP_APEX || host.endsWith(`.${CENTRAL_IDP_APEX}`)) {
      return true;
    }
    const apex = registrableApex(host);
    return apex != null && OFFICIAL_APEXES.has(apex);
  } catch {
    return false;
  }
}

/** @deprecated Use {@link isOfficialWebOrigin}. */
export const isAllowedDeviceJoinOrigin = isOfficialWebOrigin;
