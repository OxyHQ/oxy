import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import type { SwitcherContextRow } from "@oxyhq/core";
import { getNormalizedUserHandle } from "@oxyhq/core";
import { useDeviceSwitcher, useOxy } from "@oxyhq/services";

import { Button } from "@oxyhq/bloom/button";
import {
  AuthFormHeader,
  AuthFormLayout,
  LoadingSpinner,
} from "@/components/auth-form-layout";
import { AccountChooser } from "@/components/account-chooser";
import { buildApiUrl, buildRelativeUrl } from "@/lib/oxy-api-client";
import { useTranslation } from "@/lib/i18n/use-translation";
import { mcpLinkIntentFromBody, type McpLinkIntent } from "@/lib/schemas";

/**
 * Connect another account to an existing MCP connection.
 *
 * An assistant connector is authorized once, for one account. This page is the
 * other half of the model Oxy owns: the person asks their assistant for a link,
 * opens it here, picks the account they want to add, and approves it AS that
 * account. Nothing about the connector's own authorization changes — the
 * joining account gets its own grant, listed and revocable under its own
 * settings.
 *
 * The intent secret is the credential and it is single-use, so this page never
 * approves anything on arrival: approval is always a gesture.
 */
export function McpLinkPage() {
  const [searchParams] = useSearchParams();
  const intent = searchParams.get("intent");
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

  const [request, setRequest] = useState<McpLinkIntent | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chooserDismissed, setChooserDismissed] = useState(false);
  const [pendingContextId, setPendingContextId] = useState<string | null>(null);
  // The description is loaded per active account (its `already_linked` answer is
  // account-specific), so a switch reloads it rather than reusing a stale one.
  const describedForAccount = useRef<string | null>(null);

  const hasUsableBearer =
    isAuthenticated ||
    activeContext !== null ||
    !!oxyServices.getAccessToken();

  const describe = useCallback(
    async (accountId: string | undefined) => {
      const accessToken = oxyServices.getAccessToken();
      if (!intent || !accessToken) return;
      describedForAccount.current = accountId ?? null;
      setLoading(true);
      try {
        const response = await fetch(
          buildApiUrl("/auth/mcp/oauth/connections/link/describe"),
          {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ intent }),
          }
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          setRequest(null);
          setError(
            typeof body?.error_description === "string"
              ? body.error_description
              : t("mcpLink.errors.loadFailed")
          );
          return;
        }
        const parsed = mcpLinkIntentFromBody(body);
        setRequest(parsed);
        setError(parsed ? null : t("mcpLink.errors.loadFailed"));
      } catch {
        setRequest(null);
        setError(t("mcpLink.errors.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [intent, oxyServices, t]
  );

  useEffect(() => {
    if (!intent) {
      setLoading(false);
      return;
    }
    if (directoryLoading || !hasUsableBearer) return;
    const accountId = activeContext?.subject.accountId;
    if (describedForAccount.current === (accountId ?? null)) return;
    void describe(accountId);
  }, [
    intent,
    directoryLoading,
    hasUsableBearer,
    activeContext,
    describe,
  ]);

  async function handleChooseContext(context: SwitcherContextRow): Promise<void> {
    setPendingContextId(context.contextId);
    setError(null);
    try {
      if (!context.isActive && !(await activateContext(context.contextId))) {
        setError(t("mcpLink.errors.switchFailed"));
        return;
      }
      setChooserDismissed(true);
    } finally {
      setPendingContextId(null);
    }
  }

  async function handleApprove(): Promise<void> {
    const accessToken = oxyServices.getAccessToken();
    if (!intent || !accessToken) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(
        buildApiUrl("/auth/mcp/oauth/connections/link/approve"),
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ intent }),
        }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(
          typeof body?.error_description === "string"
            ? body.error_description
            : t("mcpLink.errors.approveFailed")
        );
        return;
      }
      setLinked(true);
    } catch {
      setError(t("mcpLink.errors.approveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (!intent) {
    return (
      <AuthFormLayout>
        <AuthFormHeader
          title={t("mcpLink.noRequestTitle")}
          description={t("mcpLink.noRequestDesc")}
        />
      </AuthFormLayout>
    );
  }

  // No session on this device: sign in first, then come back to this exact
  // invitation. The account signed in as IS the account that will be added.
  if (isAuthResolved && !hasUsableBearer) {
    return (
      <Navigate
        to={buildRelativeUrl("/login", { mcp_link_intent: intent })}
        replace
      />
    );
  }

  const handle = user ? `@${getNormalizedUserHandle(user)}` : null;

  if (linked) {
    return (
      <AuthFormLayout>
        <AuthFormHeader
          title={t("mcpLink.connectedTitle")}
          description={t("mcpLink.connectedDesc", {
            handle: handle ?? t("mcpLink.thisAccount"),
            client: request?.clientName ?? t("mcpLink.theAssistant"),
          })}
        />
      </AuthFormLayout>
    );
  }

  if (loading || directoryLoading) return <LoadingSpinner />;

  // Additive front screen, same rule as the consent page: more than one context
  // on this device means the person chooses which account joins before they are
  // asked to approve anything.
  if (!chooserDismissed && activeContext !== null && contextCount > 1 && request) {
    return (
      <AccountChooser
        principals={principals}
        appName={request.clientName}
        onSelectContext={handleChooseContext}
        onUseAnother={() =>
          window.location.assign(
            buildRelativeUrl("/login", { mcp_link_intent: intent })
          )
        }
        pendingContextId={pendingContextId}
        isLoading={submitting || pendingContextId !== null}
      />
    );
  }

  return (
    <AuthFormLayout>
      {request ? (
        <div className="flex w-full flex-col gap-space-16">
          <AuthFormHeader
            title={t("mcpLink.title", { client: request.clientName })}
            description={t("mcpLink.subtitle", {
              handle: handle ?? t("mcpLink.thisAccount"),
              app: request.appSlug,
            })}
          />
          <div className="rounded-radius-12 border border-border p-space-12 font-bodySmall text-bodySmall text-muted-foreground">
            <p>{t("mcpLink.scopesTitle")}</p>
            <ul className="mt-space-8 list-disc ps-space-16">
              {request.scopes.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
            <p className="mt-space-12">{t("mcpLink.revokeHint")}</p>
          </div>
          {request.alreadyLinked && (
            <p className="font-bodySmall text-bodySmall text-muted-foreground">
              {t("mcpLink.alreadyLinked", { handle: handle ?? "" })}
            </p>
          )}
          {error && (
            <div className="rounded-radius-12 border border-destructive/50 bg-destructive/10 p-space-12 font-bodySmall text-bodySmall text-destructive">
              {error}
            </div>
          )}
          <div className="flex flex-col gap-space-8">
            <Button size="lg" onClick={() => void handleApprove()} disabled={submitting}>
              {t("mcpLink.approve")}
            </Button>
            <Button
              size="lg"
              variant="ghost"
              onClick={() =>
                window.location.assign(
                  buildRelativeUrl("/login", { mcp_link_intent: intent })
                )
              }
              disabled={submitting}
            >
              {t("mcpLink.useAnother")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <AuthFormHeader
            title={t("mcpLink.unavailableTitle")}
            description={t("mcpLink.unavailableDesc")}
          />
          {error && (
            <div className="rounded-radius-12 border border-destructive/50 bg-destructive/10 p-space-12 font-bodySmall text-bodySmall text-destructive">
              {error}
            </div>
          )}
        </>
      )}
    </AuthFormLayout>
  );
}

export default McpLinkPage;
