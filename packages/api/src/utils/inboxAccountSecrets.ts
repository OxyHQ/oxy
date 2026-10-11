/**
 * Recognise mail whose body carries an account secret — a one-time code, a
 * password reset, a card or social-security number.
 *
 * Inbox inference uses it in two ways: Smart Reply offers no replies to such a
 * message, and the Daily Brief leaves its excerpt out, keeping only sender and
 * subject. Either way the secret itself never reaches a prompt.
 */

/** Phrases that mark sign-in and verification mail. */
export const ACCOUNT_SECRET_WORDS = [
  'password',
  'passcode',
  'one-time code',
  'one time code',
  'otp',
  '2fa',
  'mfa',
  'verification code',
  'security code',
  'reset',
  'verify your',
  'confirm your account',
] as const;

/** Shapes of a secret: a US SSN, a card number, a labelled short code. */
export const ACCOUNT_SECRET_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b(?:code|pin|otp)\s*[:#-]?\s*\d{4,8}\b/i,
] as const;

const SIX_DIGIT_CODE_PATTERN = /\b\d{6}\b/;
const SECURITY_WORD_PATTERN = /\b(?:code|pin|otp|verify|verification)\b/i;

/** "482913 is your code": a bare six-digit number followed by a security word. */
export function hasSixDigitCodeBeforeSecurityWord(content: string): boolean {
  const code = SIX_DIGIT_CODE_PATTERN.exec(content);
  if (!code) return false;
  return SECURITY_WORD_PATTERN.test(content.slice(code.index + code[0].length));
}

/** True when `content` (subject and body, any case) looks like it holds a secret. */
export function containsAccountSecret(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    ACCOUNT_SECRET_WORDS.some((word) => lower.includes(word)) ||
    ACCOUNT_SECRET_PATTERNS.some((pattern) => pattern.test(content)) ||
    hasSixDigitCodeBeforeSecurityWord(content)
  );
}
