import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OxyServices } from "../OxyServices";

let server: Server;
let origin: string;
const seen: {
	path: string;
	authorization?: string;
	body: string;
	contentType?: string;
	cookie?: string;
}[] = [];
const envelope = {
	success: true,
	data: [{ id: "item" }],
	deleted: ["removed"],
	serverTime: "2026-10-03T12:00:00Z",
};

beforeAll(async () => {
	server = createServer(async (req, res) => {
		let body = "";
		for await (const part of req) body += String(part);
		seen.push({
			path: req.url ?? "/",
			authorization: req.headers.authorization,
			body,
			contentType: req.headers["content-type"],
			cookie: req.headers.cookie,
		});
		if (req.url === "/redirect") {
			res.writeHead(302, { location: `${origin}/redirect-target` });
			res.end();
			return;
		}
		if (req.url === "/slow") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: first\n\n");
			return;
		}
		if (
			req.url === "/401" ||
			(req.url === "/refresh" &&
				req.headers.authorization === `Bearer ${token("old")}`)
		) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end('{"error":"expired"}');
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(envelope));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});

function token(
	nonce: string,
	userId = "fixture-user",
	sessionId = `session-${userId}`,
): string {
	const encode = (v: unknown) =>
		Buffer.from(JSON.stringify(v)).toString("base64url");
	return `${encode({ alg: "HS256" })}.${encode({ userId, sessionId, nonce, exp: 2_000_000_000 })}.fixture`;
}
function fixture(signedIn = true) {
	const oxy = new OxyServices({ baseURL: origin });
	if (signedIn) oxy.session.setAccessToken(token("old"));
	const linked = oxy.createLinkedClient({ baseURL: origin });
	return { oxy, linked };
}

it("keeps public envelopes unread without accepting a caller bearer or cookie", async () => {
	const { linked } = fixture(false);
	try {
		const response = await linked.client.requestResponse({
			method: "GET",
			url: "/public",
			headers: { Authorization: "Bearer forged", Cookie: "forged=1" },
		});
		expect(response.bodyUsed).toBe(false);
		expect(await response.json()).toEqual(envelope);
		expect(seen.at(-1)).toMatchObject({
			path: "/public",
			authorization: undefined,
			cookie: undefined,
		});
	} finally {
		linked.dispose();
	}
});
it("keeps the authenticated wrapper fail-closed before transport", async () => {
	const { linked } = fixture(false);
	try {
		const before = seen.length;
		await expect(
			linked.client.requestAuthenticatedResponse({
				method: "POST",
				url: "/private",
				body: "{}",
			}),
		).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
		expect(seen).toHaveLength(before);
	} finally {
		linked.dispose();
	}
});
it("refuses absolute foreign origins before sending the bearer", async () => {
	const { linked } = fixture();
	try {
		const before = seen.length;
		await expect(
			linked.client.requestAuthenticatedResponse({
				method: "GET",
				url: `${origin.replace("127.0.0.1", "localhost")}/foreign`,
			}),
		).rejects.toThrow();
		expect(seen).toHaveLength(before);
	} finally {
		linked.dispose();
	}
});
it("refuses redirects instead of changing the write target", async () => {
	const { linked } = fixture();
	try {
		const before = seen.length;
		await expect(
			linked.client.requestAuthenticatedResponse({
				method: "POST",
				url: "/redirect",
				body: "{}",
			}),
		).rejects.toMatchObject({ message: expect.any(String) });
		expect(seen.slice(before).map(({ path }) => path)).toEqual(["/redirect"]);
	} finally {
		linked.dispose();
	}
});
it("replays a serialised write once after SDK refresh with the same body and owned bearer", async () => {
	const { oxy, linked } = fixture();
	try {
		const refresh = jest.fn(async () => token("new"));
		oxy.http.setAuthRefreshHandler(refresh);
		const before = seen.length;
		const response = await linked.client.requestResponse({
			method: "POST",
			url: "/refresh",
			body: '{"id":"same-intent"}',
			headers: { authorization: "Bearer forged" },
		});
		expect(response.bodyUsed).toBe(false);
		expect(await response.json()).toEqual(envelope);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(
			seen
				.slice(before)
				.map(({ body, authorization }) => ({ body, authorization })),
		).toEqual([
			{ body: '{"id":"same-intent"}', authorization: `Bearer ${token("old")}` },
			{ body: '{"id":"same-intent"}', authorization: `Bearer ${token("new")}` },
		]);
	} finally {
		linked.dispose();
	}
});
it("does not retry a second 401 or consume its response body", async () => {
	const { oxy, linked } = fixture();
	try {
		const refresh = jest.fn(async () => token("new"));
		oxy.http.setAuthRefreshHandler(refresh);
		const before = seen.length;
		const response = await linked.client.requestResponse({
			method: "POST",
			url: "/401",
			body: "{}",
		});
		expect(response.status).toBe(401);
		expect(response.bodyUsed).toBe(false);
		expect(await response.json()).toEqual({ error: "expired" });
		expect(seen).toHaveLength(before + 2);
		expect(refresh).toHaveBeenCalledTimes(1);
	} finally {
		linked.dispose();
	}
});
it("uses the explicit multipart transport and leaves boundary generation to fetch", async () => {
	const { linked } = fixture();
	try {
		const form = new FormData();
		form.append(
			"file",
			new Blob(["fixture content"], { type: "text/plain" }),
			"fixture.txt",
		);
		const transport = jest.fn(
			(input: Parameters<typeof fetch>[0], init?: RequestInit) =>
				fetch(input, init),
		);
		const response = await linked.client.requestResponse({
			method: "POST",
			url: "/multipart",
			body: form,
			fetch: transport,
		});
		expect(await response.json()).toEqual(envelope);
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0]?.[1]).toMatchObject({
			credentials: "omit",
			redirect: "error",
			body: form,
		});
		expect(seen.at(-1)?.contentType).toMatch(
			/^multipart\/form-data; boundary=/,
		);
		expect(seen.at(-1)?.body).toContain("fixture content");
	} finally {
		linked.dispose();
	}
});
it("does not refresh or replay multipart writes on 401", async () => {
	const { oxy, linked } = fixture();
	try {
		const refresh = jest.fn(async () => token("new"));
		oxy.http.setAuthRefreshHandler(refresh);
		const form = new FormData();
		form.append("id", "fixture");
		const before = seen.length;
		const response = await linked.client.requestResponse({
			method: "POST",
			url: "/401",
			body: form,
		});
		expect(response.status).toBe(401);
		expect(response.bodyUsed).toBe(false);
		await response.body?.cancel();
		expect(seen).toHaveLength(before + 1);
		expect(refresh).not.toHaveBeenCalled();
	} finally {
		linked.dispose();
	}
});
it("honours cancellation before dispatch and during response streaming", async () => {
	const { linked } = fixture();
	try {
		const before = seen.length;
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			linked.client.requestResponse({
				method: "GET",
				url: "/public",
				signal: cancelled.signal,
			}),
		).rejects.toThrow();
		expect(seen).toHaveLength(before);
		const controller = new AbortController();
		const response = await linked.client.requestResponse({
			method: "GET",
			url: "/slow",
			signal: controller.signal,
		});
		const body = response.text();
		controller.abort();
		await expect(body).rejects.toThrow();
		expect(seen).toHaveLength(before + 1);
	} finally {
		linked.dispose();
	}
});

it("does not replay a consumed streaming upload on 401", async () => {
	const { oxy, linked } = fixture();
	try {
		const refresh = jest.fn(async () => token("new"));
		oxy.http.setAuthRefreshHandler(refresh);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("streamed-once"));
				controller.close();
			},
		});
		const before = seen.length;
		const response = await linked.client.requestResponse({
			method: "POST",
			url: "/401",
			body: stream,
		});
		expect(response.status).toBe(401);
		await response.body?.cancel();
		expect(seen.slice(before).map(({ body }) => body)).toEqual([
			"streamed-once",
		]);
		expect(refresh).not.toHaveBeenCalled();
	} finally {
		linked.dispose();
	}
});
it("does not mint a session in response to an anonymous public 401", async () => {
	const { oxy, linked } = fixture(false);
	try {
		const refresh = jest.fn(async () => token("new"));
		oxy.http.setAuthRefreshHandler(refresh);
		const before = seen.length;
		const response = await linked.client.requestResponse({
			method: "GET",
			url: "/401",
		});
		expect(response.status).toBe(401);
		await response.body?.cancel();
		expect(seen).toHaveLength(before + 1);
		expect(refresh).not.toHaveBeenCalled();
	} finally {
		linked.dispose();
	}
});
it("does not dispatch again if cancelled while refresh is pending", async () => {
	const { oxy, linked } = fixture();
	try {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		oxy.http.setAuthRefreshHandler(async () => {
			entered();
			await gate;
			return token("new");
		});
		const controller = new AbortController();
		const before = seen.length;
		const pending = linked.client.requestResponse({
			method: "POST",
			url: "/refresh",
			body: "{}",
			signal: controller.signal,
		});
		const rejected = expect(pending).rejects.toMatchObject({
			code: "CANCELLED",
		});
		await ready;
		controller.abort();
		release();
		await rejected;
		expect(seen).toHaveLength(before + 1);
	} finally {
		linked.dispose();
	}
});

// The server exchanges bytes normally; only the auth refresh is held at its
// async boundary so account changes happen deterministically while it awaits.
it.each([
	"switch",
	"same-account-new-session",
	"logout",
	"logout-then-switch",
	"switch-back",
] as const)(
	"does not replay or mutate the new session after %s during refresh",
	async (change) => {
		const { oxy, linked } = fixture();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		try {
			oxy.http.setAuthRefreshHandler(async () => {
				entered();
				await gate;
				return token("new");
			});
			const before = seen.length;
			const pending = linked.client.requestResponse({
				method: "POST",
				url: "/refresh",
				body: '{"intent":"A"}',
			});
			// Attach immediately, before advancing either side of the barrier.
			const outcome = pending.then(
				(response) => ({ response }),
				(error: unknown) => ({ error }),
			);
			await ready;
			if (change.startsWith("logout")) oxy.http.endSession();
			if (change === "same-account-new-session")
				oxy.http.setTokens(
					token("A-context2", "fixture-user", "different-session"),
				);
			else if (change !== "logout") oxy.http.setTokens(token("B", "user-B"));
			if (change === "switch-back") oxy.http.setTokens(token("A-again"));
			const expected = oxy.http.getAccessToken();
			release();
			const result = await outcome;
			if ("response" in result) await result.response.body?.cancel();
			expect(result).toMatchObject({ error: { code: "AUTH_SESSION_CHANGED" } });
			expect(oxy.http.getAccessToken()).toBe(expected);
			expect(linked.client.getAccessToken()).toBe(expected);
			expect(seen).toHaveLength(before + 1);
		} finally {
			release();
			linked.dispose();
		}
	},
);
it.each(["switch", "logout"] as const)(
	"rejects an unread late 200 after %s",
	async (change) => {
		const { oxy, linked } = fixture();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		try {
			const pending = linked.client.requestResponse({
				method: "GET",
				url: "/public",
				fetch: async (url, init) => {
					const response = await fetch(url, init);
					entered();
					await gate;
					return response;
				},
			});
			const outcome = pending.then(
				(response) => ({ response }),
				(error: unknown) => ({ error }),
			);
			await ready;
			if (change === "logout") oxy.http.endSession();
			else oxy.http.setTokens(token("B", "user-B"));
			release();
			const result = await outcome;
			if ("response" in result) await result.response.body?.cancel();
			expect(result).toMatchObject({ error: { code: "AUTH_SESSION_CHANGED" } });
		} finally {
			release();
			linked.dispose();
		}
	},
);

it("preserves the configured anonymous service bearer without caller authority", async () => {
	const { linked } = fixture(false);
	try {
		linked.client.setAnonymousAuthProvider(async () => "service-fixture");
		const response = await linked.client.requestResponse({
			method: "GET",
			url: "/public",
		});
		expect(await response.json()).toEqual(envelope);
		expect(seen.at(-1)?.authorization).toBe("Bearer service-fixture");
	} finally {
		linked.dispose();
	}
});

it.each([true, false])(
	"acknowledges a context adopted by the guarded refresh handler (initial session: %s)",
	async (signedIn) => {
		const { oxy, linked } = fixture(signedIn);
		try {
			const adopted = token("adopted-org", "organization", "new-session");
			oxy.http.setAuthRefreshHandler(async () => {
				oxy.http.setTokens(adopted);
				return adopted;
			});
			await expect(linked.client.refreshAccessToken("preflight")).resolves.toBe(
				adopted,
			);
			expect(oxy.http.getAccessToken()).toBe(adopted);
			expect(linked.client.getAccessToken()).toBe(adopted);
		} finally {
			linked.dispose();
		}
	},
);
it("does not replay the original write when refresh deliberately adopts a different context", async () => {
	const { oxy, linked } = fixture();
	try {
		const adopted = token("adopted-org", "organization", "new-session");
		oxy.http.setAuthRefreshHandler(async () => {
			oxy.http.setTokens(adopted);
			return adopted;
		});
		const before = seen.length;
		await expect(
			linked.client.requestResponse({
				method: "POST",
				url: "/refresh",
				body: '{"intent":"A"}',
			}),
		).rejects.toMatchObject({ code: "AUTH_SESSION_CHANGED" });
		expect(seen).toHaveLength(before + 1);
		expect(oxy.http.getAccessToken()).toBe(adopted);
		expect(linked.client.getAccessToken()).toBe(adopted);
	} finally {
		linked.dispose();
	}
});
