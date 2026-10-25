/**
 * A link to a web account that this phone started and has not finished
 * (ADR 0029 D3).
 *
 * "Link this account" makes this phone's key before anything is linked, so the
 * recovery phrase can be shown first. Leaving half-way (Back, or closing the
 * app) used to leave that key behind as an identity with no account, and
 * onboarding then offered to register it as a NEW account under a new
 * username. The pending link is persisted, so the flow can be resumed or the
 * key removed, and never registered on its own.
 *
 * The key is removed only when it is provably not an account's key: its link
 * can no longer complete with it (expired, cancelled, or never signed with it)
 * and the server does not know it. A link signed with this key and still
 * inside its deadline can still be confirmed on the other screen, so the key
 * is kept until it cannot.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { IdentityLinkState } from '@oxy.so/contracts';

export const PENDING_LINK_STORAGE_KEY = 'commons.link.pending.v1';

export interface PendingLink {
  linkId: string;
  challenge: string;
  /** The key made for this link, lowercase. */
  publicKey: string;
}

export async function persistPendingLink(link: PendingLink): Promise<void> {
  await AsyncStorage.setItem(
    PENDING_LINK_STORAGE_KEY,
    JSON.stringify({ ...link, publicKey: link.publicKey.trim().toLowerCase() }),
  );
}

export async function readPendingLink(): Promise<PendingLink | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_LINK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingLink>;
    return typeof parsed.linkId === 'string' &&
      typeof parsed.challenge === 'string' &&
      typeof parsed.publicKey === 'string'
      ? { linkId: parsed.linkId, challenge: parsed.challenge, publicKey: parsed.publicKey }
      : null;
  } catch {
    return null;
  }
}

export async function clearPendingLink(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_LINK_STORAGE_KEY);
  } catch {
    // Best effort: a stale marker is re-checked against the server before use.
  }
}

/** What to do with a pending link, from where its request stands now. */
export type PendingLinkVerdict =
  /** Not signed yet: show the confirmation again (it reuses the key). */
  | 'confirm'
  /** Signed with this key and still open: wait for the other screen. */
  | 'wait'
  /** Completed with this key: it is the account's key now; sign in. */
  | 'signIn'
  /** Can no longer complete with this key: the key may be removed. */
  | 'abandon';

export function pendingLinkVerdict(
  link: PendingLink,
  state: Pick<IdentityLinkState, 'status' | 'publicKey' | 'expiresAt'> | null,
  now: number = Date.now(),
): PendingLinkVerdict {
  if (!state) return 'abandon';
  const ours = state.publicKey?.trim().toLowerCase() === link.publicKey;
  if (state.status === 'completed') return ours ? 'signIn' : 'abandon';
  if (now >= state.expiresAt) return 'abandon';
  if (state.status === 'pending') return 'confirm';
  if (state.status === 'signed') return ours ? 'wait' : 'abandon';
  return 'abandon';
}

export interface AbandonDeps {
  link: PendingLink;
  /** The request now; `null` when it is gone (404) or cannot be read. */
  getState: () => Promise<IdentityLinkState | null>;
  currentPublicKey: () => Promise<string | null>;
  isKeyRegistered: (publicKey: string) => Promise<boolean>;
  /** Remove the unregistered key (and every local copy of it). */
  deleteKey: () => Promise<void>;
}

export type AbandonOutcome =
  | 'removed'
  /** The key is (or may still become) an account's: nothing was removed. */
  | 'kept'
  /** The phone holds a different key now: only the stale marker was cleared. */
  | 'notOurs';

/**
 * Leave a pending link for good: remove the key made for it when, and only
 * when, nothing can ever sign in with it. Never throws for a server that cannot
 * be reached: the key is then KEPT (and the marker too), and the next attempt
 * decides again.
 */
export async function abandonPendingLink(deps: AbandonDeps): Promise<AbandonOutcome> {
  const current = (await deps.currentPublicKey())?.trim().toLowerCase() ?? null;
  if (current !== deps.link.publicKey) {
    await clearPendingLink();
    return 'notOurs';
  }
  let state: IdentityLinkState | null;
  let registered: boolean;
  try {
    state = await deps.getState();
    registered = await deps.isKeyRegistered(current);
  } catch {
    return 'kept';
  }
  const verdict = pendingLinkVerdict(deps.link, state);
  if (registered || verdict === 'wait' || verdict === 'signIn') {
    return 'kept';
  }
  await deps.deleteKey();
  await clearPendingLink();
  return 'removed';
}
