import type {
  AccountKind,
  AccountCategoryId,
  UserNameResponse,
  UserRelationship,
  ThemePreference,
} from '@oxyhq/contracts';

export interface OxyConfig {
  baseURL: string;
  cloudURL?: string;
  authWebUrl?: string;
  authRedirectUri?: string;
  /**
   * The app's Oxy OAuth client id (ApplicationCredential publicKey).
   *
   * Identifies this app in OAuth authorize / consent flows (issue #214). Purely
   * declarative: the SDK stores it on `OxyServices.config.clientId` for later
   * OAuth-authorize use. It is unrelated to the cross-domain `/sso?client_id=…`
   * bounce (which uses the RP origin, not this registered client id).
   */
  clientId?: string;
  // Performance & caching options
  /**
   * Enable the per-instance GET response cache. Defaults to `true` (5-minute
   * TTL). Set to `false` to disable caching entirely for this instance — GET
   * responses are then never stored and never served from cache, so every read
   * hits the network. Useful for a linked backend client where another layer
   * (e.g. React Query) is the single cache authority and the SDK's own cache
   * would otherwise serve stale data after a write.
   */
  enableCache?: boolean;
  /**
   * Cache TTL in milliseconds (default: 5 minutes). A value `<= 0` disables the
   * per-instance GET response cache, equivalent to `enableCache: false`.
   */
  cacheTTL?: number;
  enableRequestDeduplication?: boolean;
  enableRetry?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  requestTimeout?: number; // Default timeout in milliseconds (default: 5000)
  // Rate limiting
  maxConcurrentRequests?: number;
  requestQueueSize?: number;
  // Logging
  enableLogging?: boolean;
  logLevel?: 'none' | 'error' | 'warn' | 'info' | 'debug';
  // Performance monitoring
  onRequestStart?: (url: string, method: string) => void;
  onRequestEnd?: (url: string, method: string, duration: number, success: boolean) => void;
  onRequestError?: (url: string, method: string, error: Error) => void;
}

/**
 * Privacy settings for a user account.
 *
 * All fields are optional because:
 *  - Updates are dot-path partial PATCHes — clients send only changed keys.
 *  - The server may return a partial subdocument depending on the API
 *    build (older builds returned only the field that changed).
 *  - User accounts created before a new toggle was introduced won't
 *    have that key persisted yet.
 *
 * Mirrors `IPrivacySettings` from `packages/api/src/types/privacy.types.ts`,
 * but with every field marked optional.
 */
export interface PrivacySettings {
  isPrivateAccount?: boolean;
  hideOnlineStatus?: boolean;
  hideLastSeen?: boolean;
  profileVisibility?: boolean;
  loginAlerts?: boolean;
  blockScreenshots?: boolean;
  login?: boolean;
  biometricLogin?: boolean;
  showActivity?: boolean;
  allowTagging?: boolean;
  allowMentions?: boolean;
  hideReadReceipts?: boolean;
  allowDirectMessages?: boolean;
  dataSharing?: boolean;
  locationSharing?: boolean;
  analyticsSharing?: boolean;
  sensitiveContent?: boolean;
  autoFilter?: boolean;
  muteKeywords?: boolean;
  /** Allow sharing this user's content on the fediverse. Defaults to true. */
  fediverseSharing?: boolean;
}

export interface User {
  id: string;
  publicKey: string;
  username: string;
  email?: string;
  // Avatar file id (asset id)
  avatar?: string | null;
  // Named color preset (e.g. 'teal', 'blue', 'purple')
  color?: string | null;
  // Privacy and security settings
  privacySettings?: PrivacySettings;
  /**
   * Structured human name. `name.displayName` is the canonical display string
   * resolved by the API when present; consumers render it directly instead of
   * recomposing names from `first` / `last` / `full` / `username`. It is now
   * OPTIONAL (see `UserNameResponse`) — when absent, fall back to a handle
   * (e.g. `getNormalizedUserHandle`) rather than recomposing a name locally.
   */
  name: UserNameResponse;
  bio?: string;
  /**
   * Longer public profile text. Emitted alongside `bio` by every user DTO the
   * API produces (single profile, `getUsersByIds`, follower/following/mutual
   * lists, profile search) — the two are separate fields on the User document.
   */
  description?: string;
  phone?: string;
  address?: string;
  birthday?: string;
  website?: string;
  createdAt?: string;
  updatedAt?: string;
  links?: string[];
  linksMetadata?: Array<{
    url: string;
    title?: string;
    description?: string;
    image?: string;
    id?: string;
  }>;
  // Social counts
  _count?: {
    followers?: number;
    following?: number;
  };
  accountExpiresAfterInactivityDays?: number | null; // Days of inactivity before account expires (null = never expire)
  /**
   * Account-graph classification — WHAT this account is.
   *
   * ORTHOGONAL to `type` below, and easy to confuse with it: `type` says where
   * the account lives and how it is driven (`local` / `federated` / `agent` /
   * `automated`), `kind` says what it IS (`personal` / `organization` /
   * `project` / `bot` / `channel`). A federated channel is `type: 'federated'`
   * AND `kind: 'channel'`; neither value substitutes for the other.
   *
   * This is what a consumer rendering authored content reads to tell a
   * channel's post from a person's — a channel is the author, so there is no
   * second identity to carry alongside the user.
   *
   * Absent should be read as `personal` (the column's default), not as unknown.
   */
  kind?: AccountKind;
  // User type and external account support
  type?: 'local' | 'federated' | 'agent' | 'automated';
  isFederated?: boolean;
  /** Allow sharing this user's content on the fediverse. Defaults to true. */
  fediverseSharing?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  instance?: string;
  federation?: {
    actorUri?: string;
    domain?: string;
    actorId?: string;
  };
  automation?: {
    ownerId?: string;
  };
  // Managed account fields
  isManagedAccount?: boolean;
  managedBy?: string;
  /**
   * What this account is about, for any NON-personal account. ORDERED — the
   * first element is the primary category, and nothing may reorder it.
   *
   * Stable ids, not labels: render each through the
   * `accounts.accountCategory.<id>` translation key so the reader sees their own
   * language rather than the language of whoever chose it. Absent when the
   * account has none.
   */
  accountCategories?: AccountCategoryId[];
  /**
   * The account's languages as full BCP-47 locales (`language-REGION`, e.g.
   * `en-US`, `es-MX`, `pt-BR`), ordered with the PRIMARY (UI) locale first.
   * `languages[0]` is the primary locale — there is no singular `language`
   * field. Resolve via `getUserLanguages` / `getPrimaryLanguage`, which
   * normalize, validate against the supported catalog, and de-duplicate.
   */
  languages?: string[];
  // User-controlled notification preferences. All channels default to on; users
  // opt out per-channel. Updated via `PUT /users/me`.
  notificationPreferences?: NotificationPreferences;
  // General app-wide user preferences. Updated via `PUT /users/me`.
  userPreferences?: UserPreferences;
  /**
   * Portable theme preference (mode + Bloom color-preset key). Rides the
   * self/session payload so it is present on the current-user DTO at cold boot
   * (`useAuth().user.themePreference`) with no extra fetch. Absent until the
   * user sets it. Updated via `updateThemePreference` / `updateProfile`.
   */
  themePreference?: ThemePreference;
  /**
   * The authenticated viewer's relationship to THIS profile. Populated ONLY on
   * single-profile fetches (`getProfileByUsername` / `getUserById`) when the
   * request is authenticated; absent for anonymous requests, self-views, and
   * bulk fetches — so `undefined` means "unknown", not "not following".
   */
  relationship?: UserRelationship;
  [key: string]: unknown;
}

/**
 * User-controlled notification channels. Persisted on the User document.
 */
export interface NotificationPreferences {
  /** Push notifications on registered devices. */
  pushEnabled?: boolean;
  /** Periodic email digest of activity. */
  emailDigest?: boolean;
  /** Security/account alerts (sign-ins, recovery, key changes). */
  securityAlerts?: boolean;
  /** Marketing / product update emails. */
  marketingEmails?: boolean;
}

/**
 * General per-user preferences applied across all Oxy apps for the user.
 * Persisted on the User document.
 */
export interface UserPreferences {
  /** BCP-47 language tag, e.g. "en-US", "es-ES". Empty string = follow device. */
  language?: string;
  /** Theme mode preference. */
  theme?: 'light' | 'dark' | 'system';
  /** Mirror of OS reduce-motion preference, persisted server-side. */
  reduceMotion?: boolean;
  /** IANA timezone, e.g. "Europe/Madrid". Empty string = follow device. */
  timezone?: string;
}

export interface LoginResponse {
  accessToken?: string;
  user: User;
  message?: string;
}

export interface Notification {
  id: string;
  message: string;
  // Add other notification fields as needed
}

export interface Wallet {
  id: string;
  balance: number;
  // Add other wallet fields as needed
}

export interface Transaction {
  id: string;
  amount: number;
  type: string;
  timestamp: string;
  // Add other transaction fields as needed
}

export interface BlockedUser {
  _id?: string;
  blockedId: string | {
    _id: string;
    username: string;
    avatar?: string;
    name?: { displayName?: string };
  };
  userId: string;
  createdAt?: string;
  blockedAt?: string;
  username?: string;
  avatar?: string;
}

export interface RestrictedUser {
  _id?: string;
  restrictedId: string | {
    _id: string;
    username: string;
    avatar?: string;
    name?: { displayName?: string };
  };
  userId: string;
  createdAt?: string;
  restrictedAt?: string;
  username?: string;
  avatar?: string;
}

export interface TransferFundsRequest {
  fromUserId: string;
  toUserId: string;
  amount: number;
}

export interface PurchaseRequest {
  userId: string;
  itemId: string;
  amount: number;
}

export interface WithdrawalRequest {
  userId: string;
  amount: number;
  address: string;
}

export interface TransactionResponse {
  success: boolean;
  transaction: Transaction;
}

export interface PaginationInfo {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SearchProfilesResponse {
  data: User[];
  pagination: PaginationInfo;
}

export interface ApiError {
  message: string;
  code: string;
  status: number;
  details?: Record<string, unknown>;
}

export interface PaymentMethod {
  id: string;
  type: string;
  // Add other payment method fields as needed
}

export interface PaymentRequest {
  userId: string;
  planId: string;
  paymentMethodId: string;
}

export interface PaymentResponse {
  transactionId: string;
  status: string;
}

export interface AnalyticsData {
  userId: string;
  // Add other analytics fields as needed
}

export interface FollowerDetails {
  userId: string;
  followers: number;
  // Add other follower details as needed
}

export interface ContentViewer {
  userId: string;
  viewedAt: string;
  // Add other content viewer fields as needed
}

/**
 * File management interfaces
 */
export interface FileMetadata {
  id: string;
  filename: string;
  contentType: string;
  length: number;
  chunkSize: number;
  uploadDate: string;
  metadata?: {
    userId?: string;
    description?: string;
    title?: string;
    tags?: string[];
    [key: string]: unknown;
  };
  variants?: Array<{
    type: string; // e.g. 'thumb', 'poster'
    key: string; // storage key/path
    width?: number;
    height?: number;
    readyAt?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface FileUploadResponse {
  files: FileMetadata[];
}

export interface FileListResponse {
  files: FileMetadata[];
  total: number;
  hasMore: boolean;
}

export interface FileUpdateRequest {
  filename?: string;
  metadata?: {
    description?: string;
    title?: string;
    tags?: string[];
    [key: string]: unknown;
  };
}

export interface FileDeleteResponse {
  success: boolean;
  message: string;
  fileId: string;
}

/**
 * React Native file descriptor accepted by FormData.
 *
 * On React Native, the multipart upload reads the file from disk via the URI
 * during the network request — no in-JS Blob construction is required (and
 * doing so would fail on Hermes since RN's BlobManager cannot wrap an
 * ArrayBuffer/ArrayBufferView).
 *
 * This shape matches what `expo-document-picker` and `expo-image-picker`
 * return for selected assets, and is what `OxyServices.assetUpload` accepts
 * on native platforms.
 */
export interface RNFileDescriptor {
  uri: string;
  type?: string;
  name?: string;
  size?: number;
}

/**
 * Asset upload input — accepted by `OxyServices.assetUpload` and `uploadRawFile`.
 *
 * - `File` / `Blob`: standard web browser path. `assetUpload` appends the
 *   Blob to FormData directly.
 * - {@link RNFileDescriptor}: React Native path. FormData reads the file from
 *   disk via the URI during the multipart request.
 */
export type AssetUploadInput = File | Blob | RNFileDescriptor;

/**
 * Central Asset Service interfaces
 */

/**
 * File visibility levels
 * - private: Only accessible by owner (default)
 * - public: Accessible by anyone without authentication (e.g., avatars, public profile content)
 * - unlisted: Accessible with direct link but not listed publicly
 */
export type FileVisibility = 'private' | 'public' | 'unlisted';

export interface AssetLink {
  app: string;
  entityType: string;
  entityId: string;
  createdBy: string;
  createdAt: string;
}

export type AssetMetadata = Record<string, string | number | boolean | null | undefined>;

export interface AssetVariant {
  type: string;
  key: string;
  width?: number;
  height?: number;
  readyAt?: string;
  size?: number;
  metadata?: AssetMetadata;
}

export interface Asset {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  ext: string;
  originalName?: string;
  ownerUserId: string;
  status: 'active' | 'trash' | 'deleted';
  visibility: FileVisibility;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  links: AssetLink[];
  variants: AssetVariant[];
  metadata?: AssetMetadata;
}

export interface AssetInitRequest {
  sha256: string;
  size: number;
  mime: string;
}

export interface AssetInitResponse {
  uploadUrl: string;
  fileId: string;
  sha256: string;
}

export interface AssetCompleteRequest {
  fileId: string;
  originalName: string;
  size: number;
  mime: string;
  visibility?: FileVisibility;
  metadata?: AssetMetadata;
}

export interface AssetLinkRequest {
  app: string;
  entityType: string;
  entityId: string;
  visibility?: FileVisibility;
}

export interface AssetUnlinkRequest {
  app: string;
  entityType: string;
  entityId: string;
}

export interface AssetUrlResponse {
  success: boolean;
  url: string;
  variant?: string;
  expiresIn: number;
}

/**
 * Per-file result of `POST /assets/batch-access`. `allowed` is authoritative:
 * when `false` the entry carries an `error` string (e.g. `'Access denied'`,
 * `'File not found'`) and no `url`. When `true`, `url` is a caller-scoped,
 * `<img src>`-ready URL — the public CDN form for a public asset or an
 * API-origin stream URL carrying a short-lived media token for a private one.
 */
export interface BatchFileAccessEntry {
  allowed: boolean;
  url?: string;
  visibility?: FileVisibility;
  mime?: string;
  error?: string;
}

/** Envelope returned by `POST /assets/batch-access`, keyed by file id. */
export interface BatchFileAccessResponse {
  results: Record<string, BatchFileAccessEntry>;
}

export interface AssetDeleteSummary {
  fileId: string;
  wouldDelete: boolean;
  affectedApps: string[];
  remainingLinks: number;
  variants: string[];
}

export interface AssetUpdateVisibilityRequest {
  visibility: FileVisibility;
}

export interface AssetUpdateVisibilityResponse {
  success: boolean;
  file: {
    id: string;
    visibility: FileVisibility;
    updatedAt: string;
  };
}

/**
 * Minimal, service-token-scoped asset metadata returned by
 * `POST /assets/service/by-ids`.
 *
 * Resolves an Oxy asset `id` to its content-addressed identity (`sha256`),
 * MIME type, byte `size`, and storage `status`. Used by server-to-server
 * callers (e.g. Mention's MTN Protocol blob-ref resolution) that hold a
 * `files:read`-scoped service token rather than a user session. Unknown or
 * deleted ids are omitted from the response (never error the whole batch),
 * so the result may be shorter than the requested id list.
 */
export interface ServiceAssetMetadata {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  status: 'active' | 'trash';
  /** Intrinsic width in pixels when variant/metadata extraction has run. */
  width?: number;
  /** Intrinsic height in pixels when variant/metadata extraction has run. */
  height?: number;
  /** Playback duration in seconds for video/audio assets. */
  durationSec?: number;
  /** Derived once from width/height at asset processing time. */
  orientation?: 'portrait' | 'landscape' | 'square';
  /** width / height, derived at asset processing time. */
  aspectRatio?: number;
}

/**
 * Reverse-lookup asset metadata returned by `POST /assets/service/by-sha256`.
 *
 * Resolves a content-addressed `sha256` digest back to the live Oxy asset that
 * holds those bytes: its file `id`, MIME type, byte `size`, storage `status`,
 * and — for active, public, CDN-reachable assets only — a public `url`
 * (`cloud.oxy.so`). This is the inverse of {@link ServiceAssetMetadata}: it lets
 * a `files:read`-scoped service-to-server caller (e.g. Mention's MTN materializer
 * / node-blob sync) turn a record's `blob.sha256` into a servable asset.
 *
 * `url` is omitted for private/unlisted assets (and for public assets whose
 * bytes are not yet CDN-reachable) — those must be streamed through the origin.
 * Unknown or deleted hashes are omitted from the response (never error the whole
 * batch), so the result may be shorter than the requested hash list.
 */
export interface ServiceAssetMetadataBySha {
  sha256: string;
  id: string;
  mime: string;
  size: number;
  status: 'active' | 'trash';
  url?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  orientation?: 'portrait' | 'landscape' | 'square';
  aspectRatio?: number;
}

/**
 * Account storage usage (server-side usage, not local AsyncStorage)
 */
export interface AccountStorageCategoryUsage {
  bytes: number;
  count: number;
}

export interface AccountStorageUsageResponse {
  plan: 'basic' | 'pro' | 'business';
  totalUsedBytes: number;
  totalLimitBytes: number;
  categories: {
    documents: AccountStorageCategoryUsage;
    mail: AccountStorageCategoryUsage;
    photosVideos: AccountStorageCategoryUsage;
    recordings: AccountStorageCategoryUsage;
    family: AccountStorageCategoryUsage;
    other: AccountStorageCategoryUsage;
  };
  updatedAt: string;
}

/**
 * Security activity event types
 */
export type SecurityEventType = 
  | 'sign_in'
  | 'sign_out'
  | 'email_changed'
  | 'profile_updated'
  | 'device_added'
  | 'device_removed'
  | 'account_recovery'
  | 'security_settings_changed'
  | 'private_key_exported'
  | 'backup_created'
  | 'suspicious_activity';

/**
 * Security event severity levels
 */
export type SecurityEventSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Security event severity mapping (single source of truth)
 * Maps each event type to its default severity level
 */
export const SECURITY_EVENT_SEVERITY_MAP: Record<SecurityEventType, SecurityEventSeverity> = {
  'sign_in': 'low',
  'sign_out': 'low',
  'profile_updated': 'low',
  'email_changed': 'medium',
  'device_added': 'medium',
  'device_removed': 'medium',
  'security_settings_changed': 'medium',
  'account_recovery': 'high',
  'private_key_exported': 'high',
  'backup_created': 'high',
  'suspicious_activity': 'critical',
};

/**
 * Security activity event
 */
export interface SecurityActivity {
  id: string;
  userId: string;
  eventType: SecurityEventType;
  eventDescription: string;
  metadata?: Record<string, any>;
  userAgent?: string;
  deviceId?: string;
  timestamp: string;
  severity: SecurityEventSeverity;
  createdAt: string;
}

/**
 * Security activity response with pagination
 */
export interface SecurityActivityResponse {
  data: SecurityActivity[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AssetUploadProgress {
  fileId: string;
  uploaded: number;
  total: number;
  percentage: number;
  status: 'uploading' | 'processing' | 'complete' | 'error';
  error?: string;
}

// Device-linked session interfaces — the sessions that share one physical
// device (GET /session/device/sessions/:sessionId). Distinct from the
// server-authority `DeviceSession` Mongoose model / `DeviceSessionState`.
export interface DeviceLinkedSession {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  isActive: boolean;
  lastActive: string;
  expiresAt: string;
  isCurrent: boolean;
  user?: User;
  createdAt?: string;
}

export interface DeviceLinkedSessionsResponse {
  deviceId: string;
  sessions: DeviceLinkedSession[];
}

export interface DeviceLinkedSessionLogoutResponse {
  message: string;
  deviceId: string;
  sessionsTerminated: number;
}

export interface UpdateDeviceNameResponse {
  message: string;
  deviceName: string;
}

