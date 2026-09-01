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

/** SMTP outbound / sending settings */
export const SMTP_OUTBOUND_CONFIG = {
  /** Optional relay host (empty = direct delivery) */
  relayHost: getEnvVar('SMTP_RELAY_HOST', ''),
  relayPort: getEnvNumber('SMTP_RELAY_PORT', 587),
  relayUser: getEnvVar('SMTP_RELAY_USER', ''),
  relayPass: getEnvVar('SMTP_RELAY_PASS', ''),
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
  // `alia-lite` is one of the four ids ADR 0008 retired, and it is CORRECT here.
  // The retirement is of those strings as **Oxy model identities** — in the Oxy
  // catalogue and in Oxy's public examples. This value never goes near either: it
  // is the `model` field of a request to Alia's OWN API
  // (`services/aiLabeling.service.ts` targets `https://api.alia.onl/v1` with
  // `ALIA_API_KEY`), where `alia-lite` is a real identifier of an Alia product
  // tier. Rewriting it to a canonical `<publisher>/<model>` would name something
  // Alia's API does not recognise, and this repository does not know a live Alia
  // model id to substitute — inventing one would silently stop labelling working.
  // Written out here because the next person to grep `alia-lite` lands on this
  // line, not on the record: `docs/inference/migration.md`,
  // "`AI_LABELING_MODEL` is not one of these".
  model: getEnvVar('AI_LABELING_MODEL', 'alia-lite'),
  timeout: getEnvNumber('AI_LABELING_TIMEOUT', 10000),
  maxBodyChars: getEnvNumber('AI_LABELING_MAX_BODY_CHARS', 1500),
  maxConcurrent: Math.max(1, getEnvNumber('AI_LABELING_MAX_CONCURRENT', 2)),
  maxQueueSize: Math.max(0, getEnvNumber('AI_LABELING_MAX_QUEUE_SIZE', 100)),
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
