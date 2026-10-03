/** Backend configuration only: explicit versioned catalogue, never guessed from plan names. */
import { readFile } from "node:fs/promises";
import {
	productDefinitionSchema,
	productOfferSchema,
	productSubscriptionSourceSchema,
} from "@oxy.so/contracts";
import type Stripe from "stripe";
import { z } from "zod";
import { getStripe } from "../utils/stripeClient";
import type { ProductProviderPeriodInput } from "./productProviderEvidence.service";
import {
	allInvoiceLines,
	stripeReference,
	subscriptionProcessorBinding,
} from "./stripeSubscriptionEvidence.service";

const id = z.string().min(1).max(160);
const priceSchema = z
	.object({
		priceId: id,
		providerAccountId: z.string().regex(/^acct_[a-zA-Z0-9_]+$/),
		mode: z.literal("live"),
		environment: z.literal("production"),
		offerId: id,
		offerVersion: z.number().int().positive().safe(),
		validFrom: z.string().datetime(),
		validUntil: z.string().datetime().nullable(),
		currency: z.string().regex(/^[a-z]{3}$/),
		amountMinorUnits: z.number().int().positive().safe(),
		/** API credit purchase is a separate existing product, never an Oxy One benefit. */
		offerKind: z.enum(["individual", "bundle"]),
		kind: z.enum(["existing_product", "oxy_one"]),
	})
	.strict();
export const productBillingCatalogueSchema = z
	.object({
		schemaVersion: z.literal(1),
		products: z.array(productDefinitionSchema),
		offers: z.array(productOfferSchema),
		prices: z.array(priceSchema),
		/** Explicit historical or beneficiary≠payer mappings require reviewed exact IDs. */
		displayNames: z.object({ products: z.record(id, z.string().min(1).max(100)), offers: z.record(id, z.string().min(1).max(100)) }).strict().default({ products: {}, offers: {} }),
    subscriptions: z.array(
			z
				.object({
					providerSubscriptionId: id,
					providerAccountId: id,
					payerAccountId: productSubscriptionSourceSchema.shape.payerAccountId,
					beneficiaryAccountId:
						productSubscriptionSourceSchema.shape.beneficiaryAccountId,
				})
				.strict(),
		),
	})
	.strict()
	.superRefine((value, context) => {
		const products = new Set(value.products.map((product) => product.id));
		const offers = new Map(
			value.offers.map((offer) => [`${offer.id}@${offer.version}`, offer]),
		);
		if (
			products.size !== value.products.length ||
			offers.size !== value.offers.length
		)
			context.addIssue({
				code: "custom",
				message: "Duplicate product or offer identity",
			});
		const prices = new Set<string>();
		for (const binding of value.prices) {
			const key = `${binding.providerAccountId}:${binding.mode}:${binding.environment}:${binding.priceId}`;
			const offer = offers.get(`${binding.offerId}@${binding.offerVersion}`);
			const otherPeriods = value.prices.filter(
				(other) =>
					other !== binding &&
					other.providerAccountId === binding.providerAccountId &&
					other.priceId === binding.priceId,
			);
			const start = Date.parse(binding.validFrom);
			const end =
				binding.validUntil === null
					? Number.POSITIVE_INFINITY
					: Date.parse(binding.validUntil);
			if (
				end <= start ||
				otherPeriods.some(
					(other) =>
						Date.parse(other.validFrom) < end &&
						(other.validUntil === null
							? Number.POSITIVE_INFINITY
							: Date.parse(other.validUntil)) > start,
				)
			)
				context.addIssue({
					code: "custom",
					message: "Price offer effective periods overlap or are invalid",
				});
			if (prices.has(`${key}:${binding.validFrom}`) || !offer)
				context.addIssue({
					code: "custom",
					message: "Duplicate price mapping or missing versioned offer",
				});
			prices.add(`${key}:${binding.validFrom}`);
			if (
				offer &&
				(offer.kind !== binding.offerKind ||
					(binding.kind === "oxy_one" && offer.kind !== "bundle"))
			)
				context.addIssue({
					code: "custom",
					message: "Provider price kind differs from the frozen offer",
				});
			if (offer?.benefits.some((benefit) => !products.has(benefit.productId)))
				context.addIssue({
					code: "custom",
					message: "Offer names an unregistered product",
				});
			if (
				binding.kind === "oxy_one" &&
				[
					process.env.STRIPE_PRO_PRICE_ID,
					process.env.STRIPE_BUSINESS_PRICE_ID,
				].includes(binding.priceId)
			)
				context.addIssue({
					code: "custom",
					message: "Oxy One cannot map an existing API-credit plan price",
				});
			if (
				binding.kind === "oxy_one" &&
				offer?.benefits.some(
					(benefit) =>
						benefit.kind === "quota" &&
						(benefit.unit === "api_credit" || benefit.key === "api_credits"),
				)
			)
				context.addIssue({
					code: "custom",
					message: "Oxy One excludes API credits",
				});
		}
		const assignments = new Set<string>();
		for (const subscription of value.subscriptions) {
			const key = `${subscription.providerAccountId}:${subscription.providerSubscriptionId}`;
			if (assignments.has(key))
				context.addIssue({
					code: "custom",
					message: "Ambiguous subscription beneficiary mapping",
				});
			assignments.add(key);
		}
	});
export type ProductBillingCatalogue = z.infer<
	typeof productBillingCatalogueSchema
>;
export const EMPTY_PRODUCT_BILLING_CATALOGUE: ProductBillingCatalogue = {
	schemaVersion: 1,
	products: [],
	offers: [],
	prices: [],
	subscriptions: [], displayNames: { products: {}, offers: {} },
};

/** No client-controlled path, data or defaults. CLI and adapters share this reader. */
export async function loadProductBillingCatalogue(): Promise<ProductBillingCatalogue> {
	const path = process.env.BILLING_PRODUCT_CATALOGUE_FILE;
	if (!path)
		return productBillingCatalogueSchema.parse(EMPTY_PRODUCT_BILLING_CATALOGUE);
	const serialized = await readFile(path, "utf8");
	if (Buffer.byteLength(serialized) > 1024 * 1024)
		throw new Error("Product billing catalogue exceeds its bound");
	return productBillingCatalogueSchema.parse(JSON.parse(serialized));
}

/** Network evidence is gathered before a caller opens the combined award transaction. */
export async function prepareStripeProductPeriod(
	invoice: Stripe.Invoice,
	event: Stripe.Event,
	payerAccountId: string,
	catalogue: ProductBillingCatalogue,
): Promise<ProductProviderPeriodInput | null> {
	if (!catalogue.prices.length) return null;
	if (invoice.status !== "paid" || invoice.amount_paid <= 0) return null;
	const subscriptionId = stripeReference(
		invoice.parent?.subscription_details?.subscription,
	);
	if (!subscriptionId) return null;
	const lines = await allInvoiceLines(invoice);
	const recurring = lines.filter(
		(line) =>
			line.parent?.subscription_item_details?.subscription === subscriptionId &&
			line.amount > 0,
	);
	if (
		!recurring.some((line) =>
			catalogue.prices.some(
				(binding) =>
					binding.priceId ===
					stripeReference(line.pricing?.price_details?.price),
			),
		)
	)
		return null;
	const processor = await subscriptionProcessorBinding(
		invoice.livemode,
		event.account,
	);
	const [, providerAccountId, mode, environment] = z
		.tuple([
			z.literal("stripe"),
			id,
			z.enum(["live", "test"]),
			z.enum(["production", "staging", "test", "development"]),
		])
		.parse(JSON.parse(processor));
	const matches = recurring.flatMap((line) =>
		catalogue.prices
			.filter(
				(binding) =>
					binding.providerAccountId === providerAccountId &&
					binding.mode === mode &&
					binding.environment === environment &&
					binding.priceId ===
						stripeReference(line.pricing?.price_details?.price) &&
					line.period.start * 1000 >= Date.parse(binding.validFrom) &&
					(binding.validUntil === null ||
						line.period.start * 1000 < Date.parse(binding.validUntil)),
			)
			.map((binding) => ({ line, binding })),
	);
	if (recurring.length !== 1 || matches.length !== 1)
		throw new Error(
			"Product invoice price namespace, effective period or mapping is ambiguous",
		);
	const { line, binding } = matches[0];
	if (
		processor !==
		JSON.stringify([
			"stripe",
			binding.providerAccountId,
			binding.mode,
			binding.environment,
		])
	)
		throw new Error("Configured product provider binding differs");
	const price = await getStripe().prices.retrieve(binding.priceId);
	if (
		price.id !== binding.priceId ||
		price.livemode !== invoice.livemode ||
		price.type !== "recurring" ||
		price.currency !== binding.currency ||
		price.unit_amount !== binding.amountMinorUnits ||
		line.quantity !== 1 ||
		invoice.currency !== binding.currency ||
		line.currency !== binding.currency ||
		!Number.isSafeInteger(line.period.start) ||
		!Number.isSafeInteger(line.period.end) ||
		line.period.end <= line.period.start
	)
		throw new Error("Product price, quantity, currency or paid period differs");
	const observed = new Date();
	const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
	if (
		subscription.id !== subscriptionId ||
		subscription.livemode !== invoice.livemode ||
		subscription.items.has_more ||
		subscription.items.data.length !== 1 ||
		stripeReference(subscription.customer) !== stripeReference(invoice.customer)
	)
		throw new Error("Product subscription attribution is ambiguous");
	const item = subscription.items.data[0];
	const assigned = catalogue.subscriptions.find(
		(value) =>
			value.providerAccountId === binding.providerAccountId &&
			value.providerSubscriptionId === subscriptionId,
	);
	if (assigned && assigned.payerAccountId !== payerAccountId)
		throw new Error(
			"Configured historical payer mapping differs from customer authority",
		);
	const offer = catalogue.offers.find(
		(value) =>
			value.id === binding.offerId && value.version === binding.offerVersion,
	);
	if (!offer) throw new Error("Product offer version is missing");
	return {
		binding: {
			providerAccountRef: binding.providerAccountId,
			mode: binding.mode,
			environment: binding.environment,
		},
		subscription: productSubscriptionSourceSchema
			.omit({ id: true })
			.parse({
				schemaVersion: 1,
				beneficiaryAccountId: assigned?.beneficiaryAccountId ?? payerAccountId,
				payerAccountId,
				provider: "stripe",
				providerSubscriptionId: subscriptionId,
				status: subscription.status,
				period: {
					start: new Date(item.current_period_start * 1000).toISOString(),
					end: new Date(item.current_period_end * 1000).toISOString(),
				},
				cancelAtPeriodEnd: subscription.cancel_at_period_end,
			}),
		offer: {
			offerId: offer.id,
			offerVersion: offer.version,
			origin: offer.kind,
		},
		paidLine: {
			invoiceId: invoice.id,
			lineId: line.id,
			priceId: binding.priceId,
			quantity: 1,
			period: {
				start: new Date(line.period.start * 1000).toISOString(),
				end: new Date(line.period.end * 1000).toISOString(),
			},
		},
		event: {
			id: event.id,
			createdAt: new Date(event.created * 1000).toISOString(),
		},
		providerObservedAt: observed,
	};
}
