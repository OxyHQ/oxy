import type {
  AccountKind,
  AccountCategoryId,
  AvatarCharacter,
  UserNameResponse,
  UserRelationship,
  ThemePreference,
  OxyNotificationEntityType,
  OxyNotificationType,
} from '@oxy.so/contracts';

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
  /**
   * ActivityPub actor URIs this account is also known as — its live,
   * OAuth-proven linked Mastodon-API accounts. Emitted by
   * `GET /profiles/username/:username`; a relying app passes it to the shared
   * actor builder (`@oxy.so/federation`) so its actor publishes it.
   */
  alsoKnownAs?: string[];
  phone?: string;
  address?: string;
  /** Legacy free-text birthday, kept for backward compatibility. Prefer `dateOfBirth`. */
  birthday?: string;
  /**
   * The structured date of birth, `YYYY-MM-DD`. The new source of truth going
   * forward — `birthday` above is unparsed free text with no guaranteed
   * shape. Present only on the account's OWN profile (never on another
   * account's public profile), same visibility as `phone`/`address`/`birthday`.
   */
  dateOfBirth?: string | null;
  /**
   * Derived, non-PII signal: whether the account holder is at least 18.
   * `undefined` when `dateOfBirth` is unset ("unknown"), distinct from
   * `false` ("known, not yet 18"). Never stored — computed fresh by the API
   * on every read of the owner's own profile.
   */
  isAdult?: boolean;
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
  /**
   * Public reputation total — the figure `GET /reputation/:userId/balance` gives
   * a caller who is not the subject. Present on single-profile reads
   * (`/profiles/username/:username`, `/profiles/resolve`), so a profile screen
   * renders it with `_count` instead of requesting the balance separately.
   */
  reputationTotal?: number;
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
  /**
   * Derived from `kind === 'bot'` (the SOLE definition), NOT from `type`.
   */
  isAgent?: boolean;
  /**
   * The 3D avatar character of a `kind: 'bot'` account, drawn by Bloom's
   * `Avatar`. Present ONLY on a bot; absent for every other kind.
   */
  character?: AvatarCharacter;
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
  /** Product-specific personalization; never inferred from generic premium. */
  personalization?: { mentionMono: { allowed: boolean; expiresAt: string | null } };
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
  /** Preferred display units only; never changes a payment's denomination. */
  displayCurrency?: 'USD' | 'EUR' | 'FAIR';
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

/**
 * The actor of a notification as `GET /notifications` populates it. `name` is
 * the canonical structured name of every user DTO: render `name.displayName`,
 * which carries a non-personal actor's title as well as a person's name.
 */
export interface NotificationActor {
  _id: string;
  username?: string;
  name?: UserNameResponse;
  avatar?: string;
}

/**
 * One Oxy notification exactly as the API serializes it
 * (`packages/api/src/controllers/notification.controller.ts`). `_id` — not
 * `id` — is the key every notification endpoint addresses it by.
 */
export interface Notification {
  _id: string;
  recipientId: string;
  /** Populated on a list read; the bare id on a create or a mark-read. */
  actorId: string | NotificationActor;
  /** One of `OXY_NOTIFICATION_TYPES` (`@oxy.so/contracts`). */
  type: OxyNotificationType;
  /**
   * What `entityId` names: `post` | `reply` | `profile`, or `app` — an opaque id
   * in the notifying application's namespace (`system` notifications only).
   */
  entityType: OxyNotificationEntityType;
  entityId: string;
  /**
   * `system` notifications only: the text an Oxy service sent about the
   * recipient's own account. Render these instead of composing a sentence from
   * actor + entity.
   */
  title?: string;
  message?: string;
  /** `system` notifications only: an optional deep link (https or the sending app's scheme). */
  url?: string;
  read: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One page of `GET /notifications`, newest first. */
export interface NotificationPage {
  notifications: Notification[];
  /** Unread notifications across ALL pages. */
  unreadCount: number;
  hasMore: boolean;
  page: number;
  limit: number;
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
  blockedId:
    | string
    | {
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
  restrictedId:
    | string
    | {
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
  /**
   * Whether any application uses the file. `false` is shown as "not in use";
   * such a file is never removed for its owner (ADR 0043 D5). Absent when the
   * server did not say.
   */
  inUse?: boolean;
  /**
   * `blocked`: taken down after a content claim (ADR 0043 D10) — shown to its
   * owner as such, served to nobody. `lost`: its bytes are gone for good (D13)
   * — shown as lost, served to nobody. Absent when the server did not say.
   */
  status?: AssetStatus;
  /**
   * When the owner moved the file to trash (ISO 8601); set on a file listed by
   * `assets.list({ status: 'trash' })`. Absent when the server did not say.
   */
  trashedAt?: string | null;
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
 * Asset upload input — accepted by `oxy.assets.upload`.
 *
 * - `File` / `Blob`: standard web browser path. `upload` appends the Blob to
 *   FormData directly.
 * - {@link RNFileDescriptor}: React Native path. FormData reads the file from
 *   disk via the URI during the multipart request.
 *
 * A file over `ASSET_MULTIPART_UPLOAD_MAX_BYTES` goes straight to storage
 * instead, whichever shape it came in; pass `size` on a descriptor when it is
 * known, or `upload` reads the file once to learn it.
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

/**
 * One application's use of an asset (`file_references`, ADR 0043 D4).
 *
 * `app` keeps its key but, since the Oxy API's `0171_file_references`, holds
 * the using application's ID — the same value as `applicationId`, never a free
 * text name. `createdBy` is absent on a reference an application made with its
 * own service token.
 */
export interface AssetLink {
  app: string;
  applicationId?: string;
  entityType: string;
  entityId: string;
  createdBy?: string;
  createdAt: string;
  /** @deprecated Per-reference webhooks move to the application (ADR 0043 D9). */
  webhookUrl?: string;
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
  /**
   * The owning account. `null` (or absent) when the file is not an account's:
   * a system namespace, or an APPLICATION ({@link Asset.ownerApplicationId}).
   */
  ownerUserId?: string | null;
  /**
   * The Oxy application that owns the file — platform artwork no person owns
   * (ADR 0043). Present only on an application-owned file.
   */
  ownerApplicationId?: string;
  /**
   * `blocked`: taken down after a content claim (ADR 0043 D10) — not served
   * anywhere and its bytes cannot be uploaded again (451 `CONTENT_BLOCKED`);
   * only Oxy staff lift it. Like `trash`, never served. `lost`: its bytes are
   * gone for good (ADR 0043 D13) — the file is kept so you see why it no longer
   * opens; never served, and its owner can only delete it.
   */
  status: 'active' | 'trash' | 'blocked' | 'lost' | 'deleted';
  visibility: FileVisibility;
  usageCount: number;
  /**
   * Whether any application uses the file (has a reference to it). A file not
   * in use is never removed for its owner (ADR 0043 D5). Present on the
   * owner's own view (`assets.list`, `assets.get`) from the Oxy API with
   * migration `0172_file_lifecycle`.
   */
  inUse?: boolean;
  /** Since when no application uses the file (ISO 8601); `null` while one does. */
  unreferencedSince?: string | null;
  /** When the file entered trash (ISO 8601); `null` outside it. */
  trashedAt?: string | null;
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
  /** Replay these headers on PUT; Content-Length is supplied by the transport. */
  requiredHeaders?: Record<string, string>;
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
/**
 * A short-lived direct download URL for a file the calling application's own
 * user attached to it, from `POST /assets/service/linked-url`.
 *
 * `url` is BEARER AUTHORITY over the bytes for `expiresIn` seconds: whoever
 * holds the string is the reader, and nothing about the calling service's
 * entitlement is re-evaluated when it is used. Hand it only to a caller the
 * service has itself authorized, and never log it.
 *
 * `expiresIn` bounds when a transfer may START, not how long one may take. A
 * large file downloads fine on a slow link; a RESUMED range request after the
 * deadline does not, and needs a fresh URL.
 *
 * Unlike {@link ServiceAssetMetadata}, the absence of an id from the response is
 * an AUTHORIZATION answer as often as an existence one — see
 * `getServiceLinkedDownloadUrls`.
 */
export interface ServiceLinkedDownloadUrl {
  id: string;
  url: string;
  /** Seconds from issue until `url` stops being accepted. */
  expiresIn: number;
  mime: string;
  size: number;
  sha256: string;
}

/**
 * A file's status while it still holds its bytes: `active`, `trash`, or
 * `blocked` (taken down after a content claim, ADR 0043 D10 — never served).
 */
export type AssetLiveStatus = 'active' | 'trash' | 'blocked';

/**
 * A file's status as a lookup reports it: a live one, or `lost` — its bytes are
 * gone for good (ADR 0043 D13). A lost file is kept, never served; show it as
 * lost rather than as a broken image, and replace or remove what used it.
 */
export type AssetStatus = AssetLiveStatus | 'lost';

export interface AssetPublicUrlOptions {
  /**
   * The requested rendition's authoritative ready timestamp (for HLS,
   * ServiceAssetMetadata.hlsReadyAt). Identifies a completed generation across
   * browser and CDN caches. Never supply the current time or a random value.
   * Requires a variant and the public CDN form (no expiresIn).
   */
  revision?: string;
}

export interface ServiceAssetMetadata {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  status: AssetStatus;
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
  /**
   * When the adaptive HLS ladder for this asset finished transcoding.
   *
   * ABSENT when there is none or hlsRejectedReadyAt rejects its geometry.
   * Transcoding runs after the upload call returns, so a video may get its
   * complete ladder minutes later or remain without one after a failed job.
   * The `?variant=hls_master` URL is derivable from the
   * `id` alone, which is exactly the trap: a consumer that builds it without
   * this field hands the player a URL that 403s until the ladder exists, and
   * the player pays a failed request before falling back — once per video, per
   * play. Treat absence as "no adaptive stream, play the progressive original".
   * Pass a present value to `assets.publicUrl(id, 'hls_master', undefined,
   * { revision: hlsReadyAt })`: regeneration changes this timestamp, so a
   * browser cannot reuse a previous generation's resolver redirect.
   */
  hlsReadyAt?: string;
  /**
   * Exact ready timestamp of a legacy HLS generation whose encoded geometry
   * disagrees with the original, when that original is known H.264 MP4 with
   * AAC audio. Mutually exclusive with hlsReadyAt. Play the original URL;
   * never send progressive bytes to an HLS decoder.
   *
   * A persisted consumer may clear this file's observed readiness stamp when
   * it is no newer than the rejected timestamp (or leave absence absent).
   * Guard the write by file/row identity AND equality with the observed stamp;
   * preserve newer generations and concurrent replacements. An older revision
   * URL still resolves the current generation, not historical bytes.
   * Absence of this field is not a
   * rejection: unknown codecs/geometry and compatible legacy ladders retain
   * their existing behavior. No variant storage details are disclosed.
   */
  hlsRejectedReadyAt?: string;
  /**
   * The Oxy user who owns the file (`null` for a system-owned file such as the
   * federated media cache). PRESENT ONLY for Oxy's own applications (service
   * tokens with `tier: 'internal'`), so a first-party service can check that an
   * asset a user attached is really that user's. Absent for every other caller.
   */
  ownerUserId?: string | null;
  /**
   * The application that owns the file (ADR 0043), on the same terms as
   * `ownerUserId`, and only for an application-owned file.
   */
  ownerApplicationId?: string;
}

/**
 * A file an Oxy APPLICATION owns (ADR 0043), as the `/assets/service/app`
 * routes return it.
 */
export interface ApplicationFile {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  ext: string;
  originalName?: string;
  ownerApplicationId: string;
  status: AssetStatus;
  visibility: FileVisibility;
  createdAt: string;
  updatedAt: string;
}

/** `POST /assets/service/app`: the stored file, and whether it already existed. */
export interface ApplicationFileUpload {
  file: ApplicationFile;
  /**
   * True when this application already held these bytes: the existing file
   * comes back AS IT IS, its visibility included.
   */
  deduplicated: boolean;
}

/** One page of `GET /assets/service/app`, newest first. */
export interface ApplicationFilePage {
  files: ApplicationFile[];
  /** Pass to the next call; absent on the last page. */
  nextCursor?: string;
}

/**
 * One use of a file by the CALLING application, as `OxyServer.assets.references`
 * adds or removes it (ADR 0043 D4). There is no application field: the
 * application is always the service token's.
 */
export interface ServiceFileReference {
  fileId: string;
  /** The entity class in the application, e.g. `listing`, `place`. */
  entityType: string;
  /** The entity's id in the application's own database. */
  entityId: string;
}

/**
 * The outcome of one {@link ServiceFileReference} in a batch:
 * - add: `created`, `exists` (already referenced), or `not_found` — the file
 *   does not exist OR this application may not reference it (another
 *   application's private file, a person's private file they did not attach
 *   to this application, a trashed file it does not own); the two are
 *   deliberately indistinguishable.
 * - remove: `removed`, or `not_found` (this application held no such reference).
 */
export type ServiceFileReferenceResult = ServiceFileReference & {
  result: 'created' | 'exists' | 'removed' | 'not_found';
};

/** One pair of an inventory sent to `OxyServer.assets.references.reconcile`. */
export interface ServiceReferenceInventoryItem {
  fileId: string;
  /** The entity's id in the application's own database. */
  entityId: string;
}

/**
 * What a reconciliation did (or, with `dryRun`, would do) to the calling
 * application's references of one entity type (ADR 0043 D6):
 * - `added`: references the inventory lists and Oxy did not hold;
 * - `removed`: references Oxy held, created before the reconciliation began,
 *   that the inventory does not list (a file is never trashed for it);
 * - `unchanged`: in both;
 * - `refused`: listed pairs whose file does not exist or that this application
 *   may not reference — the rules of `references.add`.
 */
export interface ServiceReferenceReconcileResult {
  sessionId: string;
  entityType: string;
  dryRun: boolean;
  added: number;
  removed: number;
  unchanged: number;
  refused: number;
}

/**
 * How an import by URL was answered (ADR 0043 D7):
 * - `downloaded`: the bytes were fetched (first import, changed source, or a
 *   source whose file was no longer active); `deduplicated` says whether the
 *   owner already held them.
 * - `existing`: this owner imported this URL before; nothing was fetched.
 * - `not_modified`: revalidated; the source answered 304.
 */
export type FileImportOutcome = 'downloaded' | 'existing' | 'not_modified';

/** What an import says about its source — never the URL, which the caller sent. */
export interface FileImportSource {
  host: string;
  fetchedAt: string;
  etag?: string;
  lastModified?: string;
}

/** Options of an import by URL. */
export interface FileImportOptions {
  /**
   * Register the CALLING application's use of the imported file in the same
   * request (needs `files:references:write`), so a crash after the import never
   * leaves it unreferenced.
   */
  reference?: { entityType: string; entityId: string };
  /** Ask the source again (conditionally, ETag / Last-Modified) even if imported before. */
  revalidate?: boolean;
  /** How an audio source is rendered (ignored for images and videos). */
  audio?: AudioRenditionOptions;
  /**
   * How long to wait for a source over 40 MiB, which Oxy fetches in the
   * background, in ms (default 60 min). Waiting longer than that rejects with
   * `IMPORT_WAIT_TIMEOUT` (its `details.importId` names the import, which
   * keeps running: collect it with `OxyServer.assets.getImport`).
   */
  waitMs?: number;
}

/** `POST /assets/service/app/import`: the application's file and how it was obtained. */
export interface ApplicationFileImport {
  file: ApplicationFile;
  outcome: FileImportOutcome;
  deduplicated: boolean;
  source: FileImportSource;
  /** Present when a reference was asked for: `not_found` when it was refused. */
  reference?: { result: 'created' | 'exists' | 'not_found' };
}

/**
 * `POST /assets/service/app/adopt` (ADR 0043 stage 4b): this application's own
 * file of the bytes another file holds, sharing the stored object.
 */
export interface ApplicationFileAdoption {
  file: ApplicationFile;
  /** `existing`: the application already held these bytes (or the file was its own). */
  outcome: 'adopted' | 'existing';
  deduplicated: boolean;
  /** Present when a reference was asked for: `not_found` when it was refused. */
  reference?: { result: 'created' | 'exists' | 'not_found' };
}

/** One item of `POST /assets/service/app/import/batch`, answered on its own. */
export type ApplicationFileImportBatchResult =
  | ({ index: number; ok: true } & ApplicationFileImport)
  | { index: number; ok: false; error: { status: number; code: string; message: string } };

/** `POST /assets/service/user-media/import`: the account's file and how it was obtained. */
export interface ServiceUserMediaImport {
  file: ServiceUserMediaFile & { status: AssetLiveStatus };
  outcome: FileImportOutcome;
  deduplicated: boolean;
  source: FileImportSource;
  reference?: { result: 'created' | 'exists' | 'not_found' };
}

/** `POST /assets/service/user-media`: the stored file, owned by the named user. */
export interface ServiceUserMediaFile {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  visibility: FileVisibility;
}

/**
 * How Oxy renders an AUDIO file it stores (ADR 0043 stage 4c). Every audio
 * file gets an audio-only HLS ladder (AAC 64k/128k/256k, a rung above the
 * source's own bitrate is skipped), a waveform (`waveform`, peaks JSON) and a
 * 30-second `preview` clip, made after the upload returns.
 */
export interface AudioRenditionOptions {
  /** Normalize loudness (EBU R128, −16 LUFS) in the ladder and the preview. */
  normalizeLoudness?: boolean;
  /** Where the 30-second preview starts, in seconds (default 0; clamped to the file). */
  previewStartSeconds?: number;
}

/**
 * An import by URL Oxy is still running (ADR 0043 stage 4c): a source over
 * 40 MiB is fetched in the background and answered `202` with this. The SDK's
 * import methods wait for it and resolve to the ordinary import result.
 */
export interface PendingFileImport {
  importId: string;
  status: 'importing' | 'verifying';
  source: { host: string };
}

/** `GET /assets/service/{app,user-media}/imports/:importId`. */
export interface FileImportState<TFile> {
  importId: string;
  status: 'importing' | 'verifying' | 'completed' | 'failed';
  source: { host: string; fetchedAt?: string; etag?: string; lastModified?: string };
  file?: TFile;
  outcome?: FileImportOutcome;
  deduplicated?: boolean;
  reference?: { result: 'created' | 'exists' | 'not_found' };
  error?: { status: number; code: string; message: string };
}

/**
 * One application that can read one of your files with its service token
 * (ADR 0043 stage 4c), from `GET /assets/:id/access`:
 * - `upload`: the application stored the file for you (an upload, import or
 *   recording it made on your behalf);
 * - `link`: you attached the file to the application yourself (ADR 0021).
 */
export interface FileApplicationAccess {
  applicationId: string;
  name: string;
  /** The application's logo: an asset id or a URL, as the app listings answer `icon`. */
  icon: string | null;
  via: Array<'upload' | 'link'>;
  /** Since when (ISO 8601). */
  since: string;
}

/** `DELETE /assets/:id/access/:applicationId`. */
export interface FileApplicationAccessRevocation {
  fileId: string;
  applicationId: string;
  revoked: true;
  /** Play sessions of that application for the file that stopped at once. */
  streamsRevoked: number;
}

/**
 * A rung of a file's HLS ladder: the audio ladder's AAC rungs (64, 128 and 256
 * kb/s; a rung exists only when the source carries that much) and the video
 * ladder's 360p, 720p and 1080p.
 */
export type PlaySessionRendition =
  | 'hls_a64'
  | 'hls_a128'
  | 'hls_a256'
  | 'hls_360p'
  | 'hls_720p'
  | 'hls_1080p';

/** Options of `OxyServer.assets.streams.create`. */
export interface PlaySessionOptions {
  /** The end user the play is for — passed to your key authorization and revocable by it. */
  endUserId?: string;
  /** Session lifetime in seconds, 60–43200 (default 3600). Choose at least the media's length. */
  ttlSeconds?: number;
  /** `aes-128` (default): segments are encrypted and the key is served only to this session. */
  encryption?: 'aes-128' | 'none';
  /**
   * `webhook`: before the key is served, Oxy asks your verified file-events
   * endpoint (`stream.key_authorization`, see `verifyStreamKeyAuthorization`).
   */
  keyAuthorization?: 'none' | 'webhook';
  /**
   * Limit the session to these rungs of the ladder — e.g. `['hls_a64',
   * 'hls_a128']` for a listener capped at 128 kb/s. The master playlist then
   * lists only those, and Oxy refuses (404) any other rung's playlist,
   * segments and key for this session, however its URLs are edited; with
   * `aes-128` each allowed rung has its own key. A rung the file lacks is
   * simply not served; none of them ready is 409 `STREAM_RENDITIONS_NOT_READY`.
   * Omitted: the whole ladder.
   */
  renditions?: PlaySessionRendition[];
}

/** A revocable play session of one file (ADR 0043 stage 4c), `POST /assets/service/streams`. */
export interface PlaySessionState {
  sessionId: string;
  fileId: string;
  kind: 'video' | 'audio';
  status: 'active' | 'revoked' | 'expired';
  encryption: 'aes-128' | 'none';
  keyAuthorization: 'none' | 'webhook';
  endUserId: string | null;
  expiresAt: string;
  revokedAt?: string | null;
  /** The rungs the session may serve (its `renditions` allow-list), or `null`: the whole ladder. */
  allowedRenditions?: PlaySessionRendition[] | null;
}

/**
 * A play session as `streams.create` answers it: its state and its URLs. The
 * URLs carry the session's secret, which Oxy does not keep — `streams.get`
 * answers the state only ({@link PlaySessionState}).
 */
export interface PlaySession extends PlaySessionState {
  /**
   * The HLS master playlist for the player. Every playlist, segment and the
   * key are resolved relative to it and checked against the session on every
   * request: revoking it stops playback at the next request.
   */
  masterUrl: string;
  /** The ready rungs this session serves (only the allowed ones with a `renditions` list). */
  renditions: Array<{ type: string; url: string; bandwidth: number | null }>;
  /** Audio only: the 30-second preview clip. */
  previewUrl?: string;
  /** Audio only: the waveform peaks (audiowaveform JSON). */
  waveformUrl?: string;
}

/** Options of a recording target (ADR 0043 stage 4c). */
export interface RecordingTargetOptions {
  /** Stored as the original name. */
  filename?: string;
  metadata?: Record<string, unknown>;
  /** Register this application's use of the recording once stored (needs `files:references:write`). */
  reference?: { entityType: string; entityId: string };
  /** The largest recording accepted, in bytes (at most and by default 8 GiB). */
  maxBytes?: number;
  /** How long the credentials accept an upload, in seconds (60–604800, default 86400). */
  expiresInSeconds?: number;
  audio?: AudioRenditionOptions;
}

/** S3-compatible credentials scoped to ONE recording: shown only when the target is created. */
export interface RecordingTargetCredentials {
  accessKey: string;
  secret: string;
  region: string;
  /** An `https://` S3-compatible endpoint (path-style). */
  endpoint: string;
  bucket: string;
  forcePathStyle: true;
}

/** `POST /assets/service/{app,user-media}/recording-targets`. */
export interface CreatedRecordingTarget {
  targetId: string;
  status: 'awaiting_upload';
  expiresAt: string;
  /** The object key the recording must be written at. */
  filepath: string;
  s3: RecordingTargetCredentials;
  /**
   * Exactly LiveKit's `EncodedFileOutput` fields (`filepath` and `s3`): pass
   * them to an egress request as they are.
   */
  livekit: {
    filepath: string;
    s3: {
      access_key: string;
      secret: string;
      region: string;
      endpoint: string;
      bucket: string;
      force_path_style: true;
    };
  };
}

/** A recording target as it stands. */
export interface RecordingTarget<TFile = ApplicationFile | ServiceUserMediaFile> {
  targetId: string;
  status: 'awaiting_upload' | 'receiving' | 'verifying' | 'completed' | 'failed' | 'aborted';
  expiresAt: string;
  size?: number;
  file?: TFile;
  deduplicated?: boolean;
  reference?: { result: 'created' | 'exists' | 'not_found' };
  error?: { code: string; message: string };
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
  status: AssetLiveStatus;
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
  quotaEnforcement?: 'metadata_admission' | 'unconfigured';
  reservedBytes?: string | null;
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
  sign_in: 'low',
  sign_out: 'low',
  profile_updated: 'low',
  email_changed: 'medium',
  device_added: 'medium',
  device_removed: 'medium',
  security_settings_changed: 'medium',
  account_recovery: 'high',
  private_key_exported: 'high',
  backup_created: 'high',
  suspicious_activity: 'critical',
};

/**
 * Security activity event
 */
export interface SecurityActivity {
  id: string;
  userId: string;
  eventType: SecurityEventType;
  eventDescription: string;
  metadata?: Record<string, unknown>;
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
// server-authority `DeviceSession` record / `DeviceSessionState`.
export interface DeviceLinkedSession {
  sessionId: string;
  deviceId: string;
  /**
   * Not sent by `GET /session/device/sessions/:sessionId` today — every row
   * shares one device, and the account a row belongs to is `user`. Optional so
   * a caller cannot render it unchecked ("undefined (This device)").
   */
  deviceName?: string;
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
