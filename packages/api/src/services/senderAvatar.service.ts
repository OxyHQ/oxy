import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { and, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { senderAvatarIsFresh, senderAvatars } from '../db/schema/senderAvatars';
import { users } from '../db/schema/users';
import { extractUsername } from '../config/email.config';

const CACHE_TTL_DAYS = 7;
const BIMI_DNS_TIMEOUT_MS = 1500;

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);
const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x00000000, 0xff000000], // 0.0.0.0/8
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0x7f000000, 0xff000000], // 127.0.0.0/8
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0000000, 0xffffff00], // 192.0.0.0/24
  [0xc0000200, 0xffffff00], // 192.0.2.0/24
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xc6336400, 0xffffff00], // 198.51.100.0/24
  [0xcb007100, 0xffffff00], // 203.0.113.0/24
  [0xe0000000, 0xf0000000], // 224.0.0.0/4
  [0xf0000000, 0xf0000000], // 240.0.0.0/4
];

/** Build a base64-encoded proxy path for an external URL. */
function proxyPath(url: string): string {
  const encoded = Buffer.from(url, 'utf-8').toString('base64');
  return `/email/proxy?url=${encoded}`;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateOrReservedIp(host: string): boolean {
  if (net.isIPv4(host)) {
    const value = ipv4ToInt(host);
    return PRIVATE_IPV4_RANGES.some(([range, mask]) => (value & mask) === range);
  }

  if (!net.isIPv6(host)) return false;

  const normalized = host.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.') ||
    /^::ffff:172\.(1[6-9]|2[0-9]|3[01])\./.test(normalized)
  );
}

function isSafePublicHostname(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  if (!host || BLOCKED_HOSTNAMES.has(host) || isPrivateOrReservedIp(host)) return false;
  if (host.includes(':')) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    host,
  );
}

/**
 * Race a promise against a timeout so a slow/hung resolver can never stall the
 * caller. The losing branch is discarded and the timer is always cleared.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('BIMI DNS lookup timed out')), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Look up BIMI DNS TXT record for a domain.
 * Returns the logo URL (l= tag) or null.
 *
 * BIMI record format: "v=BIMI1; l=https://example.com/logo.svg; a=..."
 * Published at: default._bimi.<domain>
 */
async function lookupBimi(domain: string): Promise<string | null> {
  if (!isSafePublicHostname(domain)) return null;

  try {
    const records = await withTimeout(
      dns.resolveTxt(`default._bimi.${domain}`),
      BIMI_DNS_TIMEOUT_MS,
    );
    for (const parts of records) {
      const record = parts.join('');
      if (!record.toLowerCase().startsWith('v=bimi1')) continue;
      const logoMatch = record.match(/l=(\S+)/i);
      if (logoMatch?.[1]) {
        const logoUrl = logoMatch[1].replace(/;$/, '');
        if (logoUrl.startsWith('https://')) return logoUrl;
      }
    }
  } catch {
    // No BIMI record or DNS failure
  }
  return null;
}

/**
 * Resolve avatar for a single email address.
 * Returns a relative path (prepend API base URL on the client) or null.
 */
async function resolveAvatar(email: string): Promise<{ avatarPath: string | null; source: 'oxy' | 'bimi' | 'gravatar' | 'favicon' | 'none' }> {
  const normalized = email.trim().toLowerCase();

  // 1. Oxy user — look up by username
  const username = extractUsername(normalized);
  if (username) {
    try {
      // `lower(btrim(username))`, matching `users_lower_username_key`. A plain
      // equality is correct-looking, case-sensitive, and would not use the index.
      const [user] = await getDb()
        .select({ avatar: users.avatar })
        .from(users)
        .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
        .limit(1);
      if (user?.avatar) {
        return { avatarPath: `/api/assets/${user.avatar}/stream`, source: 'oxy' };
      }
    } catch {
      // User lookup failed — continue to fallbacks
    }
  }

  // 2. BIMI — DNS TXT record lookup for brand logo
  const domain = normalized.split('@')[1];
  if (domain) {
    const bimiLogo = await lookupBimi(domain);
    if (bimiLogo) {
      return { avatarPath: proxyPath(bimiLogo), source: 'bimi' };
    }
  }

  // 3. Gravatar — HEAD check against the fixed Gravatar host only
  const md5Hash = crypto.createHash('md5').update(normalized).digest('hex');
  const gravatarUrl = `https://www.gravatar.com/avatar/${md5Hash}?d=404&s=80`;
  try {
    const res = await fetch(gravatarUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (res.ok) {
      return { avatarPath: proxyPath(gravatarUrl), source: 'gravatar' };
    }
  } catch {
    // Gravatar check failed — continue
  }

  // 4. Domain favicon — do not probe sender-controlled hosts from the API.
  // The email proxy validates and fetches the URL only when the client requests it.
  if (domain && isSafePublicHostname(domain)) {
    const faviconUrl = `https://${domain}/favicon.ico`;
    return { avatarPath: proxyPath(faviconUrl), source: 'favicon' };
  }

  return { avatarPath: null, source: 'none' };
}

/**
 * Resolve a single sender's avatar with DB caching.
 *
 * The read carries `senderAvatarIsFresh()`. Mongo's TTL monitor was the ONLY
 * thing that stopped an expired row being served here, which made a background
 * job part of this table's correctness (`CONVENTIONS.md`, class (B)); with the
 * predicate, an expired row that the sweep has not reached yet simply misses
 * and falls through to the resolve-and-upsert path below — which is what an
 * expired row was always supposed to cause.
 */
export async function getAvatarPath(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();

  // Check cache
  const [cached] = await getDb()
    .select({ avatarPath: senderAvatars.avatarPath })
    .from(senderAvatars)
    .where(and(sql`${senderAvatars.email} = ${normalized}`, senderAvatarIsFresh()))
    .limit(1);
  if (cached) {
    return cached.avatarPath;
  }

  // Resolve and cache
  const { avatarPath, source } = await resolveAvatar(normalized);
  const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const resolvedAt = new Date();

  await getDb()
    .insert(senderAvatars)
    .values({ email: normalized, avatarPath, source, resolvedAt, expiresAt })
    .onConflictDoUpdate({
      target: senderAvatars.email,
      set: { avatarPath, source, resolvedAt, expiresAt },
    });

  return avatarPath;
}

/**
 * Batch-resolve sender avatars. Returns a map of email → relative avatar path.
 * Cache hits are returned immediately; misses are resolved in parallel (capped concurrency).
 */
export async function getAvatarPathsBatch(emails: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()))];
  const result = new Map<string, string | null>();

  if (unique.length === 0) return result;

  // Bulk cache lookup — same freshness predicate as the single read, so a stale
  // row is a MISS here too rather than a served stale avatar.
  const cached = await getDb()
    .select({ email: senderAvatars.email, avatarPath: senderAvatars.avatarPath })
    .from(senderAvatars)
    .where(and(inArray(senderAvatars.email, unique), senderAvatarIsFresh()));
  const cachedMap = new Map(cached.map((c) => [c.email, c.avatarPath]));

  const misses: string[] = [];
  for (const email of unique) {
    const hit = cachedMap.get(email);
    if (hit !== undefined) {
      result.set(email, hit);
    } else {
      misses.push(email);
    }
  }

  // Resolve misses in parallel with concurrency cap
  if (misses.length > 0) {
    const CONCURRENCY = 5;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const batch = misses.slice(i, i + CONCURRENCY);
      const resolved = await Promise.allSettled(
        batch.map(async (email) => {
          const path = await getAvatarPath(email);
          return { email, path };
        }),
      );
      resolved.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') {
          result.set(outcome.value.email, outcome.value.path);
        } else {
          // Resolution failed entirely — report null, and cache nothing. The
          // index is the position WITHIN this batch, which is what pairs an
          // outcome with its address; `indexOf` on the settled array matched
          // the first structurally-equal entry instead.
          result.set(batch[index], null);
        }
      });
    }
  }

  return result;
}
