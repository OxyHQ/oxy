jest.mock("../../components/oauthNavigation", () => ({
	openAuthorizeUrlNative: jest.fn(),
	redirectToAuthorize: jest.fn(),
}));

import type { OxyServices } from "@oxyhq/core";
import { computeCodeChallenge } from "@oxyhq/core";
import { openAuthorizeUrlNative } from "../../components/oauthNavigation";
import {
	requestOAuthConsent,
	type OAuthConsentContext,
} from "../explicitOAuthConsent";
import type { OAuthPopupHandle } from "../types";

const CLIENT_ID = "oxy_dk_homiio";
const WEB_REDIRECT_URI = "https://homiio.com";
const NATIVE_REDIRECT_URI = "homiio://oauth/consent";
const USER_ID = "01a0646a-078f-7000-8000-000000000001";
const EXACT_SCOPES = ["inference:invoke", "acting-as:offline"] as const;

const openNative = openAuthorizeUrlNative as jest.MockedFunction<
	typeof openAuthorizeUrlNative
>;

function makeContext(
	platform: OAuthConsentContext["platform"],
	overrides: Partial<OAuthConsentContext> = {},
): OAuthConsentContext & {
	getPublicApplication: jest.Mock;
	exchangeOAuthCode: jest.Mock;
	commitSession: jest.Mock;
} {
	const getPublicApplication = jest.fn().mockResolvedValue({
		id: "homiio-app-id",
		scopes: [...EXACT_SCOPES, "user:read"],
	});
	const exchangeOAuthCode = jest.fn().mockResolvedValue({
		sessionId: "session-after-consent",
		accessToken: "access-after-consent",
		user: { id: USER_ID },
	});
	const commitSession = jest.fn().mockResolvedValue(undefined);
	return {
		platform,
		mode: "popup",
		oxyServices: {
			getPublicApplication,
			exchangeOAuthCode,
		} as unknown as OxyServices,
		clientId: CLIENT_ID,
		identityBound: false,
		expectedUserId: USER_ID,
		commitSession,
		...overrides,
		getPublicApplication,
		exchangeOAuthCode,
	};
}

function fakePopup(): OAuthPopupHandle {
	let closed = false;
	return {
		get closed() {
			return closed;
		},
		close: jest.fn(() => {
			closed = true;
		}),
		location: { href: "" },
	};
}

async function waitForAuthorizeUrl(popup: OAuthPopupHandle): Promise<URL> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (popup.location.href) return new URL(popup.location.href);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("the consent popup was never navigated");
}

describe("requestOAuthConsent", () => {
	beforeEach(() => {
		openNative.mockReset();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it("uses the existing web popup transport with exact scopes and redirect", async () => {
		const popup = fakePopup();
		jest.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
		const context = makeContext("web");

		const pending = requestOAuthConsent(context, {
			redirectUri: WEB_REDIRECT_URI,
			scopes: EXACT_SCOPES,
		});
		const authorizeUrl = await waitForAuthorizeUrl(popup);
		expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
			WEB_REDIRECT_URI,
		);
		expect(authorizeUrl.searchParams.get("scope")).toBe(EXACT_SCOPES.join(" "));
		expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");

		const message = new Event("message");
		Object.assign(message, {
			data: {
				type: "oxy:oauth:code",
				code: "web-code",
				state: authorizeUrl.searchParams.get("state"),
			},
			origin: authorizeUrl.origin,
			source: popup,
		});
		window.dispatchEvent(message);

		await expect(pending).resolves.toEqual({ status: "consented" });
		expect(context.commitSession).toHaveBeenCalledTimes(1);
	});

	it("binds native consent to exact redirect, state and PKCE before committing", async () => {
		let authorizeUrl: URL | undefined;
		openNative.mockImplementation(async (value, redirectUri, options) => {
			authorizeUrl = new URL(value);
			expect(redirectUri).toBe(NATIVE_REDIRECT_URI);
			expect(options).toEqual({ allowExternalFallback: false });
			return {
				redirectUrl: `${NATIVE_REDIRECT_URI}?code=native-code&state=${authorizeUrl.searchParams.get("state")}`,
			};
		});
		const context = makeContext("native");

		await expect(
			requestOAuthConsent(context, {
				redirectUri: NATIVE_REDIRECT_URI,
				scopes: EXACT_SCOPES,
			}),
		).resolves.toEqual({ status: "consented" });

		expect(authorizeUrl?.searchParams.get("redirect_uri")).toBe(
			NATIVE_REDIRECT_URI,
		);
		expect(authorizeUrl?.searchParams.get("scope")).toBe(
			EXACT_SCOPES.join(" "),
		);
		expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe(
			"S256",
		);
		const exchange = context.exchangeOAuthCode.mock.calls[0][0];
		await expect(computeCodeChallenge(exchange.codeVerifier)).resolves.toBe(
			authorizeUrl?.searchParams.get("code_challenge"),
		);
		expect(exchange.redirectUri).toBe(NATIVE_REDIRECT_URI);
		expect(context.commitSession).toHaveBeenCalledTimes(1);
	});

	it("rejects a native callback for another redirect or state", async () => {
		const wrongTarget = makeContext("native");
		openNative.mockResolvedValueOnce({
			redirectUrl: "homiio://oauth/consent-evil?code=code&state=state",
		});
		await expect(
			requestOAuthConsent(wrongTarget, {
				redirectUri: NATIVE_REDIRECT_URI,
				scopes: EXACT_SCOPES,
			}),
		).resolves.toEqual({ status: "failed", reason: "native-callback-invalid" });
		expect(wrongTarget.exchangeOAuthCode).not.toHaveBeenCalled();

		const wrongState = makeContext("native");
		openNative.mockResolvedValueOnce({
			redirectUrl: `${NATIVE_REDIRECT_URI}?code=code&state=forged`,
		});
		await expect(
			requestOAuthConsent(wrongState, {
				redirectUri: NATIVE_REDIRECT_URI,
				scopes: EXACT_SCOPES,
			}),
		).resolves.toEqual({ status: "failed", reason: "state-mismatch" });
		expect(wrongState.exchangeOAuthCode).not.toHaveBeenCalled();
		expect(wrongState.commitSession).not.toHaveBeenCalled();
	});

	it.each([
		[" leading scope", [" inference:invoke", "acting-as:offline"]],
		["trailing scope", ["inference:invoke ", "acting-as:offline"]],
		["embedded whitespace", ["inference:invoke\nacting-as:offline"]],
		["duplicates", ["inference:invoke", "inference:invoke"]],
		["bare word", ["openid"]],
	])(
		"rejects %s before resolving the client or opening OAuth",
		async (_label, scopes) => {
			const context = makeContext("native");
			await expect(
				requestOAuthConsent(context, {
					redirectUri: NATIVE_REDIRECT_URI,
					scopes,
				}),
			).resolves.toEqual({ status: "failed", reason: "invalid-scopes" });
			expect(context.getPublicApplication).not.toHaveBeenCalled();
			expect(openNative).not.toHaveBeenCalled();
		},
	);

	it("rejects a well-formed scope absent from the exact application record", async () => {
		const context = makeContext("native");
		await expect(
			requestOAuthConsent(context, {
				redirectUri: NATIVE_REDIRECT_URI,
				scopes: ["inference:invoke", "files:write"],
			}),
		).resolves.toEqual({ status: "failed", reason: "scope-not-configured" });
		expect(openNative).not.toHaveBeenCalled();
		expect(context.exchangeOAuthCode).not.toHaveBeenCalled();
	});

	it.each([
		` ${NATIVE_REDIRECT_URI}`,
		`${NATIVE_REDIRECT_URI} `,
		"homiio://oauth/con sent",
		"not-a-uri",
	])(
		"rejects a non-exact redirect URI before OAuth: %s",
		async (redirectUri) => {
			const context = makeContext("native");
			await expect(
				requestOAuthConsent(context, { redirectUri, scopes: EXACT_SCOPES }),
			).resolves.toEqual({ status: "failed", reason: "invalid-redirect-uri" });
			expect(context.getPublicApplication).not.toHaveBeenCalled();
			expect(openNative).not.toHaveBeenCalled();
		},
	);

	it("does not commit or report consent when OAuth returns another user", async () => {
		const context = makeContext("native");
		context.exchangeOAuthCode.mockResolvedValue({
			sessionId: "other-session",
			accessToken: "other-token",
			user: { id: "another-user" },
		});
		openNative.mockImplementation(async (value) => {
			const authorizeUrl = new URL(value);
			return {
				redirectUrl: `${NATIVE_REDIRECT_URI}?code=code&state=${authorizeUrl.searchParams.get("state")}`,
			};
		});

		await expect(
			requestOAuthConsent(context, {
				redirectUri: NATIVE_REDIRECT_URI,
				scopes: EXACT_SCOPES,
			}),
		).resolves.toEqual({ status: "failed", reason: "subject-mismatch" });
		expect(context.commitSession).not.toHaveBeenCalled();
	});
});
