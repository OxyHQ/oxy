import { parseRuntimeMode } from "../../config/runtimeMode";
import { rollbackAuthPathAllowed } from "../rollbackAuthAdmission";

it("requires the exact explicit mode and preserves the absent normal default", () => {
	expect(parseRuntimeMode(undefined)).toBe("normal");
	expect(parseRuntimeMode("normal")).toBe("normal");
	expect(parseRuntimeMode("rollback-auth-only")).toBe("rollback-auth-only");
	for (const value of [
		"",
		"auth",
		"production",
		" rollback-auth-only",
		"ROLLBACK_AUTH_ONLY",
	]) {
		expect(() => parseRuntimeMode(value)).toThrow("OXY_RUNTIME_MODE_INVALID");
	}
});
it.each([
	["GET", "/health"],
	["GET", "/.well-known/jwks.json"],
	["GET", "/users/me"],
	["GET", "/session/device/state"],
	["GET", "/session/device/directory"],
	["GET", "/session/validate/abc-123"],
	["GET", "/session/user/abc_123"],
	["POST", "/auth/signin/password"],
	["POST", "/auth/challenge"],
	["POST", "/accounts/account-123/switch"],
	["POST", "/auth/verify"],
	["POST", "/auth/service-token"],
	["POST", "/auth/service-token/workload"],
	["POST", "/session/device/add"],
	["POST", "/session/device/signout"],
	["POST", "/session/logout/source/target"],
	["POST", "/session/device/logout-all/source"],
])(
	"allows only the enumerated %s %s and its one-prefix alias",
	(method, path) => {
		expect(rollbackAuthPathAllowed(method, path)).toBe(true);
		expect(rollbackAuthPathAllowed(method, `/api${path}?fixture=1`)).toBe(true);
	},
);
it.each([
	["HEAD", "/users/me"],
	["GET", "/accounts/account-123/switch"],
	["POST", "/accounts/account-123/switch/other"],
	["POST", "/accounts/account-123/switching"],
	["POST", "/users/me"],
	["GET", "/users/me/other"],
	["POST", "/auth/oauth/token"],
	["POST", "/auth/register"],
	["POST", "/auth/session/claim"],
	["POST", "/capabilities/tickets"],
	["POST", "/billing/webhook"],
	["POST", "/assets/service/cache"],
	["GET", "/v1/realtime"],
	["GET", "/socket.io/"],
	["POST", "/session/device/background/mint"],
	["GET", "/api/api/users/me"],
	["GET", "/api//users/me"],
	["GET", "/users%2fme"],
	["GET", "/api/../users/me"],
	["GET", "/users/./me"],
	["GET", "/users\\me"],
	["GET", "/session/validate/a/b"],
	["POST", "/session/logout/a/b/c"],
])("denies unavailable or ambiguous %s %s", (method, path) => {
	expect(rollbackAuthPathAllowed(method, path)).toBe(false);
});
