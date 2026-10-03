/** Real Stripe test objects; real Oxy route/SQL; locally signed delivery, never claimed provider delivery. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	readFile,
	readlink,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { productDefinitionSchema, productOfferSchema } from "@oxy.so/contracts";
import { eq, sql } from "drizzle-orm";
import express from "express";
import { rateLimit } from "express-rate-limit";
import Stripe from "stripe";
import { closePostgres, connectPostgres, getDb } from "../src/config/postgres";
import { assertBillingDatabaseNamespace } from "../src/config/billingNamespace";
import { accountMembers } from "../src/db/schema/accountMembers";
import { applications } from "../src/db/schema/applications";
import { billingCreditGrants } from "../src/db/schema/billingCreditGrants";
import {
	accessGrants,
	accessSubscriptionSources,
} from "../src/db/schema/productAccess";
import { accessProviderPeriods } from "../src/db/schema/productProviderEvidence";
import { sessions } from "../src/db/schema/sessions";
import { userCredits } from "../src/db/schema/userCredits";
import { users } from "../src/db/schema/users";
import {
	readSubjectProductAccess,
	registerProductAccessConfiguration,
} from "../src/services/productAccessPersistence.service";
import { FREE_PERIOD_PROMOTIONS } from "../src/services/subscriptionPromotionPolicy";
import { spendSubscriptionTrackedCredits } from "../src/services/subscriptionCreditLedger.service";
import { generateSessionTokens } from "../src/utils/sessionUtils";

const ACCOUNT = "acct_1TnXkUQWiCE02OnU";
const KEY_FILE = "/home/nate/Oxy/Mercaria/packages/backend/.env";
const OUTPUT =
	"/home/nate/Oxy/.agent-evidence/integration-stripe-1519-20261003";
const MAX_PAID = 50000;
const PORT = 5594;
type Owned = {
	kind:
		| "clock"
		| "customer"
		| "paymentMethod"
		| "product"
		| "price"
		| "subscription"
		| "coupon"
		| "refund";
	id: string;
	step: string;
};
type Check = { name: string; passed: true; evidence: unknown };
function eventObjectId(event: Stripe.Event): string {
	const object = event.data.object as unknown as Record<string, unknown>;
	assert.equal(typeof object.id, "string");
	return String(object.id);
}
type Plan = {
	schemaVersion: number;
	nonce: string;
	expiresAt: number;
	scope: {
		providerAccountId: string;
		mode: string;
		environment: string;
		maximumSyntheticPaidMinorUnits: number;
	};
	sourceSha256: Record<string, string>;
};

async function privateJson(path: string, value: unknown) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
async function main() {
	assert.equal(
		process.argv.length,
		4,
		"Only frozen plan and owned output are accepted",
	);
	const planPath = resolve(process.argv[2]);
	const directory = resolve(process.argv[3]);
	const plan: Plan = JSON.parse(await readFile(planPath, "utf8"));
	assert.match(plan.nonce, /^[a-f0-9]{24}$/);
	assert.equal(directory, join(OUTPUT, plan.nonce));
	assert.equal(planPath, join(directory, "plan.json"));
	assert.equal(plan.schemaVersion, 1);
	assert.equal(plan.scope.providerAccountId, ACCOUNT);
	assert.equal(plan.scope.mode, "test");
	assert.equal(plan.scope.environment, "test");
	assert.equal(plan.scope.maximumSyntheticPaidMinorUnits, MAX_PAID);
	assert.ok(Date.now() / 1000 < plan.expiresAt);
	const root = resolve(process.cwd());
	for (const [path, digest] of Object.entries(plan.sourceSha256)) {
		assert.equal(
			createHash("sha256")
				.update(await readFile(join(root, path)))
				.digest("hex"),
			digest,
			`Frozen input differs: ${path}`,
		);
	}
	const owner = JSON.parse(
		await readFile(join(directory, "owner.json"), "utf8"),
	);
	assert.equal(owner.port, PORT);
	assert.equal(owner.database, `oxy_stripe_${plan.nonce}`);
	assert.equal(owner.uid, process.getuid?.());
	assert.equal(owner.data, join(directory, "data"));
	assert.equal(
		await realpath(`/proc/${owner.pid}/exe`),
		"/usr/lib/postgresql/17/bin/postgres",
	);
	const pgRows = (
		await readFile(join(owner.data, "postmaster.pid"), "utf8")
	).split("\n");
	assert.equal(Number(pgRows[0]), owner.pid);
	assert.equal(pgRows[1], owner.data);
	assert.equal(Number(pgRows[3]), PORT);
	assert.equal(pgRows[4], owner.socket);
	assert.equal((await stat(`/proc/${owner.pid}`)).uid, owner.uid);
	const pgArgs = (await readFile(`/proc/${owner.pid}/cmdline`))
		.toString()
		.split("\0");
	assert.ok(pgArgs.includes("-D") && pgArgs.includes(owner.data));
	// The child also verifies the literal listener belongs to the owned process.
	const tcp = (await readFile("/proc/net/tcp", "utf8"))
		.split("\n")
		.slice(1)
		.map((row) => row.trim().split(/\s+/));
	const listener = tcp.filter(
		(row) =>
			row[1] ===
				`0100007F:${PORT.toString(16).toUpperCase().padStart(4, "0")}` &&
			row[3] === "0A",
	);
	assert.equal(listener.length, 1);
	const { readdir } = await import("node:fs/promises");
	const sockets = await Promise.all(
		(await readdir(`/proc/${owner.pid}/fd`)).map((fd) =>
			readlink(`/proc/${owner.pid}/fd/${fd}`),
		),
	);
	assert.ok(sockets.includes(`socket:[${listener[0][9]}]`));
	assert.equal(
		process.env.DATABASE_URL,
		`postgresql://oxy@127.0.0.1:${PORT}/${owner.database}`,
	);
	assert.equal(process.env.NODE_ENV, "test");
	assert.equal(process.env.BILLING_PROCESSOR_ENVIRONMENT, "test");
	const keyLines = (await readFile(KEY_FILE, "utf8"))
		.split(/\r?\n/)
		.filter((line) => /^STRIPE_SECRET_KEY=/.test(line));
	assert.equal(keyLines.length, 1, "Expected exactly one selected test key");
	const key = keyLines[0]
		.slice("STRIPE_SECRET_KEY=".length)
		.trim()
		.replace(/^(['"])(.*)\1$/, "$2");
	assert.match(key, /^sk_test_[a-zA-Z0-9]+$/);
	process.env.STRIPE_SECRET_KEY = key;
	process.env.STRIPE_WEBHOOK_SECRET = `whsec_${randomBytes(32).toString("hex")}`;
	process.env.ACCESS_TOKEN_SECRET = randomBytes(32).toString("hex");
	process.env.REFRESH_TOKEN_SECRET = randomBytes(32).toString("hex");
	const stripe = new Stripe(key, { maxNetworkRetries: 0, timeout: 30000 });
	assert.equal(
		(await stripe.accounts.retrieve()).id,
		ACCOUNT,
		"Unreviewed Stripe account",
	);
	await connectPostgres();
	await assertBillingDatabaseNamespace(getDb());
	const db = getDb();
	const [physical] = await db.execute<{ name: string; identifier: string }>(
		sql`select current_database() as name, system_identifier::text as identifier from pg_control_system()`,
	);
	assert.equal(physical.name, owner.database);
	assert.equal(physical.identifier, owner.systemIdentifier);
	assert.equal(
		FREE_PERIOD_PROMOTIONS.length,
		0,
		"A new promotion requires a separately reviewed fixture",
	);

	const resources: Owned[] = [];
	const intents: Array<{
		step: string;
		idempotencyKey: string;
		status: "started" | "returned" | "failed";
	}> = [];
	const checks: Check[] = [];
	const cleanups: Array<{
		kind: string;
		id: string;
		success: boolean;
		errorCode?: string;
	}> = [];
	let server: http.Server | undefined;
	let observedPaid = 0;
	let subscriptionsCreated = 0;
	let phase = "beforeCreation";
	let stopRequested = false;
	const stop = () => {
		stopRequested = true;
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	let primaryError: { name: string; code?: string; phase: string } | null =
		null;
	const paidInvoiceIds = new Set<string>();
	const metadata = {
		oxy_fixture_scope: "1519_i06_i07",
		oxy_fixture_nonce: plan.nonce,
	};
	const persist = () =>
		privateJson(join(directory, "manifest.private.json"), {
			schemaVersion: 1,
			nonce: plan.nonce,
			account: ACCOUNT,
			mode: "test",
			environment: "test",
			resources,
			intents,
			checks,
			cleanups,
			observedPaidMinorUnits: observedPaid,
			unresolvedCreationIntents: intents.filter(
				(intent) =>
					intent.status === "failed" &&
					!resources.some((resource) => resource.step === intent.step),
			),
			retainedTestHistory: resources.filter(
				(resource) => resource.kind === "refund",
			),
			providerSignedDelivery: false,
			deliveryProvenance:
				"authenticatedStripeGET+locallyGeneratedFixtureSignature",
			primaryError,
		});
	function check(name: string, evidence: unknown) {
		checks.push({ name, passed: true, evidence });
	}
	function options(step: string) {
		if (!step.startsWith("cleanup-")) {
			assert.equal(stopRequested, false, "Shutdown requested before mutation");
			assert.ok(
				Date.now() / 1000 < plan.expiresAt,
				"Plan expired before mutation",
			);
		}
		return { idempotencyKey: `oxy-1519-${plan.nonce}-${step}` };
	}
	async function create<T extends { id: string; livemode?: boolean }>(
		kind: Owned["kind"],
		step: string,
		action: (opts: { idempotencyKey: string }) => Promise<T>,
	): Promise<T> {
		assert.equal(stopRequested, false, "Shutdown requested before creation");
		assert.ok(
			Date.now() / 1000 < plan.expiresAt,
			"Plan expired before creation",
		);
		if (kind === "subscription") {
			subscriptionsCreated += 1;
			assert.ok(subscriptionsCreated <= 4);
		}
		const intent = {
			step,
			idempotencyKey: options(step).idempotencyKey,
			status: "started" as "started" | "returned" | "failed",
		};
		intents.push(intent);
		await persist();
		// Persist returned identity BEFORE shape checks, so a shape failure still cleans it.
		try {
			const result = await action(options(step));
			resources.push({ kind, id: result.id, step });
			intent.status = "returned";
			await persist();
			if ("livemode" in result) assert.equal(result.livemode, false);
			return result;
		} catch (error) {
			intent.status = "failed";
			await persist();
			throw error;
		}
	}
	async function waitFor<T>(
		label: string,
		query: () => Promise<T | null>,
	): Promise<T> {
		const deadline = Date.now() + 120000;
		while (Date.now() < deadline) {
			assert.equal(stopRequested, false, "Shutdown requested during wait");
			assert.ok(
				Date.now() / 1000 < plan.expiresAt,
				"Plan expired during provider wait",
			);
			const value = await query();
			if (value !== null) return value;
			await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
		}
		throw new Error(`Timed out: ${label}`);
	}
	async function providerEvent(
		type: Stripe.Event.Type,
		objectId: string,
		match?: (object: Record<string, unknown>) => boolean,
	): Promise<Stripe.Event> {
		return waitFor(`own ${type}`, async () => {
			let cursor: string | undefined;
			for (let pages = 0; pages < 5; pages += 1) {
				const page = await stripe.events.list({
					type,
					limit: 100,
					...(cursor ? { starting_after: cursor } : {}),
				});
				const candidates = page.data.filter((event) => {
					const object = event.data.object as unknown as Record<
						string,
						unknown
					>;
					return (
						event.livemode === false &&
						object.id === objectId &&
						(!match || match(object))
					);
				});
				if (candidates.length) {
					const event = await stripe.events.retrieve(candidates[0].id);
					assert.equal(event.livemode, false);
					assert.equal(eventObjectId(event), objectId);
					assert.equal(event.type, type);
					return event;
				}
				if (!page.has_more) return null;
				assert.ok(page.data.length);
				cursor = page.data[page.data.length - 1].id;
			}
			throw new Error("Event census exceeds five bounded pages");
		});
	}
	async function deliver(event: Stripe.Event) {
		options("local-delivery");
		assert.equal(event.livemode, false);
		assert.ok(server);
		const payload = JSON.stringify(event);
		const signature = stripe.webhooks.generateTestHeaderString({
			payload,
			secret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
		});
		const port = (server.address() as AddressInfo).port;
		const response = await fetch(`http://127.0.0.1:${port}/billing/webhook`, {
			signal: AbortSignal.timeout(10000),
			method: "POST",
			body: payload,
			headers: {
				"stripe-signature": signature,
				"content-type": "application/json",
			},
		});
		assert.equal(response.status, 200, `Real handler refused ${event.type}`);
		check("local delivery of authenticated test event", {
			eventId: event.id,
			type: event.type,
			objectId: eventObjectId(event),
			signature: "localFixture",
			status: response.status,
		});
		await persist();
	}
	async function paidInvoice(
		id: string,
		customerId: string,
	): Promise<Stripe.Invoice> {
		const invoice = await waitFor("paid invoice", async () => {
			const value = await stripe.invoices.retrieve(id);
			return value.status === "paid" ? value : null;
		});
		assert.equal(invoice.livemode, false);
		assert.equal(ref(invoice.customer), customerId);
		assert.equal(invoice.currency, "usd");
		assert.ok(invoice.amount_paid >= 0 && invoice.amount_paid <= MAX_PAID);
		if (!paidInvoiceIds.has(id)) {
			observedPaid += invoice.amount_paid;
			paidInvoiceIds.add(id);
		}
		assert.ok(observedPaid <= MAX_PAID, "Synthetic spend cap exceeded");
		await persist();
		return invoice;
	}
	async function grants(invoiceId: string) {
		return db
			.select()
			.from(billingCreditGrants)
			.where(eq(billingCreditGrants.invoiceId, invoiceId));
	}
	async function balance(userId: string) {
		const [row] = await db
			.select()
			.from(userCredits)
			.where(eq(userCredits.userId, userId));
		assert.ok(row);
		return row.creditsPaid;
	}
	function ref(value: string | { id: string } | null): string {
		assert.ok(value);
		return typeof value === "string" ? value : value.id;
	}
	async function account(kind: "personal" | "organization") {
		const [row] = await db
			.insert(users)
			.values({ kind, color: "teal" })
			.returning({ id: users.id });
		assert.ok(row);
		return row.id;
	}

	// Cleanup begins before the first provider creation and attempts every object.
	try {
		phase = "ownedResources";
		const clock = await create("clock", "clock", (opts) =>
			stripe.testHelpers.testClocks.create(
				{
					frozen_time: Math.floor(Date.now() / 1000),
					name: `oxy1519-${plan.nonce}`,
				},
				opts,
			),
		);
		const customer = await create("customer", "customer", (opts) =>
			stripe.customers.create({ test_clock: clock.id, metadata }, opts),
		);
		const pm = await create("paymentMethod", "payment-method", (opts) =>
			stripe.paymentMethods.create(
				{ type: "card", card: { token: "tok_visa" }, metadata },
				opts,
			),
		);
		await stripe.paymentMethods.attach(
			pm.id,
			{ customer: customer.id },
			options("attach-pm"),
		);
		await stripe.customers.update(
			customer.id,
			{ invoice_settings: { default_payment_method: pm.id } },
			options("set-pm"),
		);
		const readCustomer = await stripe.customers.retrieve(customer.id);
		assert.ok(!readCustomer.deleted);
		assert.equal(readCustomer.livemode, false);
		assert.equal(readCustomer.metadata.oxy_fixture_nonce, plan.nonce);
		const payer = await account("personal");
		const ownerAccount = await account("personal");
		const beneficiary = await account("organization");
		await db.insert(accountMembers).values({
			accountId: beneficiary,
			memberUserId: payer,
			role: "admin",
			status: "active",
		});
		await db.insert(userCredits).values({
			userId: payer,
			creditsFree: 0,
			creditsFreeLimit: 0,
			creditsPaid: 0,
			stripeCustomerId: customer.id,
		});
		const [application] = await db
			.insert(applications)
			.values({
				name: `Sandbox ${plan.nonce}`,
				type: "internal",
				ownerAccountId: ownerAccount,
			})
			.returning({ id: applications.id });
		assert.ok(application);
		const products = ["a", "b"].map((suffix) =>
			productDefinitionSchema.parse({
				schemaVersion: 1,
				id: `sandbox_${plan.nonce}_${suffix}`,
				ownerAccountId: ownerAccount,
				applicationId: application.id,
			}),
		);
		const quota = (index: number) => ({
			kind: "quota",
			productId: products[index].id,
			key: "fixture_slots",
			unit: "slots",
			included: 5,
			combination: "maximum",
		});
		const offers = [
			productOfferSchema.parse({
				schemaVersion: 1,
				id: `single_${plan.nonce}`,
				version: 1,
				kind: "individual",
				benefits: [quota(0)],
			}),
			productOfferSchema.parse({
				schemaVersion: 1,
				id: `bundle_${plan.nonce}`,
				version: 1,
				kind: "bundle",
				benefits: [quota(0), quota(1)],
			}),
		];
		options("local-configuration");
		await registerProductAccessConfiguration({ products, offers });
		const catalogue = {
			schemaVersion: 1,
			products,
			offers,
			prices: [] as Array<Record<string, unknown>>,
			subscriptions: [] as Array<Record<string, unknown>>,
			displayNames: {
				products: Object.fromEntries(
					products.map((p, i) => [p.id, `Sandbox product ${i + 1}`]),
				),
				offers: Object.fromEntries(
					offers.map((o) => [`${o.id}@1`, `Sandbox ${o.kind}`]),
				),
			},
		};
		const prices: Stripe.Price[] = [];
		for (const [index, amount] of [2999, 9999, 199, 99].entries()) {
			const product = await create("product", `product-${index}`, (opts) =>
				stripe.products.create(
					{ name: `Oxy sandbox fixture ${index} ${plan.nonce}`, metadata },
					opts,
				),
			);
			const price = await create("price", `price-${index}`, (opts) =>
				stripe.prices.create(
					{
						product: product.id,
						currency: "usd",
						unit_amount: amount,
						recurring: { interval: "month" },
						metadata,
					},
					opts,
				),
			);
			const retrieved = await stripe.prices.retrieve(price.id);
			assert.equal(retrieved.livemode, false);
			assert.equal(retrieved.unit_amount, amount);
			assert.equal(retrieved.metadata.oxy_fixture_nonce, plan.nonce);
			prices.push(price);
			const offer = offers[index === 2 ? 1 : 0];
			catalogue.prices.push({
				priceId: price.id,
				providerAccountId: ACCOUNT,
				mode: "test",
				environment: "test",
				offerId: offer.id,
				offerVersion: 1,
				offerKind: offer.kind,
				kind: "existing_product",
				validFrom: new Date(clock.frozen_time * 1000 - 86400000).toISOString(),
				validUntil: null,
				currency: "usd",
				amountMinorUnits: amount,
			});
		}
		process.env.STRIPE_PRO_PRICE_ID = prices[0].id;
		process.env.STRIPE_BUSINESS_PRICE_ID = prices[1].id;
		process.env.BILLING_PRODUCT_CATALOGUE_FILE = join(
			directory,
			"catalogue.private.json",
		);
		const saveCatalogue = () =>
			privateJson(process.env.BILLING_PRODUCT_CATALOGUE_FILE ?? "", catalogue);
		await saveCatalogue();
		const app = express();
		app.use(
			rateLimit({
				windowMs: 60000,
				limit: 128,
				keyGenerator: () => "owned-local-rehearsal",
			}),
		);
		app.use("/billing/webhook", express.raw({ type: "application/json" }));
		app.use(express.json());
		const billingModule = await import("../src/routes/billing.js");
		let billingRoutes: unknown = billingModule.default;
		if (billingRoutes && typeof billingRoutes === "object")
			billingRoutes = Reflect.get(billingRoutes, "default");
		assert.ok(typeof billingRoutes === "function");
		const realRouter = billingRoutes;
		const mount: express.RequestHandler = (req, res, next) =>
			realRouter(req, res, next);
		app.use("/billing", mount);
		server = http.createServer(app);
		await new Promise<void>((resolveListen) =>
			server?.listen(0, "127.0.0.1", resolveListen),
		);
		const sessionId = randomUUID();
		const deviceId = `fixture-${plan.nonce}`;
		const tokens = generateSessionTokens({
			subjectAccountId: payer,
			principalUserId: payer,
			sessionId,
			deviceId,
		});
		await db.insert(sessions).values({
			userId: payer,
			sessionId,
			deviceId,
			deviceType: "web",
			platform: "sandbox",
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: new Date(Date.now() + 3600000),
			isActive: true,
		});
		async function subscribe(
			index: number,
			step: string,
			discounts?: Stripe.SubscriptionCreateParams.Discount[],
		) {
			assert.ok(
				observedPaid + (prices[index].unit_amount ?? MAX_PAID + 1) <= MAX_PAID,
				"Creation would exceed synthetic budget",
			);
			const subscription = await create("subscription", step, (opts) =>
				stripe.subscriptions.create(
					{
						customer: customer.id,
						items: [{ price: prices[index].id }],
						default_payment_method: pm.id,
						payment_behavior: "error_if_incomplete",
						metadata,
						...(discounts ? { discounts } : {}),
					},
					opts,
				),
			);
			const current = await stripe.subscriptions.retrieve(subscription.id);
			assert.equal(current.livemode, false);
			assert.equal(current.metadata.oxy_fixture_nonce, plan.nonce);
			catalogue.subscriptions.push({
				providerSubscriptionId: current.id,
				providerAccountId: ACCOUNT,
				mode: "test",
				environment: "test",
				payerAccountId: payer,
				beneficiaryAccountId: beneficiary,
			});
			await saveCatalogue();
			return current;
		}
		phase = "initialPaidInvoice";
		const creditSub = await subscribe(0, "credit-subscription");
		const baseInvoice = await paidInvoice(
			ref(creditSub.latest_invoice),
			customer.id,
		);
		const baseEvent = await providerEvent("invoice.paid", baseInvoice.id);
		await deliver(baseEvent);
		await deliver(baseEvent);
		assert.equal((await grants(baseInvoice.id)).length, 1);
		assert.equal(await balance(payer), 10000);
		const baseAccessEvidence = await db
			.select()
			.from(accessProviderPeriods)
			.where(eq(accessProviderPeriods.invoiceId, baseInvoice.id));
		assert.equal(baseAccessEvidence.length, 1);
		const baseAccessGrants = await db
			.select()
			.from(accessGrants)
			.where(eq(accessGrants.sourceSegmentId, baseAccessEvidence[0].segmentId));
		assert.equal(baseAccessGrants.length, 1);
		assert.equal(baseAccessGrants[0].beneficiaryAccountId, beneficiary);
		check("initial combined award and delivery replay", {
			invoiceId: baseInvoice.id,
			credits: 10000,
			beneficiaryDiffersFromPayer: true,
		});
		phase = "trackedSpend";
		const spendOperationId = randomUUID();
		check("spend operation identity", { spendOperationId });
		await persist();
		options("local-spend");
		assert.equal(
			await spendSubscriptionTrackedCredits(db, payer, 6000, spendOperationId),
			true,
		);
		assert.equal(
			await spendSubscriptionTrackedCredits(db, payer, 6000, spendOperationId),
			true,
		);
		assert.equal(await balance(payer), 4000);
		check("canonical tracked FIFO spend replay", {
			spent: 6000,
			remaining: 4000,
		});

		phase = "paidProration";
		const initialItem = creditSub.items.data[0];
		assert.ok(initialItem);
		assert.equal(creditSub.items.has_more, false);
		const halfway =
			initialItem.current_period_start +
			Math.floor(
				(initialItem.current_period_end - initialItem.current_period_start) / 2,
			);
		await stripe.testHelpers.testClocks.advance(
			clock.id,
			{ frozen_time: halfway },
			options("clock-half"),
		);
		await waitFor("clock ready", async () => {
			const value = await stripe.testHelpers.testClocks.retrieve(clock.id);
			return value.status === "ready" ? value : null;
		});
		assert.ok(
			observedPaid + 9999 <= MAX_PAID,
			"Upgrade would exceed synthetic budget",
		);
		const upgrade = await stripe.subscriptions.update(
			creditSub.id,
			{
				items: [{ id: initialItem.id, price: prices[1].id }],
				proration_behavior: "always_invoice",
				payment_behavior: "error_if_incomplete",
			},
			options("upgrade"),
		);
		const upgradeInvoice = await paidInvoice(
			ref(upgrade.latest_invoice),
			customer.id,
		);
		assert.notEqual(upgradeInvoice.id, baseInvoice.id);
		const lines = await stripe.invoices.listLineItems(upgradeInvoice.id, {
			limit: 100,
		});
		assert.equal(lines.has_more, false);
		const positive = lines.data.filter(
			(line) =>
				line.amount > 0 &&
				line.parent?.subscription_item_details?.proration === true,
		);
		assert.equal(positive.length, 1);
		const expectedProrata = Number(
			(BigInt(40000) *
				BigInt(positive[0].period.end - positive[0].period.start)) /
				BigInt(
					initialItem.current_period_end - initialItem.current_period_start,
				),
		);
		const upgradeEvent = await providerEvent("invoice.paid", upgradeInvoice.id);
		await deliver(upgradeEvent);
		await deliver(upgradeEvent);
		const upgradeGrants = await grants(upgradeInvoice.id);
		assert.equal(upgradeGrants.length, 1);
		assert.equal(upgradeGrants[0].granted, expectedProrata);
		assert.equal(await balance(payer), 4000 + expectedProrata);
		check("paid P1 proration and replay", {
			invoiceId: upgradeInvoice.id,
			expectedCredits: expectedProrata,
			oracle: "independent integer prorata from retrieved line period",
		});

		phase = "partialAndFullRefund";
		const payments = await stripe.invoicePayments.list({
			invoice: baseInvoice.id,
			limit: 100,
		});
		assert.equal(payments.has_more, false);
		assert.equal(payments.data.length, 1);
		const paymentIntentId = payments.data[0].payment.payment_intent;
		assert.ok(paymentIntentId);
		const paymentIntent = await stripe.paymentIntents.retrieve(
			ref(paymentIntentId),
		);
		const chargeId = ref(paymentIntent.latest_charge);
		const half = Math.floor(baseInvoice.amount_paid / 2);
		await create("refund", "refund-half", (opts) =>
			stripe.refunds.create({ charge: chargeId, amount: half, metadata }, opts),
		);
		const halfEvent = await providerEvent(
			"charge.refunded",
			chargeId,
			(object) => object.amount_refunded === half,
		);
		await deliver(halfEvent);
		await deliver(halfEvent);
		const expectedClaw = Math.min(
			4000,
			Number((BigInt(10000) * BigInt(half)) / BigInt(baseInvoice.amount_paid)),
		);
		assert.equal(await balance(payer), 4000 + expectedProrata - expectedClaw);
		await create("refund", "refund-full", (opts) =>
			stripe.refunds.create(
				{ charge: chargeId, amount: baseInvoice.amount_paid - half, metadata },
				opts,
			),
		);
		const fullEvent = await providerEvent(
			"charge.refunded",
			chargeId,
			(object) => object.amount_refunded === baseInvoice.amount_paid,
		);
		await deliver(fullEvent);
		await deliver(fullEvent);
		await deliver(halfEvent);
		const [baseGrant] = await grants(baseInvoice.id);
		assert.equal(baseGrant.consumed, 6000);
		assert.equal(baseGrant.clawed, 4000);
		assert.equal(await balance(payer), expectedProrata);
		const [preservedUpgrade] = await grants(upgradeInvoice.id);
		assert.equal(preservedUpgrade.clawed, 0);
		check(
			"partial then 100% cumulative refund, old delivery and unused-only clawback",
			{
				invoiceId: baseInvoice.id,
				consumed: 6000,
				clawed: 4000,
				preservedOtherGrant: preservedUpgrade.granted,
			},
		);

		phase = "nextPaidPeriod";
		assert.ok(
			observedPaid + 9999 <= MAX_PAID,
			"Renewal would exceed synthetic budget",
		);
		await stripe.testHelpers.testClocks.advance(
			clock.id,
			{ frozen_time: initialItem.current_period_end + 60 },
			options("clock-renewal"),
		);
		await waitFor("renewal clock ready", async () => {
			const value = await stripe.testHelpers.testClocks.retrieve(clock.id);
			return value.status === "ready" ? value : null;
		});
		const renewed = await stripe.subscriptions.retrieve(creditSub.id);
		// The clock creates the next real invoice. Finalize/pay only that owned test
		// invoice explicitly; do not depend on the account's webhook delay settings.
		let renewalPending = await stripe.invoices.retrieve(
			ref(renewed.latest_invoice),
		);
		assert.equal(renewalPending.livemode, false);
		assert.equal(ref(renewalPending.customer), customer.id);
		assert.equal(
			ref(renewalPending.parent?.subscription_details?.subscription ?? null),
			creditSub.id,
		);
		assert.notEqual(renewalPending.id, upgradeInvoice.id);
		assert.equal(renewalPending.currency, "usd");
		assert.ok(
			renewalPending.amount_due >= 0 &&
				observedPaid + renewalPending.amount_due <= MAX_PAID,
		);
		if (renewalPending.status === "draft")
			renewalPending = await stripe.invoices.finalizeInvoice(
				renewalPending.id,
				{ auto_advance: false },
				options("finalize-renewal"),
			);
		if (renewalPending.status === "open")
			await stripe.invoices.pay(
				renewalPending.id,
				{ payment_method: pm.id },
				options("pay-renewal"),
			);
		const renewalInvoice = await paidInvoice(
			ref(renewed.latest_invoice),
			customer.id,
		);
		assert.notEqual(renewalInvoice.id, upgradeInvoice.id);
		const renewalEvent = await providerEvent("invoice.paid", renewalInvoice.id);
		await deliver(renewalEvent);
		await deliver(renewalEvent);
		await deliver(baseEvent);
		const [renewalGrant] = await grants(renewalInvoice.id);
		assert.equal(renewalGrant.granted, 50000);
		assert.equal(await balance(payer), expectedProrata + 50000);
		check("next paid period renewal and old invoice replay", {
			invoiceId: renewalInvoice.id,
			credits: 50000,
		});

		phase = "bundleIndividualCancellation";
		const bundle = await subscribe(2, "bundle-subscription");
		const individual = await subscribe(3, "individual-subscription");
		for (const subscription of [bundle, individual]) {
			const invoice = await paidInvoice(
				ref(subscription.latest_invoice),
				customer.id,
			);
			const event = await providerEvent("invoice.paid", invoice.id);
			await deliver(event);
			await deliver(event);
			assert.equal((await grants(invoice.id)).length, 0);
		}
		const [source] = await db
			.select()
			.from(accessSubscriptionSources)
			.where(
				eq(accessSubscriptionSources.providerSubscriptionId, individual.id),
			);
		assert.ok(source);
		const beforeSources = await db
			.select()
			.from(accessSubscriptionSources)
			.where(eq(accessSubscriptionSources.beneficiaryAccountId, beneficiary));
		const response = await fetch(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/billing/product-subscriptions/cancel`,
			{
				method: "POST",
				signal: AbortSignal.timeout(30000),
				headers: {
					authorization: `Bearer ${tokens.accessToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sourceId: source.id,
					expectedSubjectAccountId: payer,
				}),
			},
		);
		assert.equal(
			response.status,
			200,
			"Named cancellation must finish local reconciliation",
		);
		const remoteCancelled = await stripe.subscriptions.retrieve(individual.id);
		assert.equal(remoteCancelled.cancel_at_period_end, true);
		const updateEvent = await providerEvent(
			"customer.subscription.updated",
			individual.id,
			(object) => object.cancel_at_period_end === true,
		);
		await deliver(updateEvent);
		await deliver(updateEvent);
		await deliver(
			await providerEvent("customer.subscription.created", individual.id),
		);
		const unchangedBundle = await stripe.subscriptions.retrieve(bundle.id);
		assert.equal(unchangedBundle.cancel_at_period_end, false);
		const afterSources = await db
			.select()
			.from(accessSubscriptionSources)
			.where(eq(accessSubscriptionSources.beneficiaryAccountId, beneficiary));
		assert.equal(afterSources.length, beforeSources.length);
		const asOf = new Date((initialItem.current_period_end + 60) * 1000);
		const productB = await readSubjectProductAccess(
			beneficiary,
			products[1].id,
			asOf,
		);
		assert.deepEqual(
			productB.quotas.map((quota) => ({
				key: quota.key,
				included: quota.included,
				combination: quota.combination,
			})),
			[{ key: "fixture_slots", included: 5, combination: "maximum" }],
		);
		assert.deepEqual(productB.conflicts, []);
		const productA = await readSubjectProductAccess(
			beneficiary,
			products[0].id,
			asOf,
		);
		assert.equal(productA.quotas[0]?.included, 5);
		assert.equal(productA.quotas[0]?.combination, "maximum");
		assert.deepEqual(productA.conflicts, []);
		assert.deepEqual(
			(await readSubjectProductAccess(payer, products[1].id, asOf)).quotas,
			[],
		);
		assert.equal(await balance(payer), expectedProrata + 50000);
		check(
			"bundle+individual named cancellation preserves other source, beneficiary and credit balance",
			{
				sourceId: source.id,
				bundleSubscriptionId: bundle.id,
				productAccess: productB,
			},
		);

		phase = "undeclaredZeroInvoice";
		const coupon = await create("coupon", "zero-coupon", (opts) =>
			stripe.coupons.create(
				{
					percent_off: 100,
					duration: "once",
					name: `No-grant sandbox ${plan.nonce}`,
					metadata,
				},
				opts,
			),
		);
		const free = await subscribe(0, "zero-invoice-subscription", [
			{ coupon: coupon.id },
		]);
		const zeroInvoice = await paidInvoice(
			ref(free.latest_invoice),
			customer.id,
		);
		assert.equal(zeroInvoice.amount_paid, 0);
		const zeroEvent = await providerEvent("invoice.paid", zeroInvoice.id);
		await deliver(zeroEvent);
		await deliver(zeroEvent);
		assert.equal((await grants(zeroInvoice.id)).length, 0);
		assert.equal(await balance(payer), expectedProrata + 50000);
		check("undeclared free invoice cannot manufacture a promotion", {
			invoiceId: zeroInvoice.id,
			amountPaid: 0,
			creditGrants: 0,
			activePromotionRegistry: 0,
		});
	} catch (error) {
		primaryError = {
			phase,
			name: error instanceof Error ? error.name : "UnknownError",
			code: error instanceof Stripe.errors.StripeError ? error.code : undefined,
		};
	} finally {
		// No cleanup failure aborts later cleanup. Every mutation is limited to IDs returned by this run.
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolveClose) =>
				server?.close(() => resolveClose()),
			);
		}
		const order: Owned["kind"][] = [
			"subscription",
			"paymentMethod",
			"customer",
			"price",
			"product",
			"coupon",
			"clock",
		];
		for (const kind of order)
			for (const resource of resources
				.filter((value) => value.kind === kind)
				.reverse()) {
				try {
					if (kind === "subscription") {
						const value = await stripe.subscriptions.retrieve(resource.id);
						assert.equal(value.livemode, false);
						assert.equal(value.metadata?.oxy_fixture_nonce, plan.nonce);
						if (value.status !== "canceled")
							await stripe.subscriptions.cancel(
								resource.id,
								{ prorate: false, invoice_now: false },
								options(`cleanup-${resource.step}`),
							);
						assert.equal(
							(await stripe.subscriptions.retrieve(resource.id)).status,
							"canceled",
						);
					} else if (kind === "paymentMethod") {
						const value = await stripe.paymentMethods.retrieve(resource.id);
						assert.equal(value.livemode, false);
						assert.equal(value.metadata?.oxy_fixture_nonce, plan.nonce);
						if (value.customer)
							await stripe.paymentMethods.detach(
								resource.id,
								{},
								options(`cleanup-${resource.step}`),
							);
						assert.equal(
							(await stripe.paymentMethods.retrieve(resource.id)).customer,
							null,
						);
					} else if (kind === "customer") {
						const value = await stripe.customers.retrieve(resource.id);
						if (!value.deleted) {
							assert.equal(value.livemode, false);
							assert.equal(value.metadata?.oxy_fixture_nonce, plan.nonce);
							assert.equal(
								(await stripe.customers.del(resource.id)).deleted,
								true,
							);
						}
					} else if (kind === "price") {
						const value = await stripe.prices.retrieve(resource.id);
						assert.equal(value.livemode, false);
						assert.equal(value.metadata?.oxy_fixture_nonce, plan.nonce);
						await stripe.prices.update(
							resource.id,
							{ active: false },
							options(`cleanup-${resource.step}`),
						);
						assert.equal(
							(await stripe.prices.retrieve(resource.id)).active,
							false,
						);
					} else if (kind === "product") {
						const value = await stripe.products.retrieve(resource.id);
						assert.equal(value.livemode, false);
						assert.equal(value.metadata?.oxy_fixture_nonce, plan.nonce);
						await stripe.products.update(
							resource.id,
							{ active: false },
							options(`cleanup-${resource.step}`),
						);
						assert.equal(
							(await stripe.products.retrieve(resource.id)).active,
							false,
						);
					} else if (kind === "coupon") {
						const value = await stripe.coupons.retrieve(resource.id);
						assert.equal(value.livemode, false);
						assert.equal(value.metadata?.oxy_fixture_nonce, plan.nonce);
						assert.equal((await stripe.coupons.del(resource.id)).deleted, true);
					} else if (kind === "clock") {
						const value = await stripe.testHelpers.testClocks.retrieve(
							resource.id,
						);
						assert.equal(value.name, `oxy1519-${plan.nonce}`);
						assert.equal(
							(await stripe.testHelpers.testClocks.del(resource.id)).deleted,
							true,
						);
					}
					cleanups.push({ kind, id: resource.id, success: true });
				} catch (error) {
					const code =
						error instanceof Stripe.errors.StripeError ? error.code : undefined;
					cleanups.push({
						kind,
						id: resource.id,
						success: code === "resource_missing",
						errorCode: code ?? "local_validation_or_transport",
					});
				}
				try {
					await persist();
				} catch {
					cleanups.push({
						kind: "manifest",
						id: resource.id,
						success: false,
						errorCode: "persist_failed",
					});
				}
			}
		try {
			await closePostgres();
		} catch {
			cleanups.push({
				kind: "localDatabasePool",
				id: owner.database,
				success: false,
				errorCode: "close_failed",
			});
		}
		await persist();
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		console.log(
			JSON.stringify({
				completedChecks: checks.length,
				ownedObjects: resources.length,
				cleanupFailures: cleanups.filter((value) => !value.success).length,
				primaryError,
			}),
		);
	}
	if (primaryError || cleanups.some((value) => !value.success))
		throw new Error(
			"Rehearsal or cleanup incomplete; inspect private manifest",
		);
}
main()
	.finally(() => closePostgres())
	.catch((error) => {
		console.error(
			JSON.stringify({
				failed: true,
				name: error instanceof Error ? error.name : "UnknownError",
				code:
					error instanceof Stripe.errors.StripeError ? error.code : undefined,
			}),
		);
		process.exitCode = 1;
	});
