import { COMMONS_DENY_REASONS, type CommonsDenyReason } from "@oxyhq/contracts";
import mongoose, { type Document, Schema } from "mongoose";

/**
 * AuthSession Model
 *
 * Stores temporary authentication sessions for cross-app authentication.
 * When a third-party app wants to authenticate a user, it creates a session
 * and displays a QR code. The user scans this with Oxy Accounts to authorize.
 *
 * Lifecycle:
 *   pending    -> the SDK has created the session and is waiting
 *   authorized -> another authenticated device has approved it via
 *                 POST /auth/session/authorize/:sessionToken (requires bearer auth)
 *   consumed   -> the originating SDK has exchanged the sessionToken for
 *                 the first access token via POST /auth/session/claim
 *                 (single-use, enforced via atomic findOneAndUpdate)
 *   expired    -> TTL elapsed before authorization completed
 *   cancelled  -> user denied the authorization
 *
 * App identity:
 *   `applicationId` is the canonical, required reference to a registered
 *                   `Application` record. Every cross-app auth session is bound
 *                   to a real Application (resolved from a `clientId` or
 *                   `applicationId` at create time) — there is no free-form app
 *                   label. It links the session to authoritative, sanitized app
 *                   metadata (name/icon/badge/scopes) for the consent UI.
 *
 * Purpose:
 *   A session is EITHER a device sign-in (the historical QR/app-to-app handoff,
 *   claimed for an access token via `POST /auth/session/claim`) OR an OAuth
 *   authorization request (finalized into a single-use `AuthCode` via
 *   `POST /auth/session/finalize/:sessionToken`). One request model, one state
 *   machine, every delivery surface (popup / push / QR / deep link) converging
 *   on it — never two competing authorization models.
 */
export type AuthSessionStatus = 'pending' | 'authorized' | 'consumed' | 'expired' | 'cancelled';

/**
 * What this authorization request is FOR. Delivery progress (push sent, opened
 * in Commons, …) is never a purpose and never a status — the authoritative
 * state machine stays `pending -> authorized -> consumed` / `cancelled` /
 * `expired`.
 */
export type AuthSessionPurpose = 'device_sign_in' | 'oauth_authorization';

/**
 * The MINIMUM OAuth request binding needed to safely finalize an approval into
 * an authorization code. Deliberately does NOT duplicate anything owned by
 * `Application` (client identity, registered redirect URIs, app scopes),
 * `AuthCode` (the code itself, its hash, single-use state) or `DeviceSession`.
 * The RP-owned `state` stays in the relying party and is validated there.
 */
export interface IAuthSessionOAuthContext {
  /** Exact redirect URI, validated against the Application allowlist at bind time. */
  redirectUri: string;
  /** PKCE challenge (S256 only — `plain` is rejected at bind time). */
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  /** Requested scopes, normalized exactly like `POST /auth/oauth/authorize`. */
  scopes: string[];
  /**
   * OPTIONAL delegated subject: the account the app will act AS. The approving
   * identity must hold `account:act_as` over it — re-verified at approval AND
   * at finalization, never trusted from the request.
   */
  subjectAccountId?: mongoose.Types.ObjectId;
}

export interface IAuthSession extends Document {
  sessionToken: string;      // Unique token for this auth session (128-bit secret held only by the originating client)
  /**
   * Public single-use approval handle carried in the QR / deep link
   * (`oxycommons://approve?code=<authorizeCode>`). Unlike `sessionToken` it is
   * SAFE to display: the Commons vault approves with it via
   * `POST /auth/session/authorize-signed/:authorizeCode` (key-signed, no
   * bearer), and the originating client still claims the result with the secret
   * `sessionToken` it alone holds. 128-bit hex.
   */
  authorizeCode?: string;
  /** The browser Origin the session was created from, shown in the approval UI. */
  boundOrigin?: string;
  /**
   * Authoritative anti-phishing flag computed at create time: true ONLY when a
   * platform-trusted Application was started from one of its OWN registered
   * redirect origins (proven via the browser `Origin` header). Native callers
   * (no Origin) and untrusted/third-party apps are always `false`. The Commons
   * approval UI uses this to warn the user when a device-flow sign-in was begun
   * from an unverifiable source (the consent-phishing defense). It is NEVER a
   * gate by itself — every device-flow session is still approved interactively.
   */
  originVerified: boolean;
  /**
   * COARSE, display-only label of the client that STARTED this request
   * (`"Chrome on Windows"`), so the approval screen can say WHERE the request
   * came from. Derived server-side from the request User-Agent by
   * `deriveCoarseClientLabel` — never from the QR / deep-link payload, which the
   * requester controls and which must therefore never be displayed.
   *
   * PRIVACY: this is the WHOLE requester descriptor. The raw User-Agent is never
   * stored, and no IP address, geolocation, or country is stored anywhere on
   * this path (platform-wide no-IP-at-rest invariant). Do not widen it into a
   * fingerprint. `null` for native callers (no browser context) and for any
   * User-Agent no browser can be identified from — the UI omits the line rather
   * than showing an invented one.
   */
  requesterLabel?: string | null;
  /** Random nonce embedded in the QR payload (audit only; not a binding check). */
  challengeNonce?: string;
  applicationId: mongoose.Types.ObjectId; // Canonical, required reference to a registered Application
  /**
   * Central deviceId of the browser/device that STARTED this cross-app auth
   * session (device-flow QR attribution), resolved from an optional `deviceToken`
   * at create time. When present, the authorize paths mint the resulting session
   * onto this device so a cross-device QR sign-in converges on the originating
   * device's `DeviceSession` set instead of sprawling a fresh device. Optional —
   * native/legacy callers that pass no `deviceToken` leave it unset.
   */
  deviceId?: string;
  status: AuthSessionStatus;
  /** What the request authorizes. Legacy rows (no field) read as `device_sign_in`. */
  purpose: AuthSessionPurpose;
  /** Present only for `purpose: 'oauth_authorization'`. */
  oauth?: IAuthSessionOAuthContext;
  /**
   * The `_id` RESERVED for this request's one and only `AuthCode`, written by the
   * same atomic update that spends the session. Its presence is the proof that
   * finalization already happened: the claim is conditioned on it being null, so
   * a request can never mint a second authorization code — not on retry, not
   * under concurrent finalize calls.
   */
  finalizedAuthCodeId?: mongoose.Types.ObjectId;
  /**
   * Why a PENDING request was denied, from the closed
   * {@link COMMONS_DENY_REASONS} set. `null` when the request was never
   * denied, or when it was denied without a reason (an older approver). The
   * distinction that matters: `'not_me'` marks a denial the approver reported as
   * one they never started — an ordinary cancel is `'declined'` / absent.
   */
  deniedReason?: CommonsDenyReason | null;
  authorizedBy?: string;     // Public key of the user who authorized
  authorizedUserId?: mongoose.Types.ObjectId; // MongoDB user ID of the authorizing IDENTITY
  authorizedSessionId?: string; // The actual session ID after authorization (device sign-in only)
  /**
   * DELIVERY PROGRESS — timestamps, never statuses. When the pending request was
   * pushed to the approving identity's capable installs
   * (`POST /auth/session/deliver/:authorizeCode`). Absent means no push was ever
   * delivered (no capable install, or the client chose QR / deep link).
   */
  pushSentAt?: Date;
  /**
   * DELIVERY PROGRESS — when the approval surface first opened the request
   * (`POST /auth/session/opened/:authorizeCode`). Written once, never cleared,
   * and never a gate: the authoritative state machine is untouched by it.
   */
  openedAt?: Date;
  consumedAt?: Date;         // Timestamp when the sessionToken was exchanged for a token
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Single-nested OAuth binding. Declared as its own schema (rather than inline
 * nested paths) so the whole `oauth` path stays UNDEFINED on device-sign-in
 * rows instead of materialising an empty object that reads as truthy.
 */
const AuthSessionOAuthSchema: Schema = new Schema(
  {
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    codeChallengeMethod: { type: String, enum: ['S256'], required: true },
    scopes: { type: [String], default: [] },
    subjectAccountId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false }
);

const AuthSessionSchema: Schema = new Schema(
  {
    sessionToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Public approval handle. Sparse-unique (older rows predate it and have
    // none) — never `default: null`, or sparse uniqueness would collide.
    authorizeCode: {
      type: String,
      unique: true,
      sparse: true,
    },
    boundOrigin: {
      type: String,
      default: null,
    },
    // Anti-phishing: trusted app started from its own registered origin.
    // Defaults false so legacy rows and native callers read as unverified.
    originVerified: {
      type: Boolean,
      default: false,
    },
    // Coarse browser/OS label only ("Chrome on Windows"), or null. `maxlength`
    // is a fail-closed guard, not a formatting nicety: every derived label is a
    // handful of characters, so a future writer that tried to persist a full
    // User-Agent string here would fail validation instead of silently turning
    // this field into a fingerprint.
    requesterLabel: {
      type: String,
      default: null,
      maxlength: 64,
    },
    challengeNonce: {
      type: String,
      default: null,
    },
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'authorized', 'consumed', 'expired', 'cancelled'],
      default: 'pending',
    },
    purpose: {
      type: String,
      enum: ['device_sign_in', 'oauth_authorization'],
      default: 'device_sign_in',
    },
    oauth: {
      type: AuthSessionOAuthSchema,
    },
    // Never `required`/defaulted to anything but null — the atomic finalization
    // claim matches on `finalizedAuthCodeId: null` (which also matches a missing
    // field, so legacy rows behave as un-finalized).
    finalizedAuthCodeId: {
      type: Schema.Types.ObjectId,
      ref: 'AuthCode',
      default: null,
    },
    // Closed-set denial reason. The `enum` is the storage-level guarantee that
    // an unauthenticated caller can never write free-form text here — the route
    // already rejects anything outside the set at the edge.
    deniedReason: {
      type: String,
      enum: [...COMMONS_DENY_REASONS, null],
      default: null,
    },
    authorizedBy: {
      type: String, // Public key
      default: null,
    },
    authorizedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    authorizedSessionId: {
      type: String,
      default: null,
    },
    deviceId: {
      type: String,
      default: null,
    },
    // Delivery progress. Both default to null so the atomic "record once"
    // updates can match on `null` (which also matches a missing field, so legacy
    // rows behave as un-delivered / un-opened).
    pushSentAt: {
      type: Date,
      default: null,
    },
    openedAt: {
      type: Date,
      default: null,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index to automatically delete expired sessions after 1 hour
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

// Compound index for efficient lookups
AuthSessionSchema.index({ sessionToken: 1, status: 1 });

export const AuthSession = mongoose.model<IAuthSession>("AuthSession", AuthSessionSchema);
export default AuthSession;

