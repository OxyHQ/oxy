import { oxyProfileCapabilityCatalog } from "../../capabilities/oxy-profile.catalog";
import { ForegroundPilotHttps } from "../foregroundPilotHttps";

const credential = {
	publicKey: "synthetic-api-key",
	secret: "synthetic-secret",
};
function transport(
	body = JSON.stringify({
		data: { token: "synthetic-token", expiresIn: 300, appName: "synthetic" },
	}),
) {
	return jest
		.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
		.mockImplementation(async () => new Response(body));
}

it("sends key/secret only to canonical Oxy mint, bearer only to registration, refusing redirects", async () => {
	const fetcher = transport();
	const client = new ForegroundPilotHttps(fetcher);
	const token = await client.mint(credential);
	await client.register(oxyProfileCapabilityCatalog(), token);
	expect(fetcher.mock.calls[0]).toEqual([
		"https://api.oxy.so/auth/service-token",
		expect.objectContaining({
			redirect: "error",
			body: JSON.stringify({
				apiKey: credential.publicKey,
				apiSecret: credential.secret,
			}),
			headers: { "Content-Type": "application/json" },
		}),
	]);
	expect(fetcher.mock.calls[1]).toEqual([
		"https://api.oxy.so/capabilities/catalogs/register",
		expect.objectContaining({
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
		}),
	]);
	await expect(
		client.register(
			{
				...oxyProfileCapabilityCatalog(),
				internalBaseUrl: "https://other.invalid",
			},
			token,
		),
	).rejects.toThrow("canonical origin");
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([302, 401, 500])(
	"rejects HTTP %i without reflecting response secrets or arbitrary diagnostics",
	async (status) => {
		const fetcher = transport();
		fetcher.mockResolvedValue(new Response(credential.secret, { status }));
		await expect(
			new ForegroundPilotHttps(fetcher).mint(credential),
		).rejects.toThrow("reconcile persisted intent");
	},
);

it("bounds streamed bytes and rejects abort before dispatch", async () => {
	const fetcher = transport("x".repeat(65_537));
	await expect(
		new ForegroundPilotHttps(fetcher).mint(credential),
	).rejects.toThrow("reconcile persisted intent");
	const aborted = new AbortController();
	aborted.abort();
	await expect(
		new ForegroundPilotHttps(fetcher).mint(credential, aborted.signal),
	).rejects.toThrow("cancelled");
	expect(fetcher).toHaveBeenCalledTimes(1);
});

it("uses a bounded abort deadline while waiting for an HTTP ACK", async () => {
	jest.useFakeTimers();
	try {
		const fetcher = jest
			.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
			.mockImplementation(
				(_url, options) =>
					new Promise((_resolve, reject) =>
						options?.signal?.addEventListener(
							"abort",
							() => reject(new Error("synthetic network secret")),
							{ once: true },
						),
					),
			);
		const outcome = expect(
			new ForegroundPilotHttps(fetcher).mint(credential),
		).rejects.toThrow("reconcile persisted intent");
		await jest.advanceTimersByTimeAsync(10_000);
		await outcome;
		expect(fetcher).toHaveBeenCalledTimes(1);
	} finally {
		jest.useRealTimers();
	}
});

it("rejects an issuer TTL greater than the current 300-second contract", async () => {
	const fetcher = transport(
		JSON.stringify({
			data: { token: "synthetic", expiresIn: 301, appName: "synthetic" },
		}),
	);
	await expect(
		new ForegroundPilotHttps(fetcher).mint(credential),
	).rejects.toThrow();
});
