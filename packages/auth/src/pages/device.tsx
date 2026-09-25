import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import type { CommonsApprovalInfo, SwitcherContextRow } from "@oxy.so/core";
import { getCommonsApprovalBlockingReason } from "@oxy.so/core";
import { OxyAccountPicker, OxyAuthLoading, OxyAuthScreen, OxyAuthScreenHeader, OxyConsentScreen, useDeviceSwitcher, useOxy } from "@oxy.so/services";

import { buildAuthUrl, buildRelativeUrl, getAvatarUrl } from "@/lib/oxy-api-client";
import { useTranslation } from "@/lib/i18n/use-translation";

/**
 * The shape `POST /auth/session/create` mints: 16 random bytes, hex. Checked
 * before any request so a mangled or hostile value never reaches the API.
 */
const DEVICE_CODE_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The query parameter carrying that code — deliberately NOT `code`.
 *
 * `OxyProvider`'s cold boot reads any `?code=` on page load as the return leg of
 * an OAuth redirect (`tryCompleteOAuthReturn` in `@oxy.so/services`), tries to
 * exchange it, and strips it from the address bar with `replaceState` +
 * `popstate` — so a `/device?code=…` link arrives here with the code already
 * gone. Measured in a real browser against a production build; a mocked
 * provider cannot show it. `user_code` is the name RFC 8628 gives the code a
 * device displays for a person to approve, which is exactly what this is — the
 * name only, not a claim that this is that grant.
 */
const CODE_PARAM = "user_code";

/**
 * Approve a device sign-in in a normal browser tab.
 *
 * A client with no browser of its own — `codea login` in a terminal, over SSH,
 * inside a container — starts a Commons device sign-in and shows the person a
 * PUBLIC approval code. Until this page existed the only thing that could
 * approve that code was the native Commons app: the other web page that calls
 * `POST /auth/session/authorize-code/:code` (`id.oxy.so/continue`) is a popup
 * that refuses to render without `window.opener`. It relays nothing to that
 * opener — the approval lands server-side and the initiator finishes by
 * polling — so a tab opened from a link works just as well, and this is that
 * tab.
 *
 * It renders the same `OxyConsentScreen` an MCP connector or an app sign-in
 * shows on `/authorize`, so the person sees one consent surface everywhere.
 * `/authorize` itself is not reused: it is parameterised by `client_id` +
 * `redirect_uri` + PKCE and creates its own request, where this adopts one a
 * device already created. The secret `sessionToken` never comes near this page
 * — it stays with the device, which is the only party that can claim the
 * session once it is approved.
 *
 * SECURITY — the identity window's rule, not relaxed. A code is a
 * bearer-free handle anyone can mint for their own request, so a signed-in
 * victim who opens an attacker's link must not be able to approve it by
 * reflex (login-CSRF / session fixation). Approval is therefore always a
 * gesture behind a MANDATORY, un-defaulted acknowledgement, whatever
 * `originVerified` says: that flag is derived from an `Origin` header a
 * non-browser caller can forge, and a CLI sends none, so it only chooses the
 * warning's wording. The page also prints the code itself, so the person can
 * check it against the one their own device shows — the one thing a forged
 * link cannot match.
 */
export function DevicePage() {
  const [searchParams] = useSearchParams();
  const rawCode = searchParams.get(CODE_PARAM);
  const code = rawCode && DEVICE_CODE_PATTERN.test(rawCode) ? rawCode : null;
  const { t } = useTranslation();

  const { user, oxyServices, isAuthResolved, isAuthenticated } = useOxy();
  const {
    principals,
    activeContext,
    activateContext,
    isLoading: directoryLoading,
  } = useDeviceSwitcher();
  const contextCount = principals.reduce(
    (total, principal) => total + principal.contexts.length,
    0
  );

  const [approval, setApproval] = useState<CommonsApprovalInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
  const [chooserDismissed, setChooserDismissed] = useState(false);
  const [pendingContextId, setPendingContextId] = useState<string | null>(null);
  const completingRef = useRef(false);

  const hasUsableBearer =
    isAuthenticated ||
    activeContext !== null ||
    !!oxyServices.getAccessToken();

  // `approve-info` is public, so an expired or already-used code is reported
  // before anyone is sent through sign-in for nothing.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void oxyServices
      .getCommonsApprovalInfo(code)
      .then((info: CommonsApprovalInfo) => {
        if (cancelled) return;
        const blockingReason = getCommonsApprovalBlockingReason(info);
        if (blockingReason) {
          setLoadError(blockingReason);
          return;
        }
        setApproval(info);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t("device.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [code, oxyServices, t]);

  const loginUrl = code ? buildRelativeUrl("/login", { user_code: code }) : "/login";

  async function handleChooseContext(context: SwitcherContextRow): Promise<void> {
    setPendingContextId(context.contextId);
    setError(null);
    try {
      if (!context.isActive && !(await activateContext(context.contextId))) {
        setError(t("device.errors.switchFailed"));
        return;
      }
      // The acknowledgement was given AS an account; a different account has
      // to give its own.
      setAcknowledged(false);
      setChooserDismissed(true);
    } finally {
      setPendingContextId(null);
    }
  }

  // The ONLY path that calls the authorize-code endpoint: an explicit press,
  // after the acknowledgement, at most once at a time.
  const handleAllow = useCallback(async () => {
    if (!code || !acknowledged || completingRef.current) return;
    const accessToken = oxyServices.getAccessToken();
    if (!accessToken) {
      setError(t("device.errors.noToken"));
      return;
    }
    completingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        buildAuthUrl(`/session/authorize-code/${encodeURIComponent(code)}`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: "{}",
        }
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          typeof payload?.message === "string"
            ? payload.message
            : t("device.errors.approveFailed")
        );
      }
      setOutcome("approved");
    } catch (caught) {
      completingRef.current = false;
      setError(
        caught instanceof Error ? caught.message : t("device.errors.approveFailed")
      );
    } finally {
      setSubmitting(false);
    }
  }, [acknowledged, code, oxyServices, t]);

  const handleDeny = useCallback(() => {
    if (code) {
      void oxyServices.denyCommonsSignIn(code).catch(() => undefined);
    }
    setOutcome("denied");
  }, [code, oxyServices]);

  if (!code) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader
          title={t("device.noRequestTitle")}
          description={t("device.noRequestDesc")}
        />
      </OxyAuthScreen>
    );
  }

  const appName = approval?.application?.name ?? "";

  if (outcome === "approved") {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader
          title={t("device.approvedTitle")}
          description={t("device.approvedDesc", { app: appName })}
        />
      </OxyAuthScreen>
    );
  }

  if (outcome === "denied") {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader
          title={t("device.deniedTitle")}
          description={t("device.deniedDesc")}
        />
      </OxyAuthScreen>
    );
  }

  if (loadError) {
    return (
      <OxyAuthScreen>
        <OxyAuthScreenHeader title={t("device.unavailableTitle")} description={loadError} />
      </OxyAuthScreen>
    );
  }

  if (!approval?.application || !isAuthResolved) {
    return <OxyAuthLoading />;
  }

  // No session on this device: sign in first, then come back to this exact
  // request. The account signed in as IS the account that will be approved.
  if (!hasUsableBearer) {
    return <Navigate to={loginUrl} replace />;
  }

  if (directoryLoading) return <OxyAuthLoading />;

  // Same rule as `/authorize` and `/mcp/link`: with more than one account on
  // this device, the person picks which one signs in before approving anything.
  if (!chooserDismissed && activeContext !== null && contextCount > 1) {
    return (
      <OxyAccountPicker
        principals={principals}
        appName={appName}
        onSelectContext={handleChooseContext}
        onUseAnother={() => window.location.assign(loginUrl)}
        pendingContextId={pendingContextId}
        isLoading={submitting || pendingContextId !== null}
      />
    );
  }

  const application = approval.application;

  return (
    <OxyAuthScreen>
      <div className="flex w-full flex-col gap-space-12 rounded-radius-12 border border-border p-space-12 font-bodySmall text-bodySmall">
        <p className="text-muted-foreground">{t("device.codeHint")}</p>
        <code data-testid="device-code" className="break-all font-mono text-foreground">
          {code}
        </code>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            disabled={submitting}
          />
          <span>
            {approval.originVerified
              ? t("device.ackVerified", { app: application.name })
              : t("device.ackUnverified", { app: application.name })}
          </span>
        </label>
      </div>
      {/* Wrapper keeps the RN `ScrollView` (flex:1) at content height inside
          the centered auth card, exactly as on `/authorize`. */}
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
          scopes={approval.scopes}
          user={
            user
              ? {
                  displayName: user.name?.displayName,
                  handle: user.username,
                  avatarUri: user.avatar ? getAvatarUrl(user.avatar) : undefined,
                }
              : undefined
          }
          onAllow={handleAllow}
          onDeny={handleDeny}
          busy={submitting}
          allowDisabled={!acknowledged}
          error={error}
        />
      </div>
    </OxyAuthScreen>
  );
}

export default DevicePage;
