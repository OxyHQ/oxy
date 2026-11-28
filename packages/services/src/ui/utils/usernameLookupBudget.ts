/**
 * Shared budget for `GET /auth/check-username`.
 *
 * Outside development that route allows ten lookups a minute per IP
 * (`checkLimiter` in `packages/api/src/routes/auth.ts`). Signup spends the
 * same budget on a debounced preview while a name is typed and again when
 * Continue confirms it. Preview stops one short of the limit, so typing
 * cannot take the request Continue needs. A lookup already in flight or
 * already answered for the same name is reused. Creating the account still
 * checks uniqueness on its own.
 */

/** Production ceiling of `checkLimiter`. Development's higher cap is ignored. */
export const USERNAME_LOOKUP_LIMIT = 10;

/** How long `checkLimiter` remembers a lookup. */
export const USERNAME_LOOKUP_WINDOW_MS = 60_000;

/**
 * Preview lookups a single window may start. One slot stays for an explicit
 * submit (`Continue`), which is the request typing must not spend.
 */
export const USERNAME_LOOKUP_BACKGROUND_MAX = USERNAME_LOOKUP_LIMIT - 1;

export type UsernameLookupPurpose = 'background' | 'submit';

type Settled = { at: number; available: boolean };

const sentAt: number[] = [];
const settled = new Map<string, Settled>();
const inflight = new Map<string, Promise<{ available: boolean }>>();

/** Tests start from an empty window. */
export function resetUsernameLookupBudget(): void {
  sentAt.length = 0;
  settled.clear();
  inflight.clear();
}

function prune(now: number): void {
  const cutoff = now - USERNAME_LOOKUP_WINDOW_MS;
  while (sentAt.length > 0 && sentAt[0] <= cutoff) sentAt.shift();
  for (const [key, value] of settled) {
    if (value.at <= cutoff) settled.delete(key);
  }
}

function roomFor(purpose: UsernameLookupPurpose): number {
  return purpose === 'background' ? USERNAME_LOOKUP_BACKGROUND_MAX : USERNAME_LOOKUP_LIMIT;
}

/** Seconds until a full window will accept another explicit lookup. `0` when it already can. */
export function usernameLookupCooldownSeconds(now = Date.now()): number {
  prune(now);
  if (sentAt.length < USERNAME_LOOKUP_LIMIT) return 0;
  const oldest = sentAt[0];
  if (oldest === undefined) return 0;
  return Math.max(1, Math.ceil((oldest + USERNAME_LOOKUP_WINDOW_MS - now) / 1000));
}

/**
 * One network lookup per name at a time, counted against the production quota.
 * `'deferred'` means this call would have been one past the purpose's room, so
 * the caller must not hit the API (a 429 counts against the same window).
 */
export async function shareUsernameLookup(
  username: string,
  purpose: UsernameLookupPurpose,
  check: (username: string) => Promise<{ available: boolean }>,
): Promise<{ available: boolean } | 'deferred'> {
  const key = username.trim().toLowerCase();
  const now = Date.now();
  prune(now);
  const cached = settled.get(key);
  if (cached) return { available: cached.available };
  const pending = inflight.get(key);
  if (pending) return pending;
  if (sentAt.length >= roomFor(purpose)) return 'deferred';
  // Record before the request starts so a second caller in this turn sees it.
  sentAt.push(now);
  const request = check(username).then((result) => {
    settled.set(key, { at: Date.now(), available: result.available });
    return result;
  });
  inflight.set(key, request);
  try {
    return await request;
  } finally {
    inflight.delete(key);
  }
}
