/**
 * The authenticator app (RFC 6238 TOTP): an optional second factor for every
 * sign-in once it is on (`services/signInSession.service.ts`).
 *
 * Compatibility with every authenticator on the market decides the algorithm:
 * HMAC-SHA-1, 30-second steps, 6 digits, a 160-bit secret. A code is accepted
 * one step either side of now (clock drift), and never twice: the step of the
 * last accepted code is stored and every later code must be from a newer step,
 * checked and advanced in ONE conditional update so two concurrent requests
 * cannot both spend the same code.
 *
 * - Enrolling stores a PENDING secret (sealed with `utils/secretBox.ts`) and
 *   shows it once; nothing asks for it until a first code confirms it.
 * - Confirming turns it on and issues {@link TOTP_BACKUP_CODE_COUNT} one-use
 *   backup codes, stored only as HMACs; regenerating replaces the set.
 * - Wrong codes count against the account's own lockout
 *   ({@link TOTP_LOCKOUT_SCOPE}), separate from the password's.
 */
import crypto from 'node:crypto';
import { and, count, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import {
  SIGN_IN_ERROR_CODES,
  TOTP_BACKUP_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  type TotpEnrollResponse,
} from '@oxy.so/contracts';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { userTotp, userTotpBackupCodes } from '../db/schema/userTotp';
import { ApiError } from '../utils/error';
import { openSecret, sealSecret } from '../utils/secretBox';
import { SERVER_KEY_LABELS, serverHmacHex } from '../utils/serverKey';
import { clearFailures, reserveAttempt } from './loginLockout.service';

export const TOTP_LOCKOUT_SCOPE = 'totp';
const SECRET_BYTES = 20;
const ISSUER = 'Oxy';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** No 0/o, 1/l/i: a backup code is read off paper. */
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP value for `counter`. */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return binary.toString().padStart(TOTP_DIGITS, '0');
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for `now` — what an authenticator shows (tests, and nothing else, call this). */
export function totpCodeAt(secretBase32: string, now: Date): string {
  return hotp(base32Decode(secretBase32), totpStep(now));
}

/**
 * The step (now ±1) whose code `code` is and that is newer than `lastUsedStep`,
 * or null. Every candidate is compared, in constant time, whether or not an
 * earlier one matched.
 */
export function matchTotpStep(secret: Buffer, code: string, now: Date, lastUsedStep: number | null): number | null {
  if (!/^\d+$/.test(code) || code.length !== TOTP_DIGITS) return null;
  const current = totpStep(now);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, given) && (lastUsedStep === null || step > lastUsedStep) && matched === null) {
      matched = step;
    }
  }
  return matched;
}

function sealContext(userId: string): string {
  return `totp|${userId}`;
}

function normaliseBackupCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

function hashBackupCode(userId: string, code: string): string {
  return serverHmacHex(SERVER_KEY_LABELS.totpBackupCode, `totp-backup|${userId}|${normaliseBackupCode(code)}`);
}

/** Exactly six digits: an authenticator code. Anything else is tried as a backup code. */
export function isAuthenticatorCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

/** A new backup code: ten characters, always with a letter, shown as `xxxxx-xxxxx`. */
export function newBackupCode(): string {
  let code = '';
  // Always at least one letter: an all-digit code could be read as an
  // authenticator code.
  while (!/[a-z]/.test(code)) {
    code = '';
    for (let index = 0; index < 10; index += 1) {
      code += BACKUP_ALPHABET[crypto.randomInt(0, BACKUP_ALPHABET.length)];
    }
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function totpError(code: string, message: string, status = 409): ApiError {
  return new ApiError(status, message, code);
}

export interface TotpState {
  enabled: boolean;
  pending: boolean;
  backupCodesRemaining: number;
}

export async function readTotpState(userId: string, db: DatabaseOrTransaction = getDb()): Promise<TotpState> {
  const [row] = await db.select({ enabledAt: userTotp.enabledAt }).from(userTotp).where(eq(userTotp.userId, userId)).limit(1);
  const enabled = Boolean(row?.enabledAt);
  let backupCodesRemaining = 0;
  if (enabled) {
    const [codes] = await db
      .select({ value: count() })
      .from(userTotpBackupCodes)
      .where(and(eq(userTotpBackupCodes.userId, userId), isNull(userTotpBackupCodes.usedAt)));
    backupCodesRemaining = codes?.value ?? 0;
  }
  return { enabled, pending: Boolean(row) && !enabled, backupCodesRemaining };
}

export async function isTotpEnabled(userId: string, db: DatabaseOrTransaction = getDb()): Promise<boolean> {
  const [row] = await db
    .select({ userId: userTotp.userId })
    .from(userTotp)
    .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.enabledAt)))
    .limit(1);
  return Boolean(row);
}

/** A new pending secret for `userId`, replacing any earlier pending one. Refused while one is on. */
export async function enrollTotp(userId: string, accountLabel: string): Promise<TotpEnrollResponse> {
  const secretBytes = crypto.randomBytes(SECRET_BYTES);
  const secret = base32Encode(secretBytes);
  const sealed = sealSecret(secret, sealContext(userId));
  const written = await getDb()
    .insert(userTotp)
    .values({ userId, secretCiphertext: sealed })
    .onConflictDoUpdate({
      target: userTotp.userId,
      set: { secretCiphertext: sealed, lastUsedStep: null, updatedAt: new Date() },
      // Only a PENDING enrolment is replaced; an active authenticator stays.
      setWhere: isNull(userTotp.enabledAt),
    })
    .returning({ userId: userTotp.userId });
  if (written.length === 0) {
    throw totpError(SIGN_IN_ERROR_CODES.totpAlreadyEnabled, 'An authenticator is already on for this account');
  }
  const label = encodeURIComponent(`${ISSUER}:${accountLabel}`);
  const otpauthUri =
    `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
  return { secret, otpauthUri };
}

async function replaceBackupCodes(tx: DatabaseOrTransaction, userId: string): Promise<string[]> {
  const codes = Array.from({ length: TOTP_BACKUP_CODE_COUNT }, newBackupCode);
  await tx.delete(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, userId));
  await tx.insert(userTotpBackupCodes).values(codes.map((code) => ({ userId, codeHash: hashBackupCode(userId, code) })));
  return codes;
}

/**
 * Turn the pending authenticator on with its first code. Returns the backup
 * codes, shown once.
 */
export async function confirmTotp(userId: string, code: string, now: Date = new Date()): Promise<string[]> {
  const outcome = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ secretCiphertext: userTotp.secretCiphertext, enabledAt: userTotp.enabledAt })
      .from(userTotp)
      .where(eq(userTotp.userId, userId))
      .for('update')
      .limit(1);
    if (!row) return { error: totpError(SIGN_IN_ERROR_CODES.totpNotEnabled, 'Start setting up the authenticator first', 400) };
    if (row.enabledAt) return { error: totpError(SIGN_IN_ERROR_CODES.totpAlreadyEnabled, 'An authenticator is already on for this account') };
    const secret = base32Decode(openSecret(row.secretCiphertext, sealContext(userId)));
    const step = matchTotpStep(secret, code, now, null);
    if (step === null) {
      return { error: totpError(SIGN_IN_ERROR_CODES.totpCodeInvalid, 'That code is not right. Check the time on your phone and try again.', 400) };
    }
    await tx.update(userTotp).set({ enabledAt: now, lastUsedStep: step, updatedAt: now }).where(eq(userTotp.userId, userId));
    return { codes: await replaceBackupCodes(tx, userId) };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.codes;
}

/** Turn the authenticator off: the secret and every backup code are deleted. */
export async function disableTotp(userId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.delete(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, userId));
    await tx.delete(userTotp).where(eq(userTotp.userId, userId));
  });
}

/** A new set of backup codes; the old set stops working. */
export async function regenerateBackupCodes(userId: string): Promise<string[]> {
  return getDb().transaction(async (tx) => {
    if (!(await isTotpEnabled(userId, tx))) {
      throw totpError(SIGN_IN_ERROR_CODES.totpNotEnabled, 'This account has no authenticator', 400);
    }
    return replaceBackupCodes(tx, userId);
  });
}

/**
 * Spend an authenticator code or a backup code of `userId`. True when it was
 * right and is now spent. Only the conditional updates decide, so a code raced
 * by two requests is accepted once.
 */
async function spendSecondFactorCode(userId: string, code: string, now: Date): Promise<boolean> {
  const db = getDb();
  const trimmed = code.trim();
  // Exactly six digits is an authenticator code. A backup code is ten
  // characters and always has a letter (`newBackupCode`), so the two never
  // collide — however it was typed.
  if (isAuthenticatorCode(trimmed)) {
    const [row] = await db
      .select({ secretCiphertext: userTotp.secretCiphertext, lastUsedStep: userTotp.lastUsedStep })
      .from(userTotp)
      .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.enabledAt)))
      .limit(1);
    if (!row) return false;
    const secret = base32Decode(openSecret(row.secretCiphertext, sealContext(userId)));
    const step = matchTotpStep(secret, trimmed, now, row.lastUsedStep);
    if (step === null) return false;
    const advanced = await db
      .update(userTotp)
      .set({ lastUsedStep: step, updatedAt: now })
      .where(
        and(
          eq(userTotp.userId, userId),
          isNotNull(userTotp.enabledAt),
          or(isNull(userTotp.lastUsedStep), lt(userTotp.lastUsedStep, step)),
        ),
      )
      .returning({ userId: userTotp.userId });
    return advanced.length > 0;
  }

  const spent = await db
    .update(userTotpBackupCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(userTotpBackupCodes.userId, userId),
        eq(userTotpBackupCodes.codeHash, hashBackupCode(userId, trimmed)),
        isNull(userTotpBackupCodes.usedAt),
        // A backup code is only a stand-in while the authenticator is on.
        sql`exists (select 1 from ${userTotp} where ${userTotp.userId} = ${userId} and ${userTotp.enabledAt} is not null)`,
      ),
    )
    .returning({ id: userTotpBackupCodes.id });
  return spent.length > 0;
}

function lockedOut(retryAfterSeconds?: number): ApiError {
  return new ApiError(429, 'Too many wrong codes. Try again later.', SIGN_IN_ERROR_CODES.locked, retryAfterSeconds ? { retryAfterSeconds } : undefined);
}

/**
 * Check a second-factor code for `userId` under the account's lockout. Throws
 * the lockout error when locked; otherwise answers whether the code was right
 * (and spent).
 */
export async function verifySecondFactor(userId: string, code: string, now: Date = new Date()): Promise<boolean> {
  // Reserved BEFORE the check: concurrent guesses share one budget.
  const reservation = await reserveAttempt({ scope: TOTP_LOCKOUT_SCOPE, identifier: userId });
  if (reservation.locked) throw lockedOut(reservation.retryAfterSeconds);
  const ok = await spendSecondFactorCode(userId, code, now);
  if (ok) await clearFailures({ scope: TOTP_LOCKOUT_SCOPE, identifier: userId });
  return ok;
}
