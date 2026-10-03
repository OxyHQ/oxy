/** Exact admission before body parsers and protocol mounts; existing auth stays downstream. */
import type { RequestHandler } from "express";
import { isRollbackAuthOnly } from "../config/runtimeMode";

const getPaths = new Set([
	"/health",
	"/.well-known/jwks.json",
	"/users/me",
	"/auth/validate",
	"/session/device/state",
	"/session/device/directory",
]);
const postPaths = new Set([
	"/auth/signin/password",
	"/auth/signin/second-factor",
	"/auth/signin/email/start",
	"/auth/signin/email/confirm",
	"/auth/signin/email/link",
	"/auth/signin/email/collect",
	"/auth/challenge",
	"/auth/verify",
	"/auth/service-token",
	"/auth/service-token/workload/challenge",
	"/auth/service-token/workload",
	"/session/device/token",
	"/session/device/register",
	"/session/device/join-code",
	"/session/device/join",
	"/session/device/add",
	"/session/device/activate",
	"/session/device/switch",
	"/session/device/signout",
]);
const sessionId = "[A-Za-z0-9_-]{1,255}";
const getSessionPath = new RegExp(
	`^/session/(?:user|sessions|validate|validate-header|device/sessions)/${sessionId}$`,
);
const postAccountSwitchPath = new RegExp(`^/accounts/${sessionId}/switch$`);
const postSessionPath = new RegExp(
	`^/session/(?:logout/${sessionId}(?:/${sessionId})?|(?:logout-all|device/logout-all)/${sessionId})$`,
);

export function rollbackAuthPathAllowed(
	method: string,
	originalUrl: string,
): boolean {
	let path = originalUrl.split("?")[0];
	// URL decoding and prefix aliases must never broaden this allowlist.
	if (
		/%|\\|\/\//.test(path) ||
		path.split("/").some((segment) => segment === "." || segment === "..")
	)
		return false;
	if (path.startsWith("/api/")) path = path.slice(4);
	if (method === "GET") return getPaths.has(path) || getSessionPath.test(path);
	if (method === "POST")
		return (
			postPaths.has(path) ||
			postSessionPath.test(path) ||
			postAccountSwitchPath.test(path)
		);
	return false;
}

export const rollbackAuthAdmission: RequestHandler = (
	request,
	response,
	next,
) => {
	if (!isRollbackAuthOnly) return next();
	const method =
		request.method === "OPTIONS"
			? (request.header("access-control-request-method") ?? "")
			: request.method;
	// Attribution headers cannot become foreground/offline authority in this old image.
	if (
		request.header("x-oxy-user-id") === undefined &&
		rollbackAuthPathAllowed(method, request.originalUrl)
	)
		return next();
	response
		.set("Cache-Control", "no-store")
		.set("Retry-After", "60")
		.status(503)
		.json({
			error: "ROLLBACK_AUTH_ONLY",
			message: "This operation is unavailable during authentication recovery",
		});
};
