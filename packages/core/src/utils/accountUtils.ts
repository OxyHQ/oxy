/**
 * Shared account types and pure helper functions.
 * Used by the @oxyhq/services account stores (Expo/RN and RN-Web).
 */

import { translate } from '../i18n';
import { getNormalizedUserHandle } from './userHandle';

export interface QuickAccount {
    sessionId: string;
    userId?: string;
    username: string;
    displayName: string;
    avatar?: string;
    avatarUrl?: string;
    /**
     * Device-local account slot index, 0..N-1 (Google-style multi-account).
     * Optional so that pre-multi-account QuickAccounts (sessionId-only) remain
     * valid; the device session set populates it where available.
     */
    authuser?: number;
    /**
     * Account's preferred Bloom color preset (e.g. `"blue"`, `"oxy"`). Drives
     * per-account theming in the account chooser. `null` / `undefined` means
     * the account has no preference and the base theme should be used.
     */
    color?: string | null;
}

/** Minimal user shape accepted by display-name helpers. Avoids importing the full User type. */
export interface DisplayNameUserShape {
    name?: string | {
        displayName?: string;
        first?: string;
        last?: string;
        full?: string;
        [key: string]: unknown;
    };
    /** Pre-normalized account-row display name, not the API User DTO field. */
    displayName?: string;
    username?: string;
    publicKey?: string;
}

/**
 * Truncate a long public key for display, e.g. `0x12345678…`.
 * Falls back to the raw key if it's too short to truncate.
 */
export const formatPublicKeyHandle = (publicKey: string): string => {
    const cleaned = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;
    if (cleaned.length <= 8) return `0x${cleaned}`;
    return `0x${cleaned.slice(0, 8)}…`;
};

/**
 * Resolve a friendly display name for a user.
 *
 * Order of preference:
 *  1. `name.displayName` from the API user contract.
 *  2. `name.full`, or composed `name.first name.last` for local unsaved shapes.
 *  3. `name` when passed as a plain string by local non-DTO call sites.
 *  4. pre-normalized account-row `displayName`.
 *  5. `username`
 *  6. `Account 0x12345678…` (derived from publicKey, when present)
 *  7. Translated fallback (e.g. "Unnamed")
 *
 * The translation key `common.unnamed` is used for the final fallback. If the
 * caller does not pass a locale, the default English translation is used.
 */
export const getAccountDisplayName = (
    user: DisplayNameUserShape | null | undefined,
    locale?: string,
): string => {
    if (!user) return translate(locale, 'common.unnamed');

    const { name, displayName, username, publicKey } = user;

    if (name && typeof name === 'object') {
        if (typeof name.displayName === 'string' && name.displayName.trim()) {
            return name.displayName.trim();
        }
        if (typeof name.full === 'string' && name.full.trim()) return name.full.trim();
        const first = typeof name.first === 'string' ? name.first.trim() : '';
        const last = typeof name.last === 'string' ? name.last.trim() : '';
        const composed = [first, last].filter(Boolean).join(' ').trim();
        if (composed) return composed;
    } else if (typeof name === 'string' && name.trim()) {
        return name.trim();
    }

    if (typeof displayName === 'string' && displayName.trim()) return displayName.trim();

    if (typeof username === 'string' && username.trim()) return username.trim();

    if (typeof publicKey === 'string' && publicKey.length > 0) {
        return translate(locale, 'common.accountFallback', {
            handle: formatPublicKeyHandle(publicKey),
        });
    }

    return translate(locale, 'common.unnamed');
};

/**
 * Resolve a `@handle` style identifier for a user.
 *
 * Returns the bare username when present (without the `@`), otherwise a
 * truncated public-key handle (`0x12345678…`), or `undefined` when neither is
 * available — callers can decide whether to hide the line entirely.
 */
export const getAccountFallbackHandle = (
    user: DisplayNameUserShape | null | undefined,
): string | undefined => {
    if (!user) return undefined;
    if (typeof user.username === 'string' && user.username.trim()) return user.username.trim();
    if (typeof user.publicKey === 'string' && user.publicKey.length > 0) {
        return formatPublicKeyHandle(user.publicKey);
    }
    return undefined;
};

/**
 * Build an ordered array of QuickAccounts from a map and order list.
 */
export const buildAccountsArray = (
    accounts: Record<string, QuickAccount>,
    order: string[]
): QuickAccount[] => {
    const result: QuickAccount[] = [];
    for (const id of order) {
        const account = accounts[id];
        if (account) result.push(account);
    }
    return result;
};

/**
 * Create a QuickAccount from user data returned by the API.
 *
 * @param sessionId - Session identifier
 * @param userData - Raw user object from the API
 * @param existingAccount - Previously cached account (to preserve avatarUrl if unchanged)
 * @param getFileDownloadUrl - Function to generate avatar download URL from file ID
 */
export const createQuickAccount = (
    sessionId: string,
    userData: {
        name?: string | { displayName?: string; full?: string; first?: string; last?: string };
        username?: string;
        publicKey?: string;
        id?: string;
        _id?: { toString(): string } | string;
        avatar?: string | null;
    },
    existingAccount?: QuickAccount,
    getFileDownloadUrl?: (fileId: string, variant: string) => string
): QuickAccount => {
    const nameObj =
        userData.name && typeof userData.name === 'object' ? userData.name : undefined;
    const apiDisplayName =
        typeof nameObj?.displayName === 'string' ? nameObj.displayName.trim() : '';
    const displayName =
        apiDisplayName ||
        getNormalizedUserHandle(userData) ||
        getAccountDisplayName(null);
    const userId = userData.id || (typeof userData._id === 'string' ? userData._id : userData._id?.toString());

    // Preserve existing avatarUrl if avatar hasn't changed (prevents image reload)
    let avatarUrl: string | undefined;
    const avatar = userData.avatar ?? undefined;
    if (existingAccount && existingAccount.avatar === avatar && existingAccount.avatarUrl) {
        avatarUrl = existingAccount.avatarUrl;
    } else if (avatar && getFileDownloadUrl) {
        avatarUrl = getFileDownloadUrl(avatar, 'thumb');
    }

    return {
        sessionId,
        userId,
        username: userData.username || '',
        displayName,
        avatar,
        avatarUrl,
    };
};

/**
 * Return the account's preferred Bloom color preset, or `null` if it has no
 * preference. Centralises the `color ?? null` normalisation so consumers can
 * drive per-account theming without duplicating the nullish-handling.
 */
export const getAccountColor = (account: QuickAccount): string | null => {
    return account.color ?? null;
};
