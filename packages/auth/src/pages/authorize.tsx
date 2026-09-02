import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, Link, useNavigate, Navigate } from "react-router-dom";
import type { PublicApplication, SwitcherContextRow } from "@oxyhq/core";
import { OxyConsentScreen, useDeviceSwitcher, useOxy } from "@oxyhq/services";

import { Button } from "@oxyhq/bloom/button";
import {
  AuthFormLayout,
  AuthFormHeader,
  LoadingSpinner,
  isChildWindow,
  tryCloseChildWindow,
} from "@/components/auth-form-layout";
import { AccountChooser } from "@/components/account-chooser";
import { CommonsOAuthLane } from "@/components/commons-oauth-request";
import { useTranslation } from "@/lib/i18n/use-translation";
import {
  sessionStatusSchema,
  safeParse,
  consentRequiredFromBody,
  mcpConsentRequiredFromBody,
} from "@/lib/schemas";
import {
  buildRelativeUrl,
  buildAuthUrl,
  buildApiUrl,
  getAvatarUrl,
} from "@/lib/oxy-api-client";
import { safeMcpRedirectUrl, safeRedirectUrl } from "@/lib/oauth-redirect";
import { deliverOAuthResult, type OAuthResult } from "@/lib/oauth-web-message";
import {
  buildCommonsOAuthBinding,
  type CommonsOAuthOutcome,
} from "@/lib/commons-oauth-request";

/**
 * The requesting-application + auth-request resolution state. The signed-in
 * USER, the access token, and the device session id come from the device-first
 * SDK (`useOxy().user` / `oxyServices.getAccessToken()` / `useDeviceSwitcher`)
 * — the IdP no longer resolves per-account bearers itself.
 */
type AuthorizeData = {
  sessionStatus: string | null;
  application: PublicApplication | null;
  expiresAt: string | null;
  error: string | null;
};

/**
 * Terminal state of a popup ("web message") delivery: the result has already
 * been posted to the opener and this window asked to close.
 */
type RelayOutcome = "approved" | "denied" | "failed";

/** Error shown when the requesting application cannot be resolved. */
const UNRESOLVED_APP_ERROR = "Unable to identify the requesting application.";

/** Which terminal message a delivered popup result should leave on screen. */
function relayOutcomeFor(result: OAuthResult): RelayOutcome {
  if (result.kind === "code") return "approved";
  return result.error === "access_denied" ? "denied" : "failed";
}

/**
 * Resolve a `client_id` to its public application identity via the unauthenticated
 * `GET /auth/oauth/client/:clientId` endpoint. Returns null when the client is
 * unknown (404) or the response is malformed — the caller renders the explicit
 * unresolved-application error rather than any generic fallback.
 */
async function resolvePublicApplication(
  clientId: string,
  resource: string | null,
  redirectUri: string | null
): Promise<PublicApplication | null> {
  try {
    const safeRedirect = resource !== null
      ? safeMcpRedirectUrl(redirectUri)
      : safeRedirectUrl(redirectUri);
    if (!safeRedirect) return null;
    const endpoint = resource !== null
      ? `/auth/mcp/oauth/client/${encodeURIComponent(clientId)}?${new URLSearchParams({
          resource,
          redirectUri: safeRedirect,
        }).toString()}`
      : `/auth/oauth/client/${encodeURIComponent(clientId)}`;
    const response = await fetch(
      buildApiUrl(endpoint),
      { credentials: "include" }
    );
    if (!response.ok) return null;
    const result = await response.json();
    const application = (result?.data ?? result)?.application;
    if (application && typeof application.id === "string") {
      return application as PublicApplication;
    }
    return null;
  } catch {
    return null;
  }
}

function parseRequestedScopes(
  scopeValue: string | null,
  fallbackScopes: string[] = []
): string[] {
  const rawScopes = scopeValue
    ? scopeValue.split(/\s+/).filter(Boolean)
    : fallbackScopes;
  return Array.from(new Set(rawScopes));
}

/**
 * Terminal surface for a refused `prompt=none` request. It is a plain statement
 * to whoever is looking at the window: nothing was authorized, and nothing is
 * pending. See {@link AuthorizePage} for why the request is refused at all.
 */
function SilentPromptRefused() {
  const { t } = useTranslation();
  return (
    <AuthFormLayout>
      <AuthFormHeader
        title={t("authorize.silentUnsupportedTitle")}
        description={t("authorize.silentUnsupportedDesc")}
      />
    </AuthFormLayout>
  );
}

/**
 * OIDC `prompt=none` (silent authentication) is NOT supported by this IdP, and a
 * request that asks for it is refused before any of the authorization machinery
 * runs.
 *
 * WHY IT IS ANSWERED AT ALL: every gesture-less lane was deleted, and
 * `@oxyhq/core`'s `buildOAuthAuthorizeUrl` narrowed its `prompt` union to
 * `'login' | 'consent'` so no first-party caller can construct such a request
 * any more. But `prompt` is read off the query string, so an arbitrary caller
 * can still send it. Ignoring it would be the accidental answer: a caller asking
 * for silence is waiting in a surface it never intends to show, so it would get
 * the visible consent screen rendered somewhere the user can neither see nor act
 * on — a request that hangs until the caller times out.
 *
 * WHY THE REFUSAL IS LOCAL, and nothing is reported back to the relying party:
 * bouncing the spec's `interaction_required` to `redirect_uri` would be the
 * OAuth-shaped answer, but on this path the target has only passed
 * `safeRedirectUrl`'s shape check — the exact match against the application's
 * registered `redirectUris` is enforced server-side by `POST /auth/oauth/authorize`,
 * which a refused request never reaches. Delivering there would make the page a
 * zero-interaction redirector from auth.oxy.so to any https target the URL's
 * author picks, i.e. exactly the gesture-less bounce this phase removed. So the
 * request stops here: no code minted, nothing posted to an opener, no navigation.
 *
 * WHY IT IS DECIDED HERE, above every other hook: the refused request performs no
 * work at all — no client lookup, no session read, no consent probe — so the
 * answer is the same constant regardless of what is signed in on this origin. A
 * third party learns nothing about this device from asking.
 */
export function AuthorizePage() {
  const [searchParams] = useSearchParams();
  if (searchParams.get("prompt") === "none") {
    return <SilentPromptRefused />;
  }
  return <AuthorizeRequest />;
}

function AuthorizeRequest() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const token = searchParams.get("token");
  const redirectUri = searchParams.get("redirect_uri");
  const state = searchParams.get("state");
  // OAuth2 authorization code flow parameters. When `client_id` is present
  // we exchange the user's consent for a single-use code (not a token) and
  // redirect with `?code=<code>&state=<state>` — never `?access_token=...`.
  // PKCE (code_challenge + S256) is REQUIRED for public clients. Servers MUST
  // strip these from logs / referrers since they are short-lived bearer-like
  // credentials.
  const clientId = searchParams.get("client_id");
  const codeChallenge = searchParams.get("code_challenge");
  const codeChallengeMethod = searchParams.get("code_challenge_method");
  const scope = searchParams.get("scope");
  const resource = searchParams.get("resource");
  const responseType = searchParams.get("response_type");
  const isMcpOAuth = resource !== null;
  const safeRequestRedirect = () => isMcpOAuth
    ? safeMcpRedirectUrl(redirectUri)
    : safeRedirectUrl(redirectUri);
  const statusParam = searchParams.get("status");
  const urlError = searchParams.get("error");
  // Popup sign-in: `response_mode=web_message` asks us to post the result to
  // `window.opener` instead of navigating this window to `redirect_uri`. It is a
  // request, not a guarantee — with no opener we still redirect (see
  // `lib/oauth-web-message.ts`).
  const responseMode = searchParams.get("response_mode");

  // Device-first SDK: the signed-in user + active bearer + the device directory.
  // The bearer for the OAuth authorize call is ALWAYS the SDK's active-context
  // token; activating another context re-plants it — there is no per-row bearer.
  const {
    user,
    oxyServices,
    isAuthResolved,
    isAuthenticated,
  } = useOxy();
  const {
    principals,
    activeContext,
    activateContext,
    isLoading: directoryLoading,
  } = useDeviceSwitcher();
  // How many `principal acting as account` pairs the device offers. The chooser
  // is worth showing from two upwards — and on a device holding two people who
  // both reach one organization that is FOUR rows, where the flat count was two.
  const contextCount = principals.reduce((total, p) => total + p.contexts.length, 0);

  const [data, setData] = useState<AuthorizeData>({
    sessionStatus: statusParam,
    application: null,
    expiresAt: null,
    error: urlError,
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // OAuth code path only: when the server says consent isn't required (trusted
  // app, or a stored grant already covers the requested scopes) we authorize
  // and redirect WITHOUT rendering the consent screen. While that POST + redirect
  // is in flight we show a neutral "Signing you in…" backdrop.
  const [autoApproving, setAutoApproving] = useState(false);

  // Google-style account chooser shown as an additive front screen before the
  // consent UI when MORE THAN ONE account is signed in on this device. Selecting
  // a row switches into it (the uniform device-first switch), re-planting the
  // active bearer, then reveals consent (or auto-approves). A single-account
  // device skips the chooser and goes straight to consent for the active account.
  const [chooserDismissed, setChooserDismissed] = useState(false);
  // The accountId currently being switched-to. Shown as a per-row busy state in
  // `<AccountChooser>` and disables sibling rows so the user can't fire a second
  // switch while one is in flight. Cleared on success (consent reveal) or on
  // failure (re-auth fallback).
  const [chooserPendingContextId, setChooserPendingContextId] = useState<
    string | null
  >(null);
  // The auto-approve probe runs at most once per mount for the active account.
  const autoApproveAttemptedRef = useRef(false);
  // Set once a result has been posted to the opener in popup mode. The window is
  // asked to close immediately after the post, so this only ever becomes visible
  // when the browser refuses that close — it keeps the user from staring at a
  // dead consent screen.
  const [relayOutcome, setRelayOutcome] = useState<RelayOutcome | null>(null);

  // A usable session for OAuth consent requires an active bearer — switchable
  // device rows alone are not enough (stale accounts after a failed mint).
  const hasUsableBearer =
    isAuthenticated ||
    activeContext !== null ||
    !!oxyServices.getAccessToken();

  // The additional no-session lane (issue #691). A request that carries a full
  // PKCE binding can be created with its OAuth context already attached, be
  // approved directly in Commons, and be finalized into an authorization code
  // HERE — so a visitor with no session on this origin never has to sign in on
  // it first. `null` means the lane does not apply to this request at all and
  // the session-bearing path below stays exactly as it was.
  const commonsBinding = useMemo(
    () =>
      isMcpOAuth
        ? null
        : buildCommonsOAuthBinding({
            clientId,
            safeRedirectUri: safeRequestRedirect(),
            codeChallenge,
            codeChallengeMethod,
            scope,
          }),
    [clientId, redirectUri, codeChallenge, codeChallengeMethod, scope, isMcpOAuth]
  );

  /**
   * Hand an authorization result (code or OAuth error) to the relying party.
   * Popup mode (`response_mode=web_message` + a real opener) posts it to the
   * opener at the redirect URI's exact origin and closes this window; every
   * other request redirects to `redirect_uri` as before. The caller must not
   * navigate afterwards — delivery is complete either way.
   */
  function deliverToRelyingParty(
    result: OAuthResult,
    safeRedirect: string
  ): void {
    const delivery = deliverOAuthResult({
      result,
      safeRedirectUri: safeRedirect,
      responseMode,
      window,
    });
    if (delivery.mode === "web_message") {
      setRelayOutcome(relayOutcomeFor(result));
    }
  }

  /**
   * The Commons lane settled. Both outcomes go through the SAME delivery funnel
   * the session-bearing path uses, so the popup relay and the redirect fallback
   * stay ONE decision (`lib/oauth-web-message.ts`) — the code is never handed
   * to the relying party by a second, parallel mechanism.
   *
   * A finalization FAILURE is deliberately not an outcome: the lane keeps it on
   * its own surface so the user can start a fresh request, rather than ending
   * the relying party's whole flow (and it is never retried against the spent
   * request).
   */
  function handleCommonsOutcome(outcome: CommonsOAuthOutcome): void {
    const safeRedirect = safeRequestRedirect();
    if (!safeRedirect) {
      // Unreachable in practice — the lane only exists once the binding built,
      // which already required a usable redirect target — but a result is never
      // delivered without one. Recording the error also retires the lane (its
      // branch below requires `!data.error`), so the visitor falls back to
      // signing in here rather than sitting on a surface that can never settle.
      setData((prev) => ({ ...prev, error: "Authorization failed" }));
      return;
    }
    if (outcome.kind === "code") {
      deliverToRelyingParty(
        { kind: "code", code: outcome.code, state },
        safeRedirect
      );
      return;
    }
    deliverToRelyingParty(
      { kind: "error", error: "access_denied", state },
      safeRedirect
    );
  }

  useEffect(() => {
    async function loadData() {
      try {
        // OAuth code flow: resolve the requesting application from its
        // `client_id`. This runs whenever a client_id is present (with or
        // without a device-flow token) and is the authoritative identity source
        // for the OAuth path.
        const oauthApplication = clientId
          ? await resolvePublicApplication(clientId, resource, redirectUri)
          : null;

        // If we have an auth session token, check its status
        if (!statusParam && token) {
          try {
            const statusResponse = await fetch(
              buildAuthUrl(`/session/status/${token}`),
              { credentials: "include" }
            );
            if (!statusResponse.ok) {
              setData((prev) => ({
                ...prev,
                error: "Unable to load authorization request.",
              }));
              return;
            }
            const statusResult = await statusResponse.json();
            // The Oxy API wraps the payload in `{ data: ... }`. Validate the
            // inner object against the real `/auth/session/status` contract. A
            // malformed body parses to null; we then fall through to the
            // unresolved-application path below (no crash, no invented app name).
            const sessionInfo = safeParse(
              sessionStatusSchema,
              statusResult.data ?? statusResult
            );

            // Device flow: the validated status response carries the resolved
            // public application directly. OAuth code flow: prefer the
            // client-resolved application — the OAuth path always takes
            // precedence. An unresolved request surfaces as an error, never a
            // generic app name.
            const deviceApplication: PublicApplication | null =
              sessionInfo?.application ?? null;
            const application = oauthApplication ?? deviceApplication;

            // A null parse (malformed status) is treated as an unresolved /
            // failed request: surface the resolved app if the OAuth path found
            // one, otherwise the explicit unresolved-application error.
            if (!sessionInfo) {
              setData({
                sessionStatus: null,
                application,
                expiresAt: null,
                error: application ? null : UNRESOLVED_APP_ERROR,
              });
              return;
            }

            if (sessionInfo.status !== "pending") {
              const err =
                sessionInfo.status === "expired"
                  ? "This authorization request has expired."
                  : sessionInfo.status === "cancelled"
                    ? "Authorization was cancelled."
                    : "This authorization request is no longer active.";
              setData({
                sessionStatus: sessionInfo.status,
                application,
                expiresAt: null,
                error: err,
              });
              return;
            }

            setData({
              sessionStatus: sessionInfo.status,
              application,
              expiresAt: sessionInfo.expiresAt ?? null,
              error: application ? null : UNRESOLVED_APP_ERROR,
            });
            return;
          } catch (err) {
            setData({
              sessionStatus: null,
              application: oauthApplication,
              expiresAt: null,
              error:
                err instanceof Error
                  ? err.message
                  : "Unable to load request.",
            });
            return;
          }
        }

        // OAuth code flow without a device-flow token (or with status already
        // resolved via the URL). The application MUST resolve from client_id.
        const invalidMcpRequest = isMcpOAuth && (
          responseType !== "code" ||
          !resource ||
          !scope ||
          !codeChallenge ||
          codeChallengeMethod !== "S256"
        );
        const resolvedError = urlError
          ? urlError
          : invalidMcpRequest
            ? "The MCP authorization request is missing a required secure binding."
          : clientId && !oauthApplication
            ? UNRESOLVED_APP_ERROR
            : null;

        setData({
          sessionStatus: statusParam,
          application: oauthApplication,
          expiresAt: null,
          error: resolvedError,
        });
      } catch {
        setData((prev) => ({ ...prev, error: "Unable to load request." }));
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [
    token,
    redirectUri,
    state,
    statusParam,
    urlError,
    clientId,
    resource,
    responseType,
    isMcpOAuth,
    scope,
    codeChallenge,
    codeChallengeMethod,
  ]);

  // Auto-close a child approval window when authorization is complete.
  useEffect(() => {
    const effectiveStatus = data.sessionStatus;
    if (
      (effectiveStatus === "approved" || effectiveStatus === "denied") &&
      isChildWindow()
    ) {
      // Small delay so any pending redirects / postMessages can fire
      const timer = setTimeout(() => tryCloseChildWindow(), 800);
      return () => clearTimeout(timer);
    }
  }, [data.sessionStatus]);

  // Re-routes to /login carrying the full authorization request context (plus
  // OAuth2 PKCE params) so the user lands back on this consent screen after
  // re-authenticating. `hint` pre-fills the username for a known account.
  function gotoLoginWithHint(hint?: string): void {
    navigate(
      buildRelativeUrl("/login", {
        token: token || undefined,
        redirect_uri: redirectUri || undefined,
        state: state || undefined,
        client_id: clientId || undefined,
        code_challenge: codeChallenge || undefined,
        code_challenge_method: codeChallengeMethod || undefined,
        scope: scope || undefined,
        resource: resource || undefined,
        response_type: responseType || undefined,
        response_mode: responseMode || undefined,
        login_hint: hint || undefined,
      })
    );
  }

  async function handleChooseContext(context: SwitcherContextRow): Promise<void> {
    setChooserPendingContextId(context.contextId);
    try {
      // Activating the pair re-plants the active bearer; with a token in hand
      // the OAuth path can skip the consent screen when consent isn't required.
      // The already-active pair needs no activation.
      //
      // A refusal resolves `false` rather than throwing — a context id is not
      // stable across a removal, so "this pair is gone" is an ordinary answer —
      // and lands on the same re-auth fallback as a thrown failure.
      if (!context.isActive && !(await activateContext(context.contextId))) {
        gotoLoginWithHint(context.handle ?? undefined);
        return;
      }
      setChooserDismissed(true);
      await maybeAutoApprove(oxyServices.getAccessToken(), context.accountId);
    } catch {
      gotoLoginWithHint(context.handle ?? undefined);
    } finally {
      setChooserPendingContextId(null);
    }
  }

  // Single-account device (or once the chooser is dismissed): probe consent for
  // the active account and auto-approve when it isn't required. Runs at most once
  // per mount. Multi-account devices go through the chooser first.
  useEffect(() => {
    if (
      directoryLoading ||
      autoApproveAttemptedRef.current ||
      data.error ||
      (data.sessionStatus && data.sessionStatus !== "pending") ||
      activeContext === null ||
      contextCount > 1
    ) {
      return;
    }
    autoApproveAttemptedRef.current = true;
    void maybeAutoApprove(oxyServices.getAccessToken(), activeContext.accountId);
  }, [
    contextCount,
    directoryLoading,
    activeContext,
    data.error,
    data.sessionStatus,
    oxyServices,
  ]);

  // Mint a single-use OAuth code and redirect to `redirect_uri` with
  // `?code=&state=`. Shared by the explicit "Allow" button (`handleDecision`)
  // and the trusted/already-granted auto-approval path so the fetch + redirect
  // logic exists exactly once. PKCE + `state` are passed through untouched.
  async function runOAuthAuthorize(
    accessToken: string,
    safeRedirect: string,
    effectiveAccountId: string | undefined
  ): Promise<void> {
    if (!clientId) return;

    const body: Record<string, string> = {
      clientId,
      redirectUri: safeRedirect,
    };
    if (codeChallenge) {
      body.codeChallenge = codeChallenge;
      body.codeChallengeMethod = codeChallengeMethod || "S256";
    }
    if (scope) body.scope = scope;
    if (state) body.state = state;
    if (isMcpOAuth) {
      if (!resource || !effectiveAccountId) {
        setAutoApproving(false);
        setSubmitting(false);
        setData((prev) => ({ ...prev, error: "The MCP account or resource binding is missing." }));
        return;
      }
      body.responseType = responseType || "code";
      body.resource = resource;
      body.accountId = effectiveAccountId;
    }

    const authorizePath = isMcpOAuth
      ? "/auth/mcp/oauth/authorize"
      : "/auth/oauth/authorize";
    const codeResponse = await fetch(buildApiUrl(authorizePath), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (codeResponse.status === 401) {
      navigate(
        buildRelativeUrl("/login", {
          token: token || undefined,
          redirect_uri: redirectUri || undefined,
          state: state || undefined,
          client_id: clientId || undefined,
          code_challenge: codeChallenge || undefined,
          code_challenge_method: codeChallengeMethod || undefined,
          scope: scope || undefined,
          resource: resource || undefined,
          response_type: responseType || undefined,
          response_mode: responseMode || undefined,
          error: "Session expired. Please sign in again.",
        })
      );
      return;
    }

    if (!codeResponse.ok) {
      const errPayload = await codeResponse.json().catch(() => ({}));
      const message =
        typeof errPayload?.message === "string"
          ? errPayload.message
          : "Authorization failed";
      // Surface the error and drop both in-flight flags so the page falls back
      // to the consent screen (auto-approve) or re-enables the button (manual).
      setAutoApproving(false);
      setSubmitting(false);
      setData((prev) => ({ ...prev, error: message }));
      return;
    }

    const codeResult = await codeResponse.json();
    const codeData = codeResult?.data ?? codeResult;
    const code: unknown = codeData?.code;
    if (typeof code !== "string" || code.length === 0) {
      // A 2xx without a code violates the authorize contract — fail closed
      // rather than handing the relying party an empty credential.
      setAutoApproving(false);
      setSubmitting(false);
      setData((prev) => ({ ...prev, error: "Authorization failed" }));
      return;
    }

    // Popup mode posts `{code, state}` to the opener and closes this window;
    // every other request redirects to `redirect_uri?code=&state=` as before.
    deliverToRelyingParty({ kind: "code", code, state }, safeRedirect);
  }

  // Ask the server whether the OAuth consent screen must be shown for this
  // (user, application, scope) tuple. A trusted app or a covering stored grant
  // returns `consentRequired: false` → we auto-approve and redirect, no
  // consent screen. SECURITY: any transport/parse failure fails safe to "show the
  // consent screen" (`consentRequiredFromBody`) — we never silently auto-approve
  // on an error. Only runs on the OAuth code path; the device-flow handoff
  // (no client_id) always shows the consent screen.
  async function maybeAutoApprove(
    accessToken: string | null,
    effectiveAccountId: string | undefined
  ): Promise<void> {
    const safeRedirect = safeRequestRedirect();
    if (!clientId || !safeRedirect || !accessToken) return;

    // Show the neutral backdrop for the whole decision so the consent screen never
    // flashes while the check is in flight. If consent turns out to be required
    // we drop the backdrop below and render the consent screen instead.
    setAutoApproving(true);

    let body: unknown = null;
    try {
      const params = new URLSearchParams();
      params.set("clientId", clientId);
      params.set("redirectUri", safeRedirect);
      if (scope) params.set("scope", scope);
      if (isMcpOAuth) {
        if (!resource || !effectiveAccountId) {
          setAutoApproving(false);
          return;
        }
        params.set("resource", resource);
        params.set("accountId", effectiveAccountId);
      }
      const consentPath = isMcpOAuth
        ? "/auth/mcp/oauth/consent"
        : "/auth/oauth/consent";
      const response = await fetch(
        buildApiUrl(`${consentPath}?${params.toString()}`),
        {
          credentials: "include",
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (!response.ok) {
        // Misconfigured redirect_uri (common prod drift) returns 403 before the
        // trusted-app auto-approve branch runs. Fail closed with a visible error
        // instead of falling through to the consent screen — official apps should
        // never prompt here.
        if (response.status === 403 || response.status === 400) {
          const errPayload = await response.json().catch(() => ({}));
          const message =
            typeof errPayload?.message === "string"
              ? errPayload.message
              : "Authorization failed. Return to the app and try again.";
          setAutoApproving(false);
          setData((prev) => ({ ...prev, error: message }));
          return;
        }
        body = null;
      } else {
        body = await response.json().catch(() => null);
      }
    } catch {
      body = null;
    }

    const consentRequired = isMcpOAuth
      ? mcpConsentRequiredFromBody(body)
      : consentRequiredFromBody(body);
    if (consentRequired) {
      setAutoApproving(false);
      return;
    }

    await runOAuthAuthorize(accessToken, safeRedirect, effectiveAccountId);
  }

  async function handleDecision(decision: "approve" | "deny") {
    if (!token && !clientId) return;
    setSubmitting(true);

    const safeRedirect = safeRequestRedirect();

    if (decision === "deny") {
      // Cancel the auth session
      if (token) {
        try {
          await fetch(buildAuthUrl(`/session/cancel/${token}`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({}),
          });
        } catch {
          // Ignore cancellation errors
        }
      }
      if (safeRedirect) {
        // Same delivery contract as the approve path: popup mode posts
        // `access_denied` to the opener and closes; otherwise we redirect to
        // `redirect_uri?error=access_denied`.
        deliverToRelyingParty(
          { kind: "error", error: "access_denied", state },
          safeRedirect
        );
      } else {
        navigate(
          buildRelativeUrl("/authorize", {
            token: token || undefined,
            status: "denied",
          })
        );
      }
      setSubmitting(false);
      return;
    }

    // Approve. Two distinct redirect paths:
    //   - OAuth2 authorization code flow (when `client_id` is in the URL):
    //     mint a short-lived code and redirect with `?code=<code>&state=...`.
    //   - Device-flow handoff (no `client_id`): authorize the
    //     pending AuthSession via the Bearer-auth endpoint and notify the
    //     polling client via socket.io. No tokens ever appear in the URL.
    try {
      // The bearer is ALWAYS the SDK's active-account token (planted at sign-in /
      // account switch) — never a per-row bearer.
      const accessToken = oxyServices.getAccessToken();

      if (!accessToken) {
        setData((prev) => ({
          ...prev,
          error: "Sign in required to authorize this request.",
        }));
        setSubmitting(false);
        return;
      }

      // ---- OAuth2 authorization code flow ----
      if (clientId && safeRedirect) {
        await runOAuthAuthorize(accessToken, safeRedirect, activeContext?.accountId);
        return;
      }

      // ---- Device-flow handoff (token + AuthSession) ----
      if (!token) {
        setData((prev) => ({
          ...prev,
          error: "Missing authorization request token.",
        }));
        setSubmitting(false);
        return;
      }

      const authorizeResponse = await fetch(
        buildAuthUrl(`/session/authorize/${token}`),
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({}),
        }
      );

      if (authorizeResponse.status === 401) {
        navigate(
          buildRelativeUrl("/login", {
            token: token || undefined,
            redirect_uri: redirectUri || undefined,
            state: state || undefined,
            client_id: clientId || undefined,
            code_challenge: codeChallenge || undefined,
            code_challenge_method: codeChallengeMethod || undefined,
            scope: scope || undefined,
            resource: resource || undefined,
            response_type: responseType || undefined,
            response_mode: responseMode || undefined,
            error: "Session expired. Please sign in again.",
          })
        );
        return;
      }

      if (!authorizeResponse.ok) {
        const errPayload = await authorizeResponse.json().catch(() => ({}));
        const message =
          typeof errPayload?.message === "string"
            ? errPayload.message
            : "Authorization failed";
        setData((prev) => ({ ...prev, error: message }));
        setSubmitting(false);
        return;
      }

      // The cross-app handoff completes server-side via socket emission to
      // the polling client; no tokens are returned to the auth UI and none
      // appear in the URL. We just confirm completion to the user.
      navigate(
        buildRelativeUrl("/authorize", {
          token: token || undefined,
          status: "approved",
        })
      );
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Authorization failed";
      setData((prev) => ({ ...prev, error: msg }));
      setSubmitting(false);
    }
  }

  // Popup delivery is terminal: the result is already posted to the opener and
  // this window asked to close. Rendering this state at all means the browser
  // refused the close, so tell the user they can close it themselves rather than
  // leaving a dead consent screen (or a spinner) on screen.
  if (relayOutcome) {
    return (
      <AuthFormLayout>
        <AuthFormHeader
          title={
            relayOutcome === "approved"
              ? t("authorize.completeTitle")
              : relayOutcome === "denied"
                ? t("authorize.deniedTitle")
                : t("authorize.relayFailedTitle")
          }
          description={t("authorize.completeDesc")}
        />
      </AuthFormLayout>
    );
  }

  if (loading || directoryLoading) {
    return <LoadingSpinner />;
  }

  // Trusted / already-granted OAuth request: authorizing + redirecting without
  // ever showing the consent screen. Neutral backdrop while that completes.
  if (autoApproving) {
    return (
      <AuthFormLayout>
        <AuthFormHeader title={t("authorize.signingIn")} />
        <LoadingSpinner />
      </AuthFormLayout>
    );
  }

  if (!token && !clientId) {
    return (
      <AuthFormLayout>
        <AuthFormHeader
          title={t("authorize.noRequestTitle")}
          description={t("authorize.noRequestDesc")}
        />
        <Button asChild size="lg">
          <Link to="/login">{t("authorize.goToSignIn")}</Link>
        </Button>
      </AuthFormLayout>
    );
  }

  // No session on this device (cold boot has resolved and found none).
  if (isAuthResolved && !hasUsableBearer) {
    // FIRST the additional lane (issue #691): when the request carries a full
    // PKCE binding, its application resolved cleanly, and the request is still
    // actionable, the authorization can be approved directly in Commons and
    // finalized into a code right here — one continuous action, with no sign-in
    // step on this origin. A request that fails ANY of those (no PKCE, an
    // unknown or suspended application, an expired/cancelled request) falls
    // through to the unchanged redirect below rather than creating a request
    // the server would refuse.
    if (
      commonsBinding &&
      !data.error &&
      data.application &&
      (!data.sessionStatus || data.sessionStatus === "pending")
    ) {
      return (
        <CommonsOAuthLane
          binding={commonsBinding}
          client={oxyServices}
          appName={data.application.name}
          onOutcome={handleCommonsOutcome}
          onSignInHere={() => gotoLoginWithHint()}
        />
      );
    }

    // Everything else redirects to /login carrying the full request context, so
    // the user lands back on this consent screen after authenticating here.
    return (
      <Navigate
        to={buildRelativeUrl("/login", {
          token: token || undefined,
          redirect_uri: redirectUri || undefined,
          state: state || undefined,
          client_id: clientId || undefined,
          code_challenge: codeChallenge || undefined,
          code_challenge_method: codeChallengeMethod || undefined,
          scope: scope || undefined,
          resource: resource || undefined,
          response_type: responseType || undefined,
          response_mode: responseMode || undefined,
        })}
        replace
      />
    );
  }

  const effectiveStatus = data.sessionStatus;
  const pageError = data.error;
  const application = data.application;
  // Actionable = the request itself is still live (pending). A transient
  // submit error (e.g. a 403/500 from the authorize POST) keeps the consent
  // surface — with the application identity — visible, shown inline via the
  // consent screen's `error` prop so the user can retry. Terminal states
  // (expired/cancelled) fall through to the page status view instead.
  const showActions = !effectiveStatus || effectiveStatus === "pending";

  // Additive front screen: when the consent request is still actionable and MORE
  // THAN ONE account is signed in on this device, show the Google-style chooser
  // first. Selecting an account switches into it and reveals the consent UI. A
  // single-account device skips straight to consent for the active account. The
  // chooser never intercepts a completed (approved/denied) state.
  if (
    showActions &&
    !chooserDismissed &&
    activeContext !== null &&
    contextCount > 1
  ) {
    return (
      <AccountChooser
        principals={principals}
        appName={application?.name}
        onSelectContext={handleChooseContext}
        onUseAnother={() => gotoLoginWithHint()}
        pendingContextId={chooserPendingContextId}
        isLoading={submitting || chooserPendingContextId !== null}
      />
    );
  }

  return (
    <AuthFormLayout>
      {/* Status messages for completed flows */}
      {effectiveStatus === "approved" ||
      effectiveStatus === "denied" ? (
        <>
          <AuthFormHeader
            title={
              effectiveStatus === "approved"
                ? t("authorize.completeTitle")
                : t("authorize.deniedTitle")
            }
            description={
              isChildWindow()
                ? t("authorize.completeChild")
                : effectiveStatus === "approved"
                  ? t("authorize.completeDesc")
                  : t("authorize.deniedDesc")
            }
          />
        </>
      ) : application && showActions ? (
        /* Resolved requesting-application identity AND an actionable request →
           the shared services `OxyConsentScreen` (the RN/Bloom consent surface,
           bundled for web via react-native-web). It is purely presentational;
           every decision is delegated back to the unchanged IdP `handleDecision`
           flow. The block wrapper keeps the RN `ScrollView` (flex:1) at content
           height inside the centered auth card instead of collapsing to zero.

           Gated on `showActions` so a non-actionable request (expired /
           cancelled, or a transient decision error) never renders a consent
           surface with dead Allow/Deny buttons — those fall through to the
           page's status view below. `showActions` already implies `!pageError`,
           so the consent surface is only ever shown error-free (no `error` prop
           needed). */
        <div className="w-full">
          <OxyConsentScreen
            application={{
              name: application.name,
              iconUrl: application.icon ? getAvatarUrl(application.icon) : undefined,
              websiteUrl: application.websiteUrl,
              privacyPolicyUrl: application.privacyPolicyUrl,
              termsUrl: application.termsUrl,
              developerName: application.developerName,
              isOfficial: application.isOfficial,
            }}
            scopes={parseRequestedScopes(scope, application.scopes)}
            user={
              user
                ? {
                    displayName: user.name?.displayName,
                    handle: user.username,
                    avatarUri: user.avatar
                      ? getAvatarUrl(user.avatar)
                      : undefined,
                  }
                : undefined
            }
            onAllow={() => handleDecision("approve")}
            onDeny={() => handleDecision("deny")}
            busy={submitting}
            error={pageError}
          />
        </div>
      ) : (
        /* Either no resolved application, or a resolved application whose request
           is no longer actionable (expired / cancelled / errored). Render the
           page's status view — message + error — never a consent surface. */
        <>
          <AuthFormHeader
            title={t("authorize.requestTitle")}
            description={t("authorize.requestUnavailable")}
          />
          {pageError && (
            <div className="rounded-radius-12 border border-destructive/50 bg-destructive/10 p-space-12 font-bodySmall text-bodySmall text-destructive">
              {pageError}
            </div>
          )}
        </>
      )}
    </AuthFormLayout>
  );
}
