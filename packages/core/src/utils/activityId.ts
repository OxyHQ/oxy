const ACTIVITY_ID_HEADER = 'X-Oxy-Activity-Id';
const ACTIVITY_ID_ROTATION_MS = 5 * 60 * 1_000;

let browserActivityId: string | null = null;
let browserActivityIdCreatedAt = 0;

function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function createActivityId(): string | null {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) return null;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A short-lived, page-runtime-only identifier used to count active clients.
 * It is never persisted, tied to an account, or shared between page runtimes.
 */
export function getBrowserActivityIdHeader(): Record<string, string> {
  if (!isBrowserRuntime()) return {};

  const now = Date.now();
  if (
    !browserActivityId
    || now < browserActivityIdCreatedAt
    || now - browserActivityIdCreatedAt >= ACTIVITY_ID_ROTATION_MS
  ) {
    browserActivityId = createActivityId();
    if (!browserActivityId) return {};
    browserActivityIdCreatedAt = now;
  }

  return { [ACTIVITY_ID_HEADER]: browserActivityId };
}
