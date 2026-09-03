/**
 * Explicit OAuth consent for an already-authenticated Oxy user.
 *
 * This is deliberately separate from sign-in routing. First-party applications
 * normally use the account dialog, but a consent-required scope (for example
 * `acting-as:offline`) still has to go through the OAuth authorize surface. The
 * caller must invoke this operation from a real user gesture; it never runs on
 * mount, retries silently, or grants anything locally.
 */

import type { OxyServices, PublicApplication } from "@oxyhq/core";
import { openAuthorizeUrlNative } from "../components/oauthNavigation";
import { startWebOAuthSignIn } from "./browserAuthTransport";
import { completeOAuthCode } from "./completeOAuthCode";
import { prepareAuthorizeRequest } from "./oauthHandshake";
import { closeOAuthPopup, openOAuthPopup } from "./oauthPopup";
import type {
	OAuthPopupHandle,
	OAuthSessionCommitInput,
	WebAuthMode,
	WebOAuthFailureReason,
	WebOAuthRedirectReason,
} from "./types";

export interface RequestOAuthConsentOptions {
	/** Exact, registered redirect URI. It is never inferred or normalized. */
	redirectUri: string;
	/** Exact application scopes to present to the user, in caller-supplied order. */
	scopes: readonly string[];
	/** Optional timeout for the web popup lane. */
	timeoutMs?: number;
}

export type OAuthConsentFailureReason =
	| WebOAuthFailureReason
	| "invalid-redirect-uri"
	| "invalid-scopes"
	| "scope-not-configured"
	| "client-resolution-failed"
	| "native-callback-invalid"
	| "state-mismatch"
	| "exchange-failed"
	| "subject-mismatch";

export type OAuthConsentUnsupportedReason =
	| "missing-client-id"
	| "identity-bound"
	| "not-authenticated"
	| "unsupported-platform";

export type OAuthConsentResult =
	| { status: "consented" }
	| { status: "redirecting"; via: WebOAuthRedirectReason }
	| { status: "cancelled" }
	| { status: "timed-out" }
	| {
			status: "failed";
			reason: OAuthConsentFailureReason;
			description?: string;
	  }
	| { status: "unsupported"; reason: OAuthConsentUnsupportedReason };

export interface OAuthConsentContext {
	platform: "web" | "native" | "unsupported";
	mode: WebAuthMode;
	oxyServices: OxyServices;
	clientId: string | null;
	authorizeBaseUrl?: string;
	identityBound: boolean;
	/** User who triggered the consent request; a different returned subject is rejected. */
	expectedUserId: string | null;
	commitSession: (input: OAuthSessionCommitInput) => Promise<void>;
}

const EXACT_SCOPE = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)+$/;

function hasExactRedirectUri(value: string): boolean {
	if (!value || value !== value.trim() || /\s/.test(value)) return false;
	try {
		const parsed = new URL(value);
		return (
			Boolean(parsed.protocol) &&
			!parsed.username &&
			!parsed.password &&
			!parsed.hash
		);
	} catch {
		return false;
	}
}

function hasExactScopes(scopes: readonly string[]): boolean {
	if (scopes.length === 0 || new Set(scopes).size !== scopes.length)
		return false;
	return scopes.every(
		(scope) => scope === scope.trim() && EXACT_SCOPE.test(scope),
	);
}

function parseNativeCallback(
	redirectUrl: string,
	expectedRedirectUri: string,
):
	| { kind: "code"; code: string; state: string }
	| { kind: "error"; description?: string }
	| { kind: "invalid" } {
	const separator = expectedRedirectUri.includes("?") ? "&" : "?";
	if (!redirectUrl.startsWith(`${expectedRedirectUri}${separator}`)) {
		return { kind: "invalid" };
	}

	const response = redirectUrl.slice(expectedRedirectUri.length + 1);
	const params = new URLSearchParams(response);
	if (params.getAll("code").length > 1 || params.getAll("state").length > 1) {
		return { kind: "invalid" };
	}
	const error = params.get("error");
	if (error) {
		const description = params.get("error_description");
		return description ? { kind: "error", description } : { kind: "error" };
	}
	const code = params.get("code");
	const state = params.get("state");
	if (!code || !state) return { kind: "invalid" };
	return { kind: "code", code, state };
}

/**
 * Ask the current user to grant exact application scopes through Oxy OAuth.
 *
 * Scope syntax is checked before any window opens. After that, the exact client
 * id resolves its public Application and every requested scope must be present
 * in that application's configured scope list. Unknown, trimmed, duplicated or
 * reordered-by-the-SDK values are never sent to the IdP.
 */
export async function requestOAuthConsent(
	context: OAuthConsentContext,
	options: RequestOAuthConsentOptions,
): Promise<OAuthConsentResult> {
	if (!hasExactRedirectUri(options.redirectUri)) {
		return { status: "failed", reason: "invalid-redirect-uri" };
	}
	if (!hasExactScopes(options.scopes)) {
		return { status: "failed", reason: "invalid-scopes" };
	}
	if (!context.clientId) {
		return { status: "unsupported", reason: "missing-client-id" };
	}
	if (context.identityBound) {
		return { status: "unsupported", reason: "identity-bound" };
	}
	if (!context.expectedUserId) {
		return { status: "unsupported", reason: "not-authenticated" };
	}
	if (context.platform === "unsupported") {
		return { status: "unsupported", reason: "unsupported-platform" };
	}

	// Claim a popup before the first await. This function is only safe when the
	// caller invokes it directly from the user's confirmation gesture.
	const popup: OAuthPopupHandle | null =
		context.platform === "web" && context.mode === "popup"
			? openOAuthPopup()
			: null;

	let application: PublicApplication;
	try {
		application = await context.oxyServices.getPublicApplication(
			context.clientId,
		);
	} catch {
		closeOAuthPopup(popup);
		return { status: "failed", reason: "client-resolution-failed" };
	}

	const configuredScopes = new Set(application.scopes);
	if (options.scopes.some((scope) => !configuredScopes.has(scope))) {
		closeOAuthPopup(popup);
		return { status: "failed", reason: "scope-not-configured" };
	}

	const scope = options.scopes.join(" ");
	let subjectMismatch = false;
	const commitExactSubject = async (
		input: OAuthSessionCommitInput,
	): Promise<void> => {
		if (input.userId !== context.expectedUserId) {
			subjectMismatch = true;
			throw new Error("OAuth consent returned a different user");
		}
		await context.commitSession(input);
	};

	if (context.platform === "web") {
		const result = await startWebOAuthSignIn(
			{
				mode: context.mode,
				oxyServices: context.oxyServices,
				clientId: context.clientId,
				authorizeBaseUrl: context.authorizeBaseUrl,
				identityBound: false,
				commitSession: commitExactSubject,
			},
			{
				redirectUri: options.redirectUri,
				scope,
				...(context.mode === "popup" ? { popup } : {}),
				...(options.timeoutMs !== undefined
					? { timeoutMs: options.timeoutMs }
					: {}),
			},
		);
		if (subjectMismatch)
			return { status: "failed", reason: "subject-mismatch" };
		switch (result.status) {
			case "signed-in":
				return { status: "consented" };
			case "redirecting":
			case "cancelled":
			case "timed-out":
				return result;
			case "failed":
				return {
					status: "failed",
					reason: result.reason,
					...(result.description ? { description: result.description } : {}),
				};
			case "unsupported":
				return { status: "unsupported", reason: "unsupported-platform" };
		}
	}

	closeOAuthPopup(popup);
	const prepared = await prepareAuthorizeRequest({
		clientId: context.clientId,
		redirectUri: options.redirectUri,
		authorizeBaseUrl: context.authorizeBaseUrl,
		scope,
	});
	const { redirectUrl } = await openAuthorizeUrlNative(
		prepared.authorizeUrl,
		options.redirectUri,
		{ allowExternalFallback: false },
	);
	if (!redirectUrl) return { status: "cancelled" };

	const callback = parseNativeCallback(redirectUrl, options.redirectUri);
	if (callback.kind === "error") {
		return {
			status: "failed",
			reason: "idp-error",
			...(callback.description ? { description: callback.description } : {}),
		};
	}
	if (callback.kind === "invalid") {
		return { status: "failed", reason: "native-callback-invalid" };
	}

	const completion = await completeOAuthCode({
		oxyServices: context.oxyServices,
		clientId: context.clientId,
		code: callback.code,
		returnedState: callback.state,
		handshake: prepared.handshake,
		redirectUri: options.redirectUri,
		commitSession: commitExactSubject,
	});
	if (subjectMismatch) return { status: "failed", reason: "subject-mismatch" };
	return completion.ok
		? { status: "consented" }
		: { status: "failed", reason: completion.reason };
}
