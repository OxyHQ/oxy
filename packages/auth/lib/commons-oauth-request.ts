/**
 * The OAuth-bound "Sign in with Oxy" lane for the authorize page (issue #691).
 *
 * The IdP's original OAuth path can only mint a code for a visitor who ALREADY
 * has a session on the `auth.oxy.so` origin: `POST /auth/oauth/authorize` is
 * bearer-authenticated, so a visitor without one is bounced to sign in here
 * first — a second authentication step inside what is meant to be one
 * continuous action.
 *
 * This module is the additional lane that removes that step. It creates ONE
 * `AuthSession` with the OAuth request already bound to it
 * (`startCommonsSignIn({ clientId, oauth })`), waits for the identity to
 * approve it in Commons, and finalizes it into a single-use authorization CODE
 * (`finalizeCommonsOAuth`). The IdP never acquires a session of its own on this
 * path; it stays the shell that emits the code for the third party.
 *
 * SECURITY INVARIANTS — the reason this lives in a small, tested module rather
 * than inside the page component:
 *
 *  1. **The `sessionToken` never leaves this process.** It is the SECRET
 *     finalize credential, held in a private field and deliberately absent from
 *     {@link CommonsOAuthSnapshot} — so nothing renderable, encodable into a QR,
 *     or postable to an opener can ever carry it. Only the PUBLIC
 *     `authorizeCode` / `qrPayload` are exposed.
 *  2. **Finalization is attempted at most once, ever.** The server spends the
 *     request atomically, so a blind retry on an ambiguous failure burns it. The
 *     `finalizeStarted` latch is set BEFORE the call and never cleared for that
 *     request; recovery is a brand-new request (a new `sessionToken`), never a
 *     second finalize of the old one.
 *  3. **The minted code is only ever delivered to the redirect URI the request
 *     was bound to.** The server echoes back the URI it bound the code to, and a
 *     mismatch fails closed instead of delivering to a different target.
 *  4. **The outcome is emitted exactly once.** `settled` latches, so no race
 *     (a late poll, a cancel pressed during finalization) can deliver twice or
 *     deliver a code and an error.
 *
 * What this module deliberately does NOT do: acquire, plant, or relay any token.
 * `finalizeCommonsOAuth` returns an authorization CODE — the relying party still
 * performs the PKCE exchange with the verifier it never sent anywhere.
 */

import { selectCommonsDelivery } from "@oxy.so/core";
import type {
  CommonsDeliveryRoute,
  CommonsOAuthContext,
  CommonsOAuthFinalizeResult,
  CommonsSignInActionResult,
  CommonsSignInHandle,
  CommonsSignInStatus,
} from "@oxy.so/core";

/**
 * Fallback poll cadence for the request's approval state.
 *
 * The in-app SDK surfaces get an instant `auth_update` over the `/auth-session`
 * socket and poll slowly behind it. This page bundles no socket client, so the
 * poll IS the mechanism and runs at the cadence the device flow used before the
 * socket existed.
 */
export const COMMONS_OAUTH_POLL_INTERVAL_MS = 3000;

/**
 * How many CONSECUTIVE transport failures the poll tolerates before the lane
 * gives up. Bounded on purpose: a request that can never be observed must end in
 * a visible failure the user can act on, not an unbounded retry loop.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 4;

/**
 * RFC 7636 §4.2 `code_challenge` = BASE64URL(SHA-256(verifier)). The length
 * window mirrors the server's own `authSessionOAuthContextSchema` (43–128), so a
 * binding this module accepts is one `POST /auth/session/create` accepts.
 */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Upper bound the server places on the normalized scope string. */
const MAX_SCOPE_LENGTH = 512;

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

/** The already-validated authorize-request values this lane binds a request to. */
export interface CommonsOAuthBindingInput {
  /** `client_id` from the authorize URL. */
  clientId: string | null;
  /**
   * The redirect URI ALREADY normalized by `safeRedirectUrl`. This module never
   * sees, parses, or re-validates a raw `redirect_uri` — the page owns that
   * check, and the server independently re-matches the result against the
   * application's registered allowlist.
   */
  safeRedirectUri: string | null;
  /** `code_challenge` from the authorize URL. */
  codeChallenge: string | null;
  /** `code_challenge_method` from the authorize URL. */
  codeChallengeMethod: string | null;
  /** `scope` from the authorize URL. */
  scope: string | null;
}

/** A request binding this lane can actually create. */
export interface CommonsOAuthBinding {
  clientId: string;
  oauth: CommonsOAuthContext;
}

/** Collapse runs of whitespace, or `null` when there is no usable scope. */
function normalizeScope(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().split(/\s+/).filter(Boolean).join(" ");
  return normalized ? normalized : null;
}

/**
 * Build the OAuth binding for a Commons-approved authorization, or `null` when
 * this request cannot use the lane at all.
 *
 * Returning `null` is a NORMAL outcome, not an error: it simply means the caller
 * must keep using the session-bearing path (the visitor signs in on this origin
 * first). Every rejection is a fail-closed one:
 *
 *  - no `client_id` — the server resolves the application, and the redirect
 *    allowlist, from it; there is nothing to bind to without it;
 *  - no usable redirect URI — the page's `safeRedirectUrl` already rejected it;
 *  - no PKCE `code_challenge`, or one outside the accepted shape — PKCE is
 *    MANDATORY for an OAuth-bound request (there is no confidential-client path
 *    here), so a request without it can never finalize;
 *  - a `code_challenge_method` other than `S256` — `plain` is rejected outright,
 *    exactly as `POST /auth/oauth/authorize` rejects it;
 *  - a scope longer than the server accepts — refused here rather than silently
 *    truncated into a different grant than the one requested.
 */
export function buildCommonsOAuthBinding(
  input: CommonsOAuthBindingInput
): CommonsOAuthBinding | null {
  const clientId = input.clientId?.trim();
  if (!clientId) return null;

  const redirectUri = input.safeRedirectUri?.trim();
  if (!redirectUri) return null;

  const codeChallenge = input.codeChallenge?.trim();
  if (!codeChallenge || !CODE_CHALLENGE_PATTERN.test(codeChallenge)) return null;

  const method = input.codeChallengeMethod?.trim();
  if (method && method !== "S256") return null;

  const scope = normalizeScope(input.scope);
  if (scope && scope.length > MAX_SCOPE_LENGTH) return null;

  return {
    clientId,
    oauth: {
      redirectUri,
      codeChallenge,
      codeChallengeMethod: "S256",
      ...(scope ? { scope } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Lane state
// ---------------------------------------------------------------------------

/**
 * Resource state of the lane's single request.
 *
 * `confirmed` and `denied` are both terminal-and-delivered: the outcome has
 * already been handed to the page's delivery funnel. `failed` is terminal but
 * NOT delivered — the surface offers a fresh attempt instead.
 */
export type CommonsOAuthPhase =
  | "idle"
  | "starting"
  | "waiting"
  | "finalizing"
  | "confirmed"
  | "denied"
  | "failed";

/**
 * Non-sensitive progress of the active request — the one thing the surface
 * renders its status line from. Every step is DERIVED from a fact the lane
 * observed; nothing here advances on a timer or optimistically.
 */
export type CommonsOAuthProgress =
  | "preparing"
  | "awaiting-approval"
  | "opened-in-commons"
  | "confirming-identity"
  | "identity-confirmed";

/** Why the lane stopped. Mapped to copy by the surface, never rendered raw. */
export type CommonsOAuthFailure =
  /** The request could not be created (transport, or the server refused it). */
  | "start_failed"
  /** The request's own lifetime ran out before anyone approved it. */
  | "request_expired"
  /** The request's state could not be observed for several consecutive polls. */
  | "unreachable"
  /** Finalization failed. The request is spent — recovery is a NEW request. */
  | "finalize_failed"
  /** The server bound the code to a redirect URI other than the requested one. */
  | "redirect_mismatch";

/**
 * The facts the lane observes. Note what is ABSENT: the secret `sessionToken`,
 * and the authorization code itself — the code goes straight to the delivery
 * funnel via {@link CommonsOAuthOutcome} and is never parked in renderable state.
 */
export interface CommonsOAuthFacts {
  phase: CommonsOAuthPhase;
  /** PUBLIC single-use approval handle. Safe to show, deep-link, and encode. */
  authorizeCode: string | null;
  /** PUBLIC `oxycommons://approve?…` payload for the QR / deep link. */
  qrPayload: string | null;
  /** The ONE primary delivery route chosen for this request. */
  route: CommonsDeliveryRoute | null;
  /** Server-authoritative expiry (epoch ms). */
  expiresAt: number | null;
  /** Set once the approver opened the request in Commons (progress only). */
  openedInCommons: boolean;
  /** Non-null only while `phase === 'failed'`. */
  failure: CommonsOAuthFailure | null;
}

/** Everything the surface may render: the observed facts plus derived progress. */
export interface CommonsOAuthSnapshot extends CommonsOAuthFacts {
  /** Derived progress, or `null` when there is nothing honest to report. */
  progress: CommonsOAuthProgress | null;
}

/**
 * The lane's terminal, DELIVERABLE outcome — emitted exactly once.
 *
 * Failures are deliberately not outcomes: they stay on the snapshot so the
 * surface can offer a fresh attempt, rather than ending the relying party's
 * whole flow on a transport hiccup.
 */
export type CommonsOAuthOutcome =
  | { kind: "code"; code: string }
  | { kind: "denied" };

/** Cancellable handle for a scheduled poll. */
export interface CommonsOAuthTimer {
  cancel(): void;
}

/** Deferred execution, injected so tests drive the poll loop deterministically. */
export type CommonsOAuthScheduler = (
  run: () => void,
  delayMs: number
) => CommonsOAuthTimer;

const defaultScheduler: CommonsOAuthScheduler = (run, delayMs) => {
  const id = setTimeout(run, delayMs);
  return { cancel: () => clearTimeout(id) };
};

/**
 * The subset of the SDK this lane uses. Structural on purpose: the real
 * `oxyServices` satisfies it, and a test double needs nothing else.
 */
export interface CommonsOAuthClient {
  startCommonsSignIn(params: {
    clientId: string;
    oauth?: CommonsOAuthContext;
  }): Promise<CommonsSignInHandle>;
  pollCommonsSignIn(sessionToken: string): Promise<CommonsSignInStatus>;
  finalizeCommonsOAuth(sessionToken: string): Promise<CommonsOAuthFinalizeResult>;
  denyCommonsSignIn(authorizeCode: string): Promise<CommonsSignInActionResult>;
}

export interface CommonsOAuthRequestOptions {
  client: CommonsOAuthClient;
  clientId: string;
  oauth: CommonsOAuthContext;
  /** Called EXACTLY once, with the lane's terminal deliverable outcome. */
  onOutcome: (outcome: CommonsOAuthOutcome) => void;
  pollIntervalMs?: number;
  schedule?: CommonsOAuthScheduler;
  now?: () => number;
}

const IDLE_FACTS: CommonsOAuthFacts = {
  phase: "idle",
  authorizeCode: null,
  qrPayload: null,
  route: null,
  expiresAt: null,
  openedInCommons: false,
  failure: null,
};

/** Derive the reported progress from the lane's own observed facts. */
function deriveProgress(facts: CommonsOAuthFacts): CommonsOAuthProgress | null {
  switch (facts.phase) {
    case "idle":
    case "failed":
    case "denied":
      return null;
    case "starting":
      return "preparing";
    case "waiting":
      if (facts.openedInCommons) return "opened-in-commons";
      return facts.route === null ? "preparing" : "awaiting-approval";
    case "finalizing":
      return "confirming-identity";
    case "confirmed":
      return "identity-confirmed";
  }
}

/**
 * The OAuth-bound Commons request: a `subscribe` / `getSnapshot` store (the same
 * shape `useSyncExternalStore` wants) plus the three actions a surface needs.
 */
export class CommonsOAuthRequest {
  private readonly client: CommonsOAuthClient;
  private readonly clientId: string;
  private readonly oauth: CommonsOAuthContext;
  private readonly onOutcome: (outcome: CommonsOAuthOutcome) => void;
  private readonly pollIntervalMs: number;
  private readonly schedule: CommonsOAuthScheduler;
  private readonly now: () => number;

  private readonly listeners = new Set<() => void>();
  private facts: CommonsOAuthFacts = IDLE_FACTS;
  private snapshot: CommonsOAuthSnapshot = {
    ...IDLE_FACTS,
    progress: deriveProgress(IDLE_FACTS),
  };

  /**
   * The SECRET finalize credential. Private, never copied into the snapshot,
   * never passed to a renderer, never logged.
   */
  private sessionToken: string | null = null;

  /**
   * Bumped by every `start()` and by `dispose()`. Each asynchronous step
   * captures it and abandons itself if it no longer matches, so a superseded or
   * disposed attempt can never mutate state or emit an outcome.
   */
  private generation = 0;

  private timer: CommonsOAuthTimer | null = null;
  private consecutivePollFailures = 0;

  /**
   * Latched BEFORE the finalize call and never cleared for this request. The
   * server spends the request atomically, so a second attempt can only burn it.
   */
  private finalizeStarted = false;

  /** Latched by the one outcome emission, so nothing can deliver twice. */
  private settled = false;

  private disposed = false;

  constructor(options: CommonsOAuthRequestOptions) {
    this.client = options.client;
    this.clientId = options.clientId;
    this.oauth = options.oauth;
    this.onOutcome = options.onOutcome;
    this.pollIntervalMs = options.pollIntervalMs ?? COMMONS_OAUTH_POLL_INTERVAL_MS;
    this.schedule = options.schedule ?? defaultScheduler;
    this.now = options.now ?? Date.now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CommonsOAuthSnapshot => this.snapshot;

  /**
   * Ensure a live request exists.
   *
   * Idempotent: a no-op while a request is starting, waiting, finalizing, or
   * already delivered. From `idle` it creates the first request; from `failed`
   * it creates a BRAND-NEW one (new secret token, new approval) — which is what
   * "Try again" means here, and is the only recovery from a spent request.
   */
  start = (): void => {
    if (this.disposed || this.settled) return;
    if (this.facts.phase !== "idle" && this.facts.phase !== "failed") return;

    const generation = ++this.generation;
    this.clearTimer();
    this.sessionToken = null;
    this.consecutivePollFailures = 0;
    this.finalizeStarted = false;
    this.publish({ ...IDLE_FACTS, phase: "starting" });

    void this.createRequest(generation);
  };

  /**
   * The user backed out. Best-effort withdraws the pending request in Commons,
   * then reports the standard OAuth denial so the relying party learns the flow
   * ended rather than hanging.
   */
  cancel = (): void => {
    if (this.disposed || this.settled) return;
    const { authorizeCode } = this.facts;
    this.clearTimer();
    if (authorizeCode) {
      // Best effort: the user's intent is already known, so a failed withdrawal
      // must not hold up (or change) the denial we report. The request expires
      // on its own regardless.
      void this.client.denyCommonsSignIn(authorizeCode).catch(() => undefined);
    }
    this.emit({ kind: "denied" });
  };

  /**
   * Stop everything without reporting an outcome — the surface is going away.
   *
   * Terminal: an abandoned lane is never restarted, because the authorize page
   * mounts a fresh one per visit. The pending request is deliberately NOT
   * withdrawn either: the user may be mid-approval in Commons on their phone,
   * and tearing down a browser tab must not cancel that. An unfinished request
   * simply expires on its own.
   */
  dispose = (): void => {
    this.disposed = true;
    this.generation++;
    this.clearTimer();
  };

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private publish(next: CommonsOAuthFacts): void {
    this.facts = next;
    this.snapshot = { ...next, progress: deriveProgress(next) };
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<CommonsOAuthFacts>): void {
    this.publish({ ...this.facts, ...patch });
  }

  private fail(failure: CommonsOAuthFailure): void {
    this.clearTimer();
    this.patch({ phase: "failed", failure });
  }

  private emit(outcome: CommonsOAuthOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    this.patch({
      phase: outcome.kind === "code" ? "confirmed" : "denied",
      failure: null,
    });
    this.onOutcome(outcome);
  }

  private clearTimer(): void {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }

  /** Whether `generation` is still the attempt this lane is running. */
  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private async createRequest(generation: number): Promise<void> {
    let handle: CommonsSignInHandle;
    try {
      handle = await this.client.startCommonsSignIn({
        clientId: this.clientId,
        oauth: this.oauth,
      });
    } catch {
      // Every server-side refusal (unknown/suspended application, unregistered
      // redirect URI, disallowed origin) arrives here as one generic failure —
      // by design, so nothing about the application's state can be probed from
      // an unauthenticated page.
      if (this.isCurrent(generation)) this.fail("start_failed");
      return;
    }
    if (!this.isCurrent(generation)) return;

    this.sessionToken = handle.sessionToken;
    this.publish({
      phase: "waiting",
      authorizeCode: handle.authorizeCode,
      qrPayload: handle.qrPayload,
      // The ONE primary route, from the shared ecosystem decision rather than a
      // local branch. Both facts are known before the request exists and neither
      // can be anything else on this surface: a browser cannot verify that a
      // Commons app link resolves on this device (`commonsAvailable: false`),
      // and push delivery is bearer-required precisely so an unauthenticated
      // page can never ring somebody's phone — so it is not attempted at all,
      // not attempted-and-failed (`pushTargets: 0`).
      route: selectCommonsDelivery({
        platform: "unknown",
        commonsAvailable: false,
        pushTargets: 0,
      }),
      expiresAt: handle.expiresAt,
      openedInCommons: false,
      failure: null,
    });

    this.schedulePoll(generation);
  }

  private schedulePoll(generation: number): void {
    this.clearTimer();
    this.timer = this.schedule(() => {
      void this.poll(generation);
    }, this.pollIntervalMs);
  }

  private async poll(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const sessionToken = this.sessionToken;
    if (!sessionToken) return;

    const { expiresAt } = this.facts;
    if (expiresAt !== null && this.now() >= expiresAt) {
      this.fail("request_expired");
      return;
    }

    let status: CommonsSignInStatus;
    try {
      status = await this.client.pollCommonsSignIn(sessionToken);
    } catch {
      if (!this.isCurrent(generation)) return;
      this.consecutivePollFailures += 1;
      if (this.consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        this.fail("unreachable");
        return;
      }
      this.schedulePoll(generation);
      return;
    }
    if (!this.isCurrent(generation)) return;
    this.consecutivePollFailures = 0;

    if (status.authorized) {
      await this.finalize(generation, sessionToken);
      return;
    }
    if (status.status === "cancelled") {
      this.emit({ kind: "denied" });
      return;
    }
    if (status.status === "expired") {
      this.fail("request_expired");
      return;
    }

    if (status.openedAt !== null && !this.facts.openedInCommons) {
      this.patch({ openedInCommons: true });
    }
    this.schedulePoll(generation);
  }

  /**
   * Mint the authorization code. Called at most once per request — the latch is
   * set before the call and never cleared, so an ambiguous failure ends the lane
   * instead of burning a second (or nonexistent) finalization.
   */
  private async finalize(generation: number, sessionToken: string): Promise<void> {
    if (this.finalizeStarted) return;
    this.finalizeStarted = true;
    this.clearTimer();
    this.patch({ phase: "finalizing" });

    let result: CommonsOAuthFinalizeResult;
    try {
      result = await this.client.finalizeCommonsOAuth(sessionToken);
    } catch {
      // Fail closed. The request may or may not have been spent server-side and
      // there is no way to tell from here, so it is never retried: the user
      // starts a fresh request instead.
      if (this.isCurrent(generation)) this.fail("finalize_failed");
      return;
    }
    if (!this.isCurrent(generation)) {
      // The surface went away (or was restarted) while the code was in flight.
      // Dropping it is the fail-closed direction: an orphaned code expires
      // unused, whereas delivering it would target a flow nobody is waiting on.
      return;
    }

    if (result.redirectUri !== this.oauth.redirectUri) {
      // The code is bound server-side to the URI it was minted for. If that is
      // not the URI this request was created with, something is wrong with the
      // binding — never deliver to the other target.
      this.fail("redirect_mismatch");
      return;
    }

    this.emit({ kind: "code", code: result.code });
  }
}
