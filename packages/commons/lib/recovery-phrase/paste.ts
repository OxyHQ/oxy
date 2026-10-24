import { RECOVERY_PHRASE_LENGTH } from '@/constants/auth';

/**
 * What a paste into the phrase grid holds. Commons' phrases are exactly
 * {@link RECOVERY_PHRASE_LENGTH} words.
 *
 * Every paste handler used to accept 24 words and keep the first twelve. A
 * truncated 24-word phrase passes the BIP-39 checksum about one time in
 * sixteen, and then the import quietly made a NEW identity (and, at the
 * username step, a new account) instead of restoring the one the user owns.
 * Any other count vanished without a word. Both are now reported.
 */
export type PastedPhrase = { ok: true; words: string[] } | { ok: false; count: number };

export function readPastedPhrase(text: string): PastedPhrase {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === RECOVERY_PHRASE_LENGTH) {
    return { ok: true, words };
  }
  return { ok: false, count: words.length };
}

/** The translation key (with `{{count}}`) for a paste with the wrong number of words. */
export const WRONG_WORD_COUNT_KEY = 'auth.importStep.wrongWordCount';
