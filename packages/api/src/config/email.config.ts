/**
 * Email Server Configuration
 *
 * Centralizes all email-related settings: domain, DKIM, SMTP ports,
 * spam filtering, and per-tier quota limits. Attachment storage lives in
 * the Oxy file manager (AssetService) — there is no email-specific bucket.
 */

import { getEnvVar, getEnvNumber, getEnvBoolean } from './env';

/** Primary email domain */
export const EMAIL_DOMAIN = getEnvVar('EMAIL_DOMAIN', 'oxy.so');

/** DKIM signing configuration */
export const DKIM_CONFIG = {
  domainName: EMAIL_DOMAIN,
  keySelector: getEnvVar('DKIM_SELECTOR', 'default'),
  /** PEM-encoded private key (set via env or file path) */
  privateKey: getEnvVar('DKIM_PRIVATE_KEY', ''),
};

/** SMTP inbound server settings */
export const SMTP_INBOUND_CONFIG = {
  port: getEnvNumber('SMTP_PORT', 25),
  securePorts: [465],
  starttlsPort: getEnvNumber('SMTP_STARTTLS_PORT', 587),
  host: getEnvVar('SMTP_HOST', '0.0.0.0'),
  banner: getEnvVar('SMTP_BANNER', `${EMAIL_DOMAIN} ESMTP`),
  maxMessageSize: getEnvNumber('SMTP_MAX_MESSAGE_SIZE', 25 * 1024 * 1024), // 25 MB
  /** TLS certificate paths (for production) */
  tls: {
    key: getEnvVar('SMTP_TLS_KEY', ''),
    cert: getEnvVar('SMTP_TLS_CERT', ''),
  },
};

/**
 * One configured outbound relay. A deployment can declare several; see
 * {@link SMTP_RELAYS}.
 */
export interface SmtpRelayConfig {
  /** Stable label for logs and metrics, derived from the host. */
  name: string;
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * The ordered relay list.
 *
 * `SMTP_RELAY_HOST` accepts a comma-separated list; `SMTP_RELAY_PORT`, `_USER`
 * and `_PASS` accept lists too, positionally aligned, and a single value is
 * reused for every relay. One host behaves exactly as it always did.
 *
 * Order is preference: the first entry is the primary, the rest are fallbacks.
 * Failing over is NOT "retry the message somewhere else" — see
 * `isRetryableSmtpFailure`. Only a TRANSPORT failure (connection refused, bad
 * credential, provider suspended the account) advances to the next relay; a
 * message the receiving side refused with a 5xx is refused everywhere, and
 * re-offering it through a second provider only burns that provider's
 * reputation too.
 *
 * This exists because the failure it covers is the one this platform actually
 * hit: a single relay decided it would not carry the traffic, and outbound mail
 * stopped with no second path.
 */
export function parseRelayList(): SmtpRelayConfig[] {
  const split = (raw: string): string[] =>
    raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0);

  const hosts = split(getEnvVar('SMTP_RELAY_HOST', ''));
  if (hosts.length === 0) return [];

  const ports = split(getEnvVar('SMTP_RELAY_PORT', '587'));
  const users = split(getEnvVar('SMTP_RELAY_USER', ''));
  const passes = getEnvVar('SMTP_RELAY_PASS', '').split(',').map((p) => p.trim());

  // A single value applies to every relay; otherwise entries align by position.
  const pick = (list: string[], index: number, fallback: string): string =>
    list.length === 0 ? fallback : list.length === 1 ? list[0] : (list[index] ?? fallback);

  return hosts.map((host, index) => {
    const port = Number.parseInt(pick(ports, index, '587'), 10);
    return {
      name: host,
      host,
      port: Number.isFinite(port) ? port : 587,
      user: pick(users, index, ''),
      pass: pick(passes.filter((p) => p.length > 0), index, ''),
    };
  });
}

export const SMTP_RELAYS: SmtpRelayConfig[] = parseRelayList();

/** SMTP outbound / sending settings */
export const SMTP_OUTBOUND_CONFIG = {
  /**
   * The PRIMARY relay's host, kept for the many call sites and tests that only
   * ask "is outbound configured at all". The full list is {@link SMTP_RELAYS}.
   */
  relayHost: SMTP_RELAYS[0]?.host ?? '',
  relayPort: SMTP_RELAYS[0]?.port ?? 587,
  relayUser: SMTP_RELAYS[0]?.user ?? '',
  relayPass: SMTP_RELAYS[0]?.pass ?? '',
  /** Queue retry schedule (in ms) */
  retryDelays: [60_000, 300_000, 900_000, 3600_000, 14400_000],
  /** Max retries before bouncing */
  maxRetries: 5,
};

/** Rspamd HTTP API for spam scoring */
export const SPAM_CONFIG = {
  enabled: getEnvBoolean('SPAM_FILTER_ENABLED', true),
  rspamdUrl: getEnvVar('RSPAMD_URL', 'http://localhost:11333'),
  /** Score threshold above which a message is marked as spam */
  spamThreshold: Number.parseFloat(getEnvVar('SPAM_THRESHOLD', '5.0')),
  /** Score threshold above which a message is rejected outright */
  rejectThreshold: Number.parseFloat(getEnvVar('SPAM_REJECT_THRESHOLD', '15.0')),
};

/** Storage quotas per subscription tier (in bytes) */
export const EMAIL_QUOTAS = {
  free: {
    storage: 5 * 1024 * 1024 * 1024,         // 5 GB
    maxAttachmentSize: 25 * 1024 * 1024,      // 25 MB
    dailySendLimit: 100,
    maxRecipientsPerMessage: 50,
  },
  pro: {
    storage: 50 * 1024 * 1024 * 1024,        // 50 GB
    maxAttachmentSize: 50 * 1024 * 1024,      // 50 MB
    dailySendLimit: 1_000,
    maxRecipientsPerMessage: 100,
  },
  business: {
    storage: 200 * 1024 * 1024 * 1024,       // 200 GB
    maxAttachmentSize: 100 * 1024 * 1024,     // 100 MB
    dailySendLimit: 10_000,
    maxRecipientsPerMessage: 500,
  },
} as const;

export type SubscriptionTier = keyof typeof EMAIL_QUOTAS;

/** Default mailboxes created for every user */
export const DEFAULT_MAILBOXES = [
  { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
  { name: 'Sent', path: 'Sent', specialUse: '\\Sent' },
  { name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts' },
  { name: 'Trash', path: 'Trash', specialUse: '\\Trash', retentionDays: 30 },
  { name: 'Spam', path: 'Spam', specialUse: '\\Junk', retentionDays: 30 },
  { name: 'Archive', path: 'Archive', specialUse: '\\Archive' },
  { name: 'Snoozed', path: 'Snoozed', specialUse: '\\Snoozed' },
] as const;

/** AI auto-labeling on inbound email */
export const AI_LABELING_CONFIG = {
  // Inbound email is unauthenticated, so AI labeling must be explicitly enabled
  // and bounded to avoid turning public SMTP traffic into unbounded AI calls.
  enabled: getEnvBoolean('AI_LABELING_ENABLED', false),
  timeout: getEnvNumber('AI_LABELING_TIMEOUT', 10000),
  maxBodyChars: getEnvNumber('AI_LABELING_MAX_BODY_CHARS', 1500),
  maxConcurrent: Math.max(1, getEnvNumber('AI_LABELING_MAX_CONCURRENT', 2)),
  maxQueueSize: Math.max(0, getEnvNumber('AI_LABELING_MAX_QUEUE_SIZE', 100)),
};

/** Background structured-card extraction on stored email. */
export const CARD_EXTRACTION_CONFIG = {
  // Email receipt/import can be externally triggered. Keep metered inference
  // closed until the reviewed Inbox routing profile is fully operational.
  enabled: getEnvBoolean('CARD_EXTRACTION_ENABLED', false),
};

/** Encryption settings */
export const ENCRYPTION_CONFIG = {
  /** Encrypt incoming messages at rest for users with a publicKey */
  encryptAtRest: getEnvBoolean('EMAIL_ENCRYPT_AT_REST', true),
};

/**
 * Resolve the email address for a given username.
 * This is the single source of truth — email is always derived from username.
 */
export function resolveEmailAddress(username: string): string {
  return `${username}@${EMAIL_DOMAIN}`;
}

/**
 * Extract the username from an email address on our domain.
 * Handles plus-aliases: "user+tag@oxy.so" → "user"
 * Returns null if the address is not on our domain.
 */
export function extractUsername(emailAddress: string): string | null {
  const [localPart, domain] = emailAddress.toLowerCase().split('@');
  if (!localPart || domain !== EMAIL_DOMAIN.toLowerCase()) {
    return null;
  }
  // Strip plus-alias
  return localPart.split('+')[0];
}

/**
 * Extract the plus-alias tag from an email address.
 * "user+shopping@oxy.so" → "shopping"
 * Returns null if no alias.
 */
export function extractAliasTag(emailAddress: string): string | null {
  const [localPart] = emailAddress.toLowerCase().split('@');
  const parts = localPart.split('+');
  return parts.length > 1 ? parts.slice(1).join('+') : null;
}
