import {
	EMPTY_PRODUCT_BILLING_CATALOGUE,
	productBillingCatalogueSchema,
} from "../productBillingCatalogue.service";

function fixture() {
	return {
		schemaVersion: 1,
		products: [
			{
				schemaVersion: 1,
				id: "product",
				ownerAccountId: "owner",
				applicationId: "application",
			},
		],
		offers: [
			{
				schemaVersion: 1,
				id: "offer",
				version: 1,
				kind: "bundle",
				benefits: [
					{
						kind: "quota",
						productId: "product",
						key: "uses",
						unit: "request",
						included: 10,
						combination: "maximum",
					},
				],
			},
		],
		prices: [
			{
				priceId: "price_existing",
				providerAccountId: "acct_fixture",
				mode: "live",
				environment: "production",
				offerId: "offer",
				offerVersion: 1,
				validFrom: "2026-01-01T00:00:00.000Z",
				validUntil: null as string | null,
				currency: "usd",
				amountMinorUnits: 100,
				offerKind: "bundle",
				kind: "existing_product",
			},
		],
		subscriptions: [],
	};
}
it("an explicit empty catalogue is inert and a typed versioned bundle has no inferred composition rule", () => {
	expect(
		productBillingCatalogueSchema.parse(EMPTY_PRODUCT_BILLING_CATALOGUE).prices,
	).toEqual([]);
	expect(
		productBillingCatalogueSchema.parse(fixture()).offers[0].benefits[0],
	).toMatchObject({ combination: "maximum" });
	const value = fixture();
	Reflect.deleteProperty(value.offers[0].benefits[0], 'combination');
	expect(() => productBillingCatalogueSchema.parse(value)).toThrow();
});
it("rejects incoherent offer kind, missing product and extra config fields", () => {
	const value = fixture();
	value.prices[0].offerKind = "individual";
	expect(() => productBillingCatalogueSchema.parse(value)).toThrow();
	const missing = fixture();
	missing.products = [];
	expect(() => productBillingCatalogueSchema.parse(missing)).toThrow();
	expect(() =>
		productBillingCatalogueSchema.parse({ ...fixture(), guessedPrice: 2999 }),
	).toThrow();
});
it("historical mappings require nonoverlapping explicit windows, separately per provider namespace", () => {
	const value = fixture();
	value.prices.push({
		...value.prices[0],
		validFrom: "2026-02-01T00:00:00.000Z",
	});
	expect(() => productBillingCatalogueSchema.parse(value)).toThrow();
	value.prices[0].validUntil = "2026-02-01T00:00:00.000Z";
	expect(productBillingCatalogueSchema.parse(value).prices).toHaveLength(2);
	const second = fixture();
	second.prices.push({ ...second.prices[0], providerAccountId: "acct_other" });
	expect(productBillingCatalogueSchema.parse(second).prices).toHaveLength(2);
});
it("Oxy One cannot remap API-credit prices or grant API-credit benefits", () => {
	const previous = process.env.STRIPE_PRO_PRICE_ID;
	process.env.STRIPE_PRO_PRICE_ID = "price_existing";
	try {
		const value = fixture();
		value.prices[0].kind = "oxy_one";
		expect(() => productBillingCatalogueSchema.parse(value)).toThrow();
		value.prices[0].priceId = "price_separate";
		value.offers[0].benefits[0].unit = "api_credit";
		expect(() => productBillingCatalogueSchema.parse(value)).toThrow();
	} finally {
		if (previous === undefined)
			Reflect.deleteProperty(process.env, "STRIPE_PRO_PRICE_ID");
		else process.env.STRIPE_PRO_PRICE_ID = previous;
	}
});
it("unreviewed subscription assignment and duplicate price/offer identities fail closed", () => {
	const value = fixture();
	value.offers.push(value.offers[0]);
	expect(() => productBillingCatalogueSchema.parse(value)).toThrow();
	const subscription = {
		providerSubscriptionId: "sub_fixture",
		providerAccountId: "acct_fixture",
		payerAccountId: "payer",
		beneficiaryAccountId: "beneficiary",
	};
	expect(() =>
		productBillingCatalogueSchema.parse({
			...fixture(),
			subscriptions: [subscription, subscription],
		}),
	).toThrow();
	expect(() =>
		productBillingCatalogueSchema.parse({
			...fixture(),
			subscriptions: [{ ...subscription, inferredFromMetadata: true }],
		}),
	).toThrow();
});
