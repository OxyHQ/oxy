/**
 * Passwords — an optional way to sign in (`POST /auth/signin/password`), set
 * or changed from the account's settings (`PUT /users/me/password`).
 *
 * Hashing is `node:crypto`'s scrypt: no dependency, memory-hard, and tunable.
 * The parameters are OWASP's scrypt equivalent to its N=2^17 baseline at a
 * quarter of the memory (N=2^15, r=8, p=3: 32 MiB per hash), so concurrent
 * sign-ins cannot exhaust a task's memory. Each hash has its own 16-byte salt
 * and is stored as a self-describing string —
 * `$scrypt$v=1$ln=15,r=8,p=3$<salt>$<hash>` — so stronger parameters later
 * need no migration: {@link needsRehash} says when to re-hash on sign-in.
 *
 * Verification recomputes with the stored parameters and compares in constant
 * time. {@link verifyPasswordOrDummy} runs the same work for an account with
 * no password (or no account), so the time a failure takes says nothing about
 * which case it was. A password is NFKC-normalised first, so the same
 * characters typed on two keyboards are the same password.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { userPasswords } from '../db/schema/userPasswords';
import { ApiError } from '../utils/error';

const SCHEME = 'scrypt';
const VERSION = 1;
const LOG_N = 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 3;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** scrypt needs 128·N·r bytes; leave headroom over the 32 MiB it uses. */
const MAX_MEMORY = 64 * 1024 * 1024;

interface Params {
  logN: number;
  r: number;
  p: number;
}

/**
 * At most {@link MAX_CONCURRENT_HASHES} scrypt runs at once (32 MiB each, on
 * libuv's small thread pool), and at most {@link MAX_WAITING_HASHES} waiting
 * for a slot. Beyond that the request fails FAST with a 503 instead of queueing
 * without bound — a flood of sign-ins can neither exhaust the task's memory nor
 * starve every other filesystem, DNS and crypto call of the thread pool.
 */
const MAX_CONCURRENT_HASHES = 4;
const MAX_WAITING_HASHES = 32;
let activeHashes = 0;
const waitingHashes: Array<() => void> = [];
let concurrencyLimit = MAX_CONCURRENT_HASHES;

/** Test-only: shrink the pool to exercise the fail-fast path. */
export function _setScryptConcurrencyForTests(limit: number | null): void {
  concurrencyLimit = limit ?? MAX_CONCURRENT_HASHES;
}

async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeHashes >= concurrencyLimit) {
    if (waitingHashes.length >= MAX_WAITING_HASHES) {
      throw new ApiError(503, 'Oxy is busy. Try again in a moment.', 'SERVICE_BUSY');
    }
    await new Promise<void>((resolve) => waitingHashes.push(resolve));
  } else {
    activeHashes += 1;
  }
  try {
    return await work();
  } finally {
    const next = waitingHashes.shift();
    // The slot passes straight to the next waiter, or is released.
    if (next) next();
    else activeHashes -= 1;
  }
}

function derive(password: string, salt: Buffer, params: Params): Promise<Buffer> {
  return withHashSlot(() => runScrypt(password, salt, params));
}

function runScrypt(password: string, salt: Buffer, params: Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_BYTES,
      { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Hash a new password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const params = { logN: LOG_N, r: BLOCK_SIZE, p: PARALLELISM };
  const key = await derive(password, salt, params);
  return `$${SCHEME}$v=${VERSION}$ln=${params.logN},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

interface Parsed extends Params {
  salt: Buffer;
  key: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  // ['', 'scrypt', 'v=1', 'ln=15,r=8,p=3', salt, hash]
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== SCHEME || parts[2] !== `v=${VERSION}`) return null;
  const match = /^ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})$/.exec(parts[3]);
  if (!match) return null;
  const params = { logN: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  // Refuse parameters a tampered row could use to exhaust memory or CPU.
  if (params.logN < 10 || params.logN > 17 || params.r < 1 || params.r > 16 || params.p < 1 || params.p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length < SALT_BYTES || key.length !== KEY_BYTES) return null;
  return { ...params, salt, key };
}

/** Whether `password` is the one `stored` was made from. Never throws on a malformed row. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed);
  return candidate.length === parsed.key.length && crypto.timingSafeEqual(candidate, parsed.key);
}

/** Whether a verified hash was made with weaker parameters than today's. */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.logN < LOG_N || parsed.r < BLOCK_SIZE || parsed.p < PARALLELISM;
}

let dummyHash: Promise<string> | null = null;

/**
 * Verify against `stored`, or — when there is nothing to verify against — spend
 * the same work on a throwaway hash and answer false.
 */
export async function verifyPasswordOrDummy(password: string, stored: string | null): Promise<boolean> {
  if (stored) return verifyPassword(password, stored);
  dummyHash ??= hashPassword(crypto.randomBytes(24).toString('base64url'));
  await verifyPassword(password, await dummyHash);
  return false;
}

/** The account's stored hash, or null. */
export async function readPasswordHash(userId: string, db: DatabaseOrTransaction = getDb()): Promise<string | null> {
  const [row] = await db
    .select({ passwordHash: userPasswords.passwordHash })
    .from(userPasswords)
    .where(eq(userPasswords.userId, userId))
    .limit(1);
  return row?.passwordHash ?? null;
}

/** Set (or replace) the account's password. */
export async function storePassword(userId: string, password: string, now: Date = new Date()): Promise<void> {
  const passwordHash = await hashPassword(password);
  await getDb()
    .insert(userPasswords)
    .values({ userId, passwordHash, changedAt: now })
    .onConflictDoUpdate({ target: userPasswords.userId, set: { passwordHash, changedAt: now, updatedAt: now } });
}
