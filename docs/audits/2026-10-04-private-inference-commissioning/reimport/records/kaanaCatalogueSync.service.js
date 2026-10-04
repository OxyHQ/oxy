"use strict";
/**
 * The automatic Kaana → Oxy model catalogue sync.
 *
 * Owner direction (2026-09-25): Kaana discovers hundreds of real models, and
 * official Oxy products (Alia first) must be able to list and call ALL of them
 * by model id. Nothing hand-curated sits in between. So this job reads Kaana's
 * signed `GET /internal/v1/models`, and for every model line it can describe
 * without inventing a fact it writes the model, its current revision, one
 * deployment per exact Kaana route, a price version from the provider's list
 * price and a price-only routing scorecard. Every route it writes is approved
 * automatically for `platform_internal` use under the `kaana-sync` policy
 * record, and nothing wider: public resale keeps its reviewed process.
 *
 * ## What it never does
 *
 * - **Invent a required fact.** A model with no context window, no maximum
 *   output, no modalities or no list price for a route is SKIPPED and counted,
 *   not filled with a plausible number. A route on a provider Oxy has no
 *   reviewed data-policy row for is skipped the same way.
 * - **Touch a reviewed row.** Rows authored by the reviewed bootstrap or staff
 *   tooling (`catalogue_source = 'reviewed'`, `auto_approval_policy_id IS
 *   NULL`) keep every reviewed fact. The one exception is `reasoning_efforts`
 *   (and the provider's release date), which is a serving capability Kaana
 *   owns, not a legal fact.
 * - **Describe non-text output.** A model producing images, audio, video or
 *   embeddings must declare a content-provenance marking (migration 0050), and
 *   Kaana does not report one. Such lines are skipped; the reviewed speech route
 *   stays reviewed.
 * - **Serve `alia/*`.** That namespace is reserved for first-party releases.
 *
 * ## Retirement
 *
 * A synced deployment Kaana no longer reports is retired (`status` and
 * `permission_state` both `retired`), which removes it from every catalogue
 * read and every route resolution in the same commit. A report that would
 * retire more than half of the synced routes at once is treated as a broken
 * report rather than a mass retirement, unless an operator passes
 * `allowMassRetirement` through the admin trigger.
 *
 * ## Legal-review fields
 *
 * `inference_models` requires licence and provenance columns Kaana cannot
 * know. Synced rows record them conservatively and say so rather than claim
 * a review: {@link SYNCED_LICENSE}. See docs/inference/catalogue.md.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYNCED_LICENSE = exports.KAANA_SYNC_ACTOR = exports.MAX_ROUTINE_RETIREMENT_FRACTION = exports.KAANA_CATALOGUE_SYNC_INTERVAL_MS = void 0;
exports.normalizeDecimal = normalizeDecimal;
exports.parseKaanaCatalogue = parseKaanaCatalogue;
exports.normalizeAcceptedParameters = normalizeAcceptedParameters;
exports.planKaanaModel = planKaanaModel;
exports.syncedUnitPrices = syncedUnitPrices;
exports.syncedPriceScore = syncedPriceScore;
exports.applyKaanaCatalogue = applyKaanaCatalogue;
exports.attestPricedDeployments = attestPricedDeployments;
exports.runKaanaCatalogueSync = runKaanaCatalogueSync;
exports.listCatalogueBlocks = listCatalogueBlocks;
exports.blockCatalogueModel = blockCatalogueModel;
exports.unblockCatalogueModel = unblockCatalogueModel;
exports.startKaanaCatalogueSyncSchedule = startKaanaCatalogueSyncSchedule;
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const node_util_1 = require("node:util");
const contracts_1 = require("@oxy.so/contracts");
const postgres_1 = require("../config/postgres");
const scopedExecution_service_1 = require("./scopedExecution.service");
const schema_1 = require("../db/schema");
const logger_1 = require("../utils/logger");
const httpKaanaClient_1 = require("./httpKaanaClient");
/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */
/** How often the fleet re-reads Kaana. Every task registers; one runs. */
exports.KAANA_CATALOGUE_SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** The first run after boot, so a fresh deploy converges without waiting. */
const KAANA_CATALOGUE_SYNC_FIRST_RUN_DELAY_MS = 60 * 1000;
const KAANA_CATALOGUE_FETCH_TIMEOUT_MS = 60 * 1000;
const SYNC_LOCK_NAMESPACE = 'oxy-kaana-catalogue-sync-v1';
/** A report retiring more than this share of synced routes is presumed broken. */
exports.MAX_ROUTINE_RETIREMENT_FRACTION = 0.5;
/** The `changed_by_user_id` a synced scorecard carries: a system actor, not a person. */
exports.KAANA_SYNC_ACTOR = 'system:kaana-sync';
const LEGAL_EVIDENCE_REF = `auto-approval-policy:${schema_1.KAANA_SYNC_AUTO_APPROVAL_POLICY_ID}`;
const PERMISSION_NOTE = 'Approved automatically by the kaana-sync policy for platform_internal use (official Oxy products). Not approved for public resale.';
const RETIRED_NOTE = 'Retired by the kaana-sync: Kaana no longer reports this exact deployment.';
const BLOCKED_NOTE = 'Retired by the catalogue blocklist.';
const MAX_REPORTED_SKIPS = 200;
/** Kaana's `/internal/v1/deployments/query` accepts at most 64 exact ids. */
const KAANA_ATTESTATION_BATCH = 64;
/**
 * The licence/provenance columns a synced model carries. Nothing here is a
 * review result, and each value is the conservative reading:
 *
 * - `licenseId` is an SPDX `LicenseRef-` naming "the serving provider's terms",
 *   because what governs Oxy's use of a hosted model is the provider agreement,
 *   and the weights' own licence was not reviewed.
 * - `commercialUseAllowed: false` — NOT asserted. A routing policy with
 *   `requireCommercialUseRights` therefore excludes synced routes, which is the
 *   direction a missing review must fail in.
 * - `requiresAttribution: true` — assumed until reviewed.
 * - `releaseKind: 'third_party_hosted'` — every synced route is served by a
 *   third-party provider; open-weight status is not asserted.
 */
exports.SYNCED_LICENSE = {
    licenseId: 'LicenseRef-Oxy-Serving-Provider-Terms',
    licenseDisplayName: "Serving provider's terms (not individually reviewed)",
    commercialUseAllowed: false,
    requiresAttribution: true,
    releaseKind: 'third_party_hosted',
};
const nullish = (schema) => schema.nullish().transform((value) => value !== null && value !== void 0 ? value : undefined);
const kaanaCatalogueResponseSchema = zod_1.z
    .object({
    checkedAt: nullish(zod_1.z.string().max(64)),
    configuration: nullish(zod_1.z.object({ snapshotId: nullish(zod_1.z.string().min(1).max(256)) }).passthrough()),
    models: zod_1.z.array(zod_1.z.unknown()),
    scopedExecutionContractVersion: zod_1.z.literal('3.6.0').optional(),
    deployments: zod_1.z.array(zod_1.z.object({ deploymentId: contracts_1.deploymentIdSchema, modelReference: contracts_1.modelReferenceSchema,
        provider: contracts_1.inferenceProviderSlugSchema, regions: zod_1.z.array(zod_1.z.string()), scopedExecution: contracts_1.scopedExecutionAudienceSchema.optional(),
        keyId: zod_1.z.string().optional(), upstreamModelId: zod_1.z.string().optional(), providerRateCardVersionId: zod_1.z.string().optional(), providerSourceVersion: zod_1.z.string().optional(),
        acceptedParameters: zod_1.z.array(zod_1.z.string()).optional(), }).strict()).optional(),
})
    .passthrough();
const kaanaListPriceSchema = zod_1.z
    .object({
    scopedExecution: contracts_1.scopedExecutionAudienceSchema.optional(),
    deploymentId: contracts_1.deploymentIdSchema,
    provider: contracts_1.inferenceProviderSlugSchema,
    currency: zod_1.z.string(),
    input: zod_1.z.unknown(),
    output: zod_1.z.unknown(),
})
    .passthrough();
const kaanaCatalogueEntrySchema = zod_1.z
    .object({
    model: contracts_1.modelIdSchema,
    modelReference: contracts_1.modelReferenceSchema,
    displayName: nullish(zod_1.z.string().trim().min(1).max(200)),
    createdAt: nullish(zod_1.z.string().datetime({ offset: true })),
    contextTokens: nullish(zod_1.z.number().int().positive().max(2147483647)),
    maxOutputTokens: nullish(zod_1.z.number().int().positive().max(2147483647)),
    inputModalities: nullish(zod_1.z.array(zod_1.z.string())),
    outputModalities: nullish(zod_1.z.array(zod_1.z.string())),
    supportsTools: nullish(zod_1.z.boolean()),
    reasoningEfforts: nullish(zod_1.z.array(zod_1.z.string())),
    acceptedParameters: nullish(zod_1.z.array(zod_1.z.string())),
    providers: nullish(zod_1.z.array(zod_1.z.string())),
    listPrices: nullish(zod_1.z.array(zod_1.z.unknown())),
})
    .passthrough();
/** An exact non-negative decimal with at most 12 fraction digits, or `undefined`. */
function normalizeDecimal(value) {
    const text = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
    if (text === undefined || !/^\d+(\.\d{1,12})?$/.test(text))
        return undefined;
    const [whole, fraction] = text.split('.');
    const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
    const trimmedFraction = (fraction !== null && fraction !== void 0 ? fraction : '').replace(/0+$/, '');
    return trimmedFraction.length === 0 ? trimmedWhole : `${trimmedWhole}.${trimmedFraction}`;
}
function parsePricedRoute(raw) {
    const row = kaanaListPriceSchema.safeParse(raw);
    if (!row.success)
        return undefined;
    const input = normalizeDecimal(row.data.input);
    const output = normalizeDecimal(row.data.output);
    return {
        deploymentId: row.data.deploymentId,
        provider: row.data.provider,
        // Oxy's price versions here are USD; another currency is not converted.
        price: row.data.currency !== 'USD' || input === undefined || output === undefined
            ? 'invalid'
            : { input, output },
    };
}
/**
 * Read Kaana's catalogue body into model lines. Shape errors in ONE entry skip
 * that entry; a body that is not a catalogue at all throws, because an empty
 * parse would otherwise read as "Kaana serves nothing" and retire everything.
 */
function parseKaanaCatalogue(payload) {
    var _a, _b, _c;
    const response = kaanaCatalogueResponseSchema.safeParse(payload);
    if (!response.success) {
        throw new Error('Kaana returned a catalogue body Oxy cannot read (no models array)');
    }
    if (response.data.scopedExecutionContractVersion !== undefined && response.data.deployments === undefined) {
        throw new Error('Negotiated catalogue must declare exact deployment audiences.');
    }
    const deploymentAudience = new Map();
    for (const descriptor of (_a = response.data.deployments) !== null && _a !== void 0 ? _a : []) {
        if (deploymentAudience.has(descriptor.deploymentId))
            throw new Error('Duplicate catalogue deployment identity.');
        deploymentAudience.set(descriptor.deploymentId, descriptor);
    }
    let invalidEntries = 0;
    const models = [];
    for (const rawEntry of response.data.models) {
        const entry = kaanaCatalogueEntrySchema.safeParse(rawEntry);
        if (!entry.success) {
            invalidEntries += 1;
            continue;
        }
        const data = entry.data;
        const listPrices = [];
        let invalidDeployments = 0;
        for (const rawPrice of (_b = data.listPrices) !== null && _b !== void 0 ? _b : []) {
            const priced = parsePricedRoute(rawPrice);
            const descriptor = priced === undefined ? undefined : deploymentAudience.get(priced.deploymentId);
            if (response.data.scopedExecutionContractVersion !== undefined && (descriptor === undefined ||
                descriptor.modelReference !== data.modelReference || descriptor.provider !== (priced === null || priced === void 0 ? void 0 : priced.provider))) {
                invalidDeployments += 1;
                continue;
            }
            if (priced !== undefined && (descriptor === null || descriptor === void 0 ? void 0 : descriptor.scopedExecution) !== undefined) {
                listPrices.push(Object.assign(Object.assign({}, priced), { scopedExecution: descriptor.scopedExecution }));
                continue;
            }
            if (priced === undefined)
                invalidDeployments += 1;
            else
                listPrices.push(priced);
        }
        models.push({
            model: data.model,
            modelReference: data.modelReference,
            displayName: data.displayName,
            createdAt: data.createdAt,
            contextTokens: data.contextTokens,
            maxOutputTokens: data.maxOutputTokens,
            inputModalities: data.inputModalities,
            outputModalities: data.outputModalities,
            supportsTools: data.supportsTools,
            reasoningEfforts: data.reasoningEfforts,
            acceptedParameters: data.acceptedParameters,
            providers: data.providers,
            listPrices,
            invalidDeployments,
        });
    }
    return {
        snapshotId: (_c = response.data.configuration) === null || _c === void 0 ? void 0 : _c.snapshotId,
        checkedAt: response.data.checkedAt,
        models,
        invalidEntries,
    };
}
const KNOWN_MODALITIES = new Set(schema_1.INFERENCE_MODALITIES);
const KNOWN_EFFORTS = new Set(schema_1.MODEL_REASONING_EFFORTS);
const KNOWN_REQUEST_PARAMETERS = new Set(schema_1.DEPLOYMENT_REQUEST_PARAMETERS);
/**
 * A reported accepted-parameter set in Oxy's vocabulary and order. `undefined`
 * (nobody said) stays `null`, never `[]`. A word Oxy does not know is dropped:
 * the edge never checks a control outside its vocabulary, so dropping one
 * cannot make a route refuse anything.
 */
function normalizeAcceptedParameters(values) {
    if (values === undefined)
        return null;
    const reported = new Set(values.filter((value) => KNOWN_REQUEST_PARAMETERS.has(value)));
    return schema_1.DEPLOYMENT_REQUEST_PARAMETERS.filter((parameter) => reported.has(parameter));
}
/**
 * Which accepted-parameter set one exact route is stored with.
 *
 * Per-deployment evidence from Kaana's signed descriptor wins. Otherwise the
 * catalogue entry's set is an INTERSECTION over the line's reporting
 * deployments, which proves what every reporter accepts but not what any one
 * of them refuses; it describes a single route only when every deployment of
 * the line is on one provider, whose one statement about the model is what
 * each of them reported. Anything else is unknown, and unknown filters
 * nothing: a wrong narrowing would refuse a request Kaana could serve.
 */
function acceptedParametersForRoute(entry, deployment) {
    var _a;
    if (deployment.acceptedParameters !== undefined) {
        return normalizeAcceptedParameters(deployment.acceptedParameters);
    }
    const providers = new Set((_a = entry.providers) !== null && _a !== void 0 ? _a : []);
    if (providers.size !== 1 || !providers.has(deployment.provider))
        return null;
    return normalizeAcceptedParameters(entry.acceptedParameters);
}
function knownModalities(values) {
    return [...new Set((values !== null && values !== void 0 ? values : []).filter((value) => KNOWN_MODALITIES.has(value)))].sort();
}
/**
 * Decide what one Kaana model line becomes, without touching the database.
 * `knownProviders` is the set of provider slugs Oxy holds a reviewed
 * data-policy row for.
 */
function planKaanaModel(entry, context) {
    var _a, _b;
    const separator = entry.modelReference.indexOf('@');
    const lineOfReference = separator === -1 ? entry.modelReference : entry.modelReference.slice(0, separator);
    if (separator === -1 || lineOfReference !== entry.model) {
        return { status: 'skipped', reason: 'invalid_entry' };
    }
    if (context.blocked.has(entry.model))
        return { status: 'skipped', reason: 'blocked' };
    const [publisher, slug] = entry.model.split('/');
    if (publisher === schema_1.RESERVED_FIRST_PARTY_PUBLISHER) {
        return { status: 'skipped', reason: 'reserved_namespace' };
    }
    if (entry.contextTokens === undefined)
        return { status: 'skipped', reason: 'missing_context_tokens' };
    if (entry.maxOutputTokens === undefined)
        return { status: 'skipped', reason: 'missing_max_output_tokens' };
    const inputModalities = knownModalities(entry.inputModalities);
    const outputModalities = knownModalities(entry.outputModalities);
    if (inputModalities.length === 0 || outputModalities.length === 0) {
        return { status: 'skipped', reason: 'missing_modalities' };
    }
    if (outputModalities.some((modality) => modality !== 'text')) {
        return { status: 'skipped', reason: 'non_text_output_unreviewed' };
    }
    if (entry.listPrices.length === 0 && entry.invalidDeployments === 0) {
        // Kaana names deployments only through their published price; a line no
        // provider prices cannot be charged for, so it is not offered.
        return { status: 'skipped', reason: 'no_priced_route' };
    }
    const routeSkips = Array.from({ length: entry.invalidDeployments }, () => 'invalid_descriptor');
    const routes = [];
    const seenProviders = new Set();
    const seenDeploymentIds = new Set();
    for (const priced of [...entry.listPrices].sort((a, b) => a.deploymentId < b.deploymentId ? -1 : a.deploymentId > b.deploymentId ? 1 : 0)) {
        const deployment = context.attested.get(priced.deploymentId);
        if (deployment === undefined ||
            deployment.provider !== priced.provider ||
            deployment.modelReference !== entry.modelReference) {
            routeSkips.push('unattested_route');
            continue;
        }
        if (!context.knownProviders.has(deployment.provider)) {
            routeSkips.push('unknown_provider');
            continue;
        }
        if ((priced.scopedExecution === undefined) !== (deployment.scopedExecution === undefined) ||
            (priced.scopedExecution !== undefined && (0, contracts_1.canonicalScopedExecutionJson)(priced.scopedExecution) !== (0, contracts_1.canonicalScopedExecutionJson)(deployment.scopedExecution))) {
            routeSkips.push('unattested_route');
            continue;
        }
        if (deployment.scopedExecution !== undefined && (deployment.keyId !== deployment.scopedExecution.keyId ||
            deployment.upstreamModelId !== deployment.scopedExecution.upstreamModelId ||
            deployment.providerRateCardVersionId !== deployment.scopedExecution.providerRateCardVersionId ||
            deployment.providerSourceVersion !== deployment.scopedExecution.providerSourceVersion ||
            deployment.deploymentId !== deployment.scopedExecution.deploymentId ||
            deployment.modelReference !== deployment.scopedExecution.modelReference ||
            deployment.provider !== deployment.scopedExecution.provider)) {
            routeSkips.push('unattested_route');
            continue;
        }
        const price = priced.price;
        if (price === 'invalid') {
            routeSkips.push('invalid_list_price');
            continue;
        }
        // One deployment per revision × provider × scope is a database invariant;
        // a second report of the same pair cannot be stored beside the first.
        if (seenProviders.has(deployment.provider) || seenDeploymentIds.has(deployment.deploymentId)) {
            routeSkips.push('duplicate_route');
            continue;
        }
        seenProviders.add(deployment.provider);
        seenDeploymentIds.add(deployment.deploymentId);
        routes.push(Object.assign(Object.assign({ deploymentId: deployment.deploymentId, provider: deployment.provider, regions: deployment.regions, price }, (deployment.scopedExecution === undefined ? {} : { scopedExecution: deployment.scopedExecution })), { acceptedParameters: acceptedParametersForRoute(entry, deployment) }));
    }
    if (routes.length === 0)
        return { status: 'skipped', reason: 'no_priced_route', routeSkips };
    const reasoningEfforts = schema_1.MODEL_REASONING_EFFORTS.filter((effort) => { var _a; return ((_a = entry.reasoningEfforts) !== null && _a !== void 0 ? _a : []).some((value) => value === effort && KNOWN_EFFORTS.has(value)); });
    const providerReleasedAt = entry.createdAt === undefined ? null : new Date(entry.createdAt);
    return {
        status: 'planned',
        model: {
            modelId: entry.model,
            publisher,
            slug,
            revision: entry.modelReference.slice(separator + 1),
            modelReference: entry.modelReference,
            displayName: (_a = entry.displayName) !== null && _a !== void 0 ? _a : slug,
            providerReleasedAt,
            maxContextTokens: entry.contextTokens,
            // A model cannot emit more than its window; a report claiming otherwise is
            // clamped to the window rather than trusted to size a hold past it.
            maxOutputTokens: Math.min(entry.maxOutputTokens, entry.contextTokens),
            inputModalities,
            outputModalities,
            supportsTools: (_b = entry.supportsTools) !== null && _b !== void 0 ? _b : false,
            reasoningEfforts,
            routes,
            routeSkips,
        },
    };
}
/**
 * The unit prices a synced route is charged at, from the provider list price.
 *
 * Every unit Kaana can report is priced, because an unpriced unit makes a
 * request unquotable: cached input at the full input rate and reasoning at the
 * output rate (the conservative reading when a provider publishes no discount),
 * and `requests` explicitly zero, since Kaana reports `requests: 1` per attempt.
 */
function syncedUnitPrices(price) {
    return [
        { unit: 'cached_input_tokens', amount: price.input, per: 1000000 },
        { unit: 'input_tokens', amount: price.input, per: 1000000 },
        { unit: 'output_tokens', amount: price.output, per: 1000000 },
        { unit: 'reasoning_tokens', amount: price.output, per: 1000000 },
        { unit: 'requests', amount: '0', per: 1 },
    ];
}
/**
 * The `price` routing score: higher is cheaper. Minus the list price of one
 * million input plus one million output tokens, in US cents, clamped to the
 * column's range. It is a ranking key between routes of one model, not money.
 */
function syncedPriceScore(price) {
    const cents = Math.round((Number(price.input) + Number(price.output)) * 100);
    return -Math.min(Math.max(cents, 0), 1000000);
}
function bump(record, key) {
    var _a;
    record[key] = ((_a = record[key]) !== null && _a !== void 0 ? _a : 0) + 1;
}
function sameUnitPrices(actual, expected) {
    const key = (rows) => rows
        .map((row) => { var _a; return `${row.unit}:${(_a = normalizeDecimal(row.amount)) !== null && _a !== void 0 ? _a : row.amount}:${Number(row.per)}`; })
        .sort()
        .join('|');
    return key(actual) === key(expected);
}
/** Find-or-publish the active price version for one route; supersede on change. */
function ensureSyncedPrice(tx, modelReference, provider, price, now, counts, scopedExecution) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        if (scopedExecution !== undefined) {
            const reviewed = (0, scopedExecution_service_1.sourceReviewedScopedAudience)();
            if (reviewed === undefined || (0, contracts_1.canonicalScopedExecutionJson)(reviewed) !== (0, contracts_1.canonicalScopedExecutionJson)(scopedExecution))
                return undefined;
        }
        const expected = syncedUnitPrices(price);
        const [active] = yield tx
            .select({ id: schema_1.priceVersions.id, currency: schema_1.priceVersions.currency,
            effectiveFrom: schema_1.priceVersions.effectiveFrom, effectiveUntil: schema_1.priceVersions.effectiveUntil })
            .from(schema_1.priceVersions)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.priceVersions.modelReference, modelReference), (0, drizzle_orm_1.eq)(schema_1.priceVersions.provider, provider), (0, drizzle_orm_1.eq)(schema_1.priceVersions.status, 'active')))
            .for('update');
        if (active !== undefined) {
            const units = yield tx
                .select({
                unit: schema_1.priceVersionUnitPrices.unit,
                amount: schema_1.priceVersionUnitPrices.amount,
                per: schema_1.priceVersionUnitPrices.per,
            })
                .from(schema_1.priceVersionUnitPrices)
                .where((0, drizzle_orm_1.eq)(schema_1.priceVersionUnitPrices.priceVersionId, active.id));
            if (scopedExecution !== undefined) {
                // A scoped import cannot replace, rename or reprice an existing version.
                return active.id === scopedExecution.priceVersionId && active.currency === 'USD' &&
                    active.effectiveFrom <= now && active.effectiveUntil === null && sameUnitPrices(units, expected)
                    ? active.id : undefined;
            }
            if (sameUnitPrices(units, expected))
                return active.id;
            // A changed list price never rewrites a published version: receipts
            // settled under it stay explainable. It is superseded, and a new one starts.
            yield tx
                .update(schema_1.priceVersions)
                .set({ status: 'superseded', effectiveUntil: now })
                .where((0, drizzle_orm_1.eq)(schema_1.priceVersions.id, active.id));
        }
        if (scopedExecution !== undefined) {
            const [collision] = yield tx.select({ id: schema_1.priceVersions.id }).from(schema_1.priceVersions)
                .where((0, drizzle_orm_1.eq)(schema_1.priceVersions.id, scopedExecution.priceVersionId)).for('update');
            if (collision !== undefined)
                return undefined;
        }
        const [created] = yield tx
            .insert(schema_1.priceVersions)
            .values(Object.assign(Object.assign({}, (scopedExecution === undefined ? {} : { id: scopedExecution.priceVersionId })), { status: 'active', modelReference,
            provider, currency: 'USD', effectiveFrom: now, effectiveUntil: null, supersedesPriceVersionId: (_a = active === null || active === void 0 ? void 0 : active.id) !== null && _a !== void 0 ? _a : null }))
            .returning({ id: schema_1.priceVersions.id });
        if (created === undefined)
            throw new Error(`price version for ${modelReference}:${provider} was not created`);
        yield tx
            .insert(schema_1.priceVersionUnitPrices)
            .values(expected.map((unit) => (Object.assign({ priceVersionId: created.id }, unit))));
        counts.priceVersionsCreated += 1;
        return created.id;
    });
}
/** Keep the route's price-only scorecard aligned with its price version. */
function ensureSyncedScorecard(tx, deploymentId, priceVersionId, price, evidenceRef, now, counts) {
    return __awaiter(this, void 0, void 0, function* () {
        const priceScore = syncedPriceScore(price);
        const [existing] = yield tx
            .select({
            priceVersionId: schema_1.inferenceDeploymentRoutingScores.priceVersionId,
            priceScore: schema_1.inferenceDeploymentRoutingScores.priceScore,
            changedByUserId: schema_1.inferenceDeploymentRoutingScores.changedByUserId,
        })
            .from(schema_1.inferenceDeploymentRoutingScores)
            .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeploymentRoutingScores.deploymentId, deploymentId))
            .for('update');
        if (existing !== undefined &&
            existing.priceVersionId === priceVersionId &&
            existing.priceScore === priceScore) {
            return;
        }
        // Latency, throughput and balanced are left unscored (NULL) and immediately
        // stale: Kaana publishes no comparable measurement, and a neutral number would
        // be a claim. The internal default ranks on `price`, which needs neither.
        const card = {
            priceScore,
            priceSource: 'cost_model',
            priceEvidenceRef: evidenceRef,
            priceVersionId,
            latencyScore: null,
            latencySource: 'reviewed_scorecard',
            latencyEvidenceRef: 'not-measured:kaana-sync',
            latencyMeasurementWindowStart: now,
            latencyMeasurementWindowEnd: now,
            latencyValidUntil: now,
            throughputScore: null,
            throughputSource: 'reviewed_scorecard',
            throughputEvidenceRef: 'not-measured:kaana-sync',
            throughputMeasurementWindowStart: now,
            throughputMeasurementWindowEnd: now,
            throughputValidUntil: now,
            balancedScore: null,
            balancedSource: 'cost_model',
            balancedEvidenceRef: 'not-computed:kaana-sync',
            balancedFormulaRef: 'none:kaana-sync-price-only',
            balancedValidUntil: now,
            fundingRemaining: null,
            fundingRemainingUnit: null,
            fundingObservedAt: null,
            fundingValidUntil: null,
            reason: 'Kaana sync: price score from the provider list price; no measured latency or throughput.',
            changedByUserId: exports.KAANA_SYNC_ACTOR,
        };
        if (existing === undefined) {
            yield tx.insert(schema_1.inferenceDeploymentRoutingScores).values(Object.assign(Object.assign({ deploymentId }, card), { fundingClass: 'standard_payg', fundingState: 'available', fundingEvidenceRef: evidenceRef, changedAt: now }));
        }
        else {
            yield tx
                .update(schema_1.inferenceDeploymentRoutingScores)
                .set(Object.assign(Object.assign({}, card), { fundingClass: 'standard_payg', fundingState: 'available', fundingEvidenceRef: evidenceRef, changedAt: now }))
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeploymentRoutingScores.deploymentId, deploymentId));
        }
        yield tx.insert(schema_1.inferenceDeploymentRoutingScoreEvents).values(Object.assign(Object.assign({ deploymentId }, card), { fundingClass: 'standard_payg', fundingState: 'available', fundingEvidenceRef: evidenceRef, createdAt: now }));
        counts.scorecardsWritten += 1;
    });
}
/** Retire synced deployments by primary key. */
function retireSyncedDeployments(tx, ids, note, now) {
    return __awaiter(this, void 0, void 0, function* () {
        if (ids.length === 0)
            return 0;
        const retired = yield tx
            .update(schema_1.inferenceDeployments)
            .set({
            status: 'retired',
            permissionState: 'retired',
            permissionStateChangedAt: now,
            permissionStateChangedByUserId: null,
            permissionStateNote: note,
        })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.inArray)(schema_1.inferenceDeployments.id, [...ids]), (0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.autoApprovalPolicyId, schema_1.KAANA_SYNC_AUTO_APPROVAL_POLICY_ID)))
            .returning({ id: schema_1.inferenceDeployments.id });
        return retired.length;
    });
}
/** Write one planned model line. Returns the exact deployment ids it holds. */
function applyPlannedModel(tx, planned, providers, evidenceRef, now, counts) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        yield tx
            .insert(schema_1.inferencePublishers)
            .values({ slug: planned.publisher, displayName: planned.publisher })
            .onConflictDoNothing({ target: schema_1.inferencePublishers.slug });
        const [existing] = yield tx
            .select()
            .from(schema_1.inferenceModels)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.inferenceModels.publisherSlug, planned.publisher), (0, drizzle_orm_1.eq)(schema_1.inferenceModels.slug, planned.slug)))
            .for('update');
        if (existing !== undefined && existing.catalogueSource !== 'kaana_sync') {
            // A reviewed line keeps every reviewed fact and every reviewed route; Kaana
            // may only keep its serving capabilities current.
            yield tx
                .update(schema_1.inferenceModels)
                .set(Object.assign({ reasoningEfforts: [...planned.reasoningEfforts] }, (planned.providerReleasedAt === null ? {} : { providerReleasedAt: planned.providerReleasedAt })))
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceModels.id, existing.id));
            counts.reviewedUntouched += 1;
            return [];
        }
        const modelFacts = {
            displayName: planned.displayName,
            inputModalities: [...planned.inputModalities],
            outputModalities: [...planned.outputModalities],
            supportsTools: planned.supportsTools,
            supportsParallelToolCalls: false,
            supportsStructuredOutput: false,
            supportsJsonMode: false,
            supportsReasoning: planned.reasoningEfforts.length > 0,
            // Every text route Kaana executes streams: its adapters emit the normalized
            // event stream whatever the envelope's `stream` flag says.
            supportsStreaming: true,
            supportsPromptCaching: false,
            maxContextTokens: planned.maxContextTokens,
            maxOutputTokens: planned.maxOutputTokens,
            reasoningEfforts: [...planned.reasoningEfforts],
            providerReleasedAt: planned.providerReleasedAt,
        };
        const modelFactsUnchanged = existing !== undefined && Object.entries(modelFacts)
            .every(([key, value]) => (0, node_util_1.isDeepStrictEqual)(existing[key], value));
        let modelRowId;
        if (existing === undefined) {
            const [created] = yield tx
                .insert(schema_1.inferenceModels)
                .values(Object.assign(Object.assign({ publisherSlug: planned.publisher, slug: planned.slug }, modelFacts), { licenseId: exports.SYNCED_LICENSE.licenseId, licenseDisplayName: exports.SYNCED_LICENSE.licenseDisplayName, commercialUseAllowed: exports.SYNCED_LICENSE.commercialUseAllowed, requiresAttribution: exports.SYNCED_LICENSE.requiresAttribution, releaseKind: exports.SYNCED_LICENSE.releaseKind, catalogueSource: 'kaana_sync' }))
                .returning({ id: schema_1.inferenceModels.id });
            if (created === undefined)
                throw new Error(`model ${planned.modelId} was not created`);
            modelRowId = created.id;
            counts.modelsCreated += 1;
        }
        else {
            modelRowId = existing.id;
            yield tx.update(schema_1.inferenceModels).set(modelFacts).where((0, drizzle_orm_1.eq)(schema_1.inferenceModels.id, modelRowId));
        }
        let [revision] = yield tx
            .select({ id: schema_1.inferenceModelRevisions.id, isCurrent: schema_1.inferenceModelRevisions.isCurrent })
            .from(schema_1.inferenceModelRevisions)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.inferenceModelRevisions.modelId, modelRowId), (0, drizzle_orm_1.eq)(schema_1.inferenceModelRevisions.revision, planned.revision)))
            .for('update');
        if (revision === undefined) {
            // `released_at` of an observed revision is when Oxy first observed it:
            // Kaana names revisions by observation, and a provider's model creation
            // date describes the line, not these weights.
            [revision] = yield tx
                .insert(schema_1.inferenceModelRevisions)
                .values({ modelId: modelRowId, revision: planned.revision, isCurrent: false, releasedAt: now })
                .returning({ id: schema_1.inferenceModelRevisions.id, isCurrent: schema_1.inferenceModelRevisions.isCurrent });
            if (revision === undefined)
                throw new Error(`revision ${planned.modelReference} was not created`);
        }
        if (!revision.isCurrent) {
            yield tx
                .update(schema_1.inferenceModelRevisions)
                .set({ isCurrent: false })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.inferenceModelRevisions.modelId, modelRowId), (0, drizzle_orm_1.eq)(schema_1.inferenceModelRevisions.isCurrent, true)));
            yield tx
                .update(schema_1.inferenceModelRevisions)
                .set({ isCurrent: true })
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceModelRevisions.id, revision.id));
        }
        const revisionId = revision.id;
        const held = [];
        for (const route of planned.routes) {
            const provider = providers.get(route.provider);
            if (provider === undefined) {
                bump(counts.deploymentSkips, 'unknown_provider');
                continue;
            }
            const byId = yield tx
                .select()
                .from(schema_1.inferenceDeployments)
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.internalRouteId, route.deploymentId))
                .for('update');
            const reviewedAudience = route.scopedExecution === undefined ? undefined : (0, scopedExecution_service_1.sourceReviewedScopedAudience)(now.getTime());
            const reviewedPrivateImport = reviewedAudience !== undefined &&
                (0, contracts_1.canonicalScopedExecutionJson)(reviewedAudience) === (0, contracts_1.canonicalScopedExecutionJson)(route.scopedExecution);
            const managedPrivate = (row) => reviewedPrivateImport &&
                row.autoApprovalPolicyId === null && row.scopedExecution !== null &&
                row.availabilityScope === 'platform_internal' && row.permissionState === 'pending_review' && row.status === 'disabled';
            if (byId.some((row) => row.autoApprovalPolicyId === null && !managedPrivate(row))) {
                bump(counts.deploymentSkips, 'reviewed_deployment');
                continue;
            }
            const [byRoute] = yield tx
                .select()
                .from(schema_1.inferenceDeployments)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.modelRevisionId, revisionId), (0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.providerSlug, route.provider), (0, drizzle_orm_1.or)((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.availabilityScope, 'platform_internal'), (0, drizzle_orm_1.sql) `${schema_1.inferenceDeployments.availabilityScope} = ${schema_1.LEGACY_INTERNAL_ALIA_AVAILABILITY_SCOPE}`)))
                .for('update');
            if (byRoute !== undefined && byRoute.autoApprovalPolicyId === null && !managedPrivate(byRoute)) {
                bump(counts.deploymentSkips, 'reviewed_deployment');
                continue;
            }
            // Human review is bound to these facts, not the next publication timestamp.
            // A managed private row may be revisited only under fresh compiled authority;
            // ordinary manually reviewed rows retain their existing protection above.
            const privateFacts = {
                modelRevisionId: revisionId, providerSlug: route.provider,
                scopedExecution: (_a = route.scopedExecution) !== null && _a !== void 0 ? _a : null, regions: [...route.regions],
                retainsPayloads: provider.retainsPayloads, retentionDays: provider.retentionDays,
                trainsOnCustomerData: provider.trainsOnCustomerData, zeroDataRetentionAvailable: provider.zeroDataRetentionAvailable,
                subprocessors: provider.subprocessors, policyUrl: provider.policyUrl,
                priceVersionId: (_b = route.scopedExecution) === null || _b === void 0 ? void 0 : _b.priceVersionId, internalRouteId: route.deploymentId,
                acceptedParameters: route.acceptedParameters === null ? null : [...route.acceptedParameters],
            };
            const samePrivateFacts = (row) => modelFactsUnchanged &&
                managedPrivate(row) && Object.entries(privateFacts).every(([key, value]) => (0, node_util_1.isDeepStrictEqual)(row[key], value));
            let preservePrivateReview = byRoute !== undefined && samePrivateFacts(byRoute);
            if (reviewedPrivateImport) {
                const currentUnits = yield tx.select({ unit: schema_1.priceVersionUnitPrices.unit, amount: schema_1.priceVersionUnitPrices.amount,
                    per: schema_1.priceVersionUnitPrices.per }).from(schema_1.priceVersionUnitPrices)
                    .where((0, drizzle_orm_1.eq)(schema_1.priceVersionUnitPrices.priceVersionId, route.scopedExecution.priceVersionId));
                const [currentPrice] = yield tx.select().from(schema_1.priceVersions)
                    .where((0, drizzle_orm_1.eq)(schema_1.priceVersions.id, route.scopedExecution.priceVersionId));
                preservePrivateReview = preservePrivateReview && currentPrice !== undefined && currentPrice.status === 'active' &&
                    currentPrice.provider === route.provider && currentPrice.modelReference === planned.modelReference &&
                    currentPrice.currency === 'USD' && currentPrice.effectiveFrom <= now && currentPrice.effectiveUntil === null &&
                    sameUnitPrices(currentUnits, syncedUnitPrices(route.price));
                // Invalidate before a changed price/identity can be rejected by immutable
                // import. Never retain approval merely because that update was skipped.
                const rows = new Map([...byId, ...(byRoute === undefined ? [] : [byRoute])].map(row => [row.id, row]));
                for (const row of rows.values())
                    if (managedPrivate(row) && !(row.id === (byRoute === null || byRoute === void 0 ? void 0 : byRoute.id) && preservePrivateReview)) {
                        yield tx.update(schema_1.inferenceDeployments).set({ legalReviewStatus: 'not_started', legalReviewEvidenceRef: null,
                            legalReviewedAt: null, legalReviewedByUserId: null }).where((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.id, row.id));
                    }
            }
            const priceVersionId = yield ensureSyncedPrice(tx, planned.modelReference, route.provider, route.price, now, counts, route.scopedExecution);
            if (priceVersionId === undefined) {
                bump(counts.deploymentSkips, 'unattested_route');
                continue;
            }
            // The same exact id on a different revision/provider row is identity
            // drift: that row no longer describes the deployment, so it is retired
            // before the id is bound to the row that does.
            yield retireSyncedDeployments(tx, byId.filter((row) => row.id !== (byRoute === null || byRoute === void 0 ? void 0 : byRoute.id) && row.status !== 'retired').map((row) => row.id), RETIRED_NOTE, now);
            const routeFacts = {
                scopedExecution: (_c = route.scopedExecution) !== null && _c !== void 0 ? _c : null,
                regions: [...route.regions],
                retainsPayloads: provider.retainsPayloads,
                retentionDays: provider.retentionDays,
                trainsOnCustomerData: provider.trainsOnCustomerData,
                zeroDataRetentionAvailable: provider.zeroDataRetentionAvailable,
                subprocessors: provider.subprocessors,
                policyUrl: provider.policyUrl,
                status: route.scopedExecution === undefined ? 'active' : 'disabled',
                dedicatedCapacity: false,
                priceVersionId,
                internalRouteId: route.deploymentId,
                acceptedParameters: route.acceptedParameters === null ? null : [...route.acceptedParameters],
            };
            const approval = {
                permissionState: route.scopedExecution === undefined ? 'approved' : 'pending_review',
                permissionStateChangedAt: now,
                permissionStateChangedByUserId: null,
                permissionStateNote: route.scopedExecution === undefined ? PERMISSION_NOTE : 'Restricted publication requires source-specific commercial and privacy review.',
                legalReviewStatus: route.scopedExecution === undefined ? 'approved' : 'not_started',
                legalReviewEvidenceRef: route.scopedExecution === undefined ? LEGAL_EVIDENCE_REF : null,
                legalReviewedAt: route.scopedExecution === undefined ? now : null,
                legalReviewedByUserId: null,
            };
            if (byRoute === undefined) {
                yield tx.insert(schema_1.inferenceDeployments).values(Object.assign(Object.assign({ modelRevisionId: revisionId, providerSlug: route.provider, availabilityScope: 'platform_internal', commercialPermission: 'standard_application_use', autoApprovalPolicyId: route.scopedExecution === undefined ? schema_1.KAANA_SYNC_AUTO_APPROVAL_POLICY_ID : null }, routeFacts), approval));
                counts.deploymentsCreated += 1;
            }
            else {
                const revived = byRoute.status === 'retired' || byRoute.permissionState !== 'approved';
                yield tx
                    .update(schema_1.inferenceDeployments)
                    .set(Object.assign(Object.assign(Object.assign({}, routeFacts), { availabilityScope: 'platform_internal' }), (route.scopedExecution !== undefined ? (preservePrivateReview ? {} : approval) : (revived ? approval : {}))))
                    .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.id, byRoute.id));
            }
            yield ensureSyncedScorecard(tx, route.deploymentId, priceVersionId, route.price, evidenceRef, now, counts);
            counts.deploymentsUpserted += 1;
            held.push(route.deploymentId);
        }
        counts.modelsSynced += 1;
        return held;
    });
}
/** The whole write: one transaction, one fleet-wide lock, all or nothing. */
function applyKaanaCatalogue(catalogue_1, attested_1) {
    return __awaiter(this, arguments, void 0, function* (catalogue, attested, options = {}) {
        var _a, _b;
        const now = (_a = options.now) !== null && _a !== void 0 ? _a : new Date();
        if (catalogue.models.length === 0) {
            // Kaana always serves something; an empty report is a broken one, and
            // syncing it would retire every synced route.
            throw new Error('Kaana reported an empty catalogue; refusing to sync it');
        }
        const evidenceRef = `kaana-list-price:${(_b = catalogue.snapshotId) !== null && _b !== void 0 ? _b : 'unknown-snapshot'}`.slice(0, 500);
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const [lock] = yield tx.execute((0, drizzle_orm_1.sql) `select pg_try_advisory_xact_lock(hashtextextended(${SYNC_LOCK_NAMESPACE}, 0)) as locked`);
            const emptyCounts = {
                models: { reported: catalogue.models.length, synced: 0, created: 0, reviewedUntouched: 0, skipped: {} },
                deployments: { upserted: 0, created: 0, retired: 0, retirementWithheld: 0, skipped: {} },
                priceVersionsCreated: 0,
                scorecardsWritten: 0,
                skippedModels: [],
            };
            if ((lock === null || lock === void 0 ? void 0 : lock.locked) !== true) {
                return Object.assign({ status: 'skipped', reason: 'locked', snapshotId: catalogue.snapshotId }, emptyCounts);
            }
            const [policy] = yield tx
                .select({ enabled: schema_1.inferenceCatalogueAutoApprovalPolicies.enabled })
                .from(schema_1.inferenceCatalogueAutoApprovalPolicies)
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceCatalogueAutoApprovalPolicies.id, schema_1.KAANA_SYNC_AUTO_APPROVAL_POLICY_ID));
            if ((policy === null || policy === void 0 ? void 0 : policy.enabled) !== true) {
                return Object.assign({ status: 'skipped', reason: 'policy-disabled', snapshotId: catalogue.snapshotId }, emptyCounts);
            }
            const blocked = new Set((yield tx.select({ modelId: schema_1.inferenceCatalogueBlocklist.modelId }).from(schema_1.inferenceCatalogueBlocklist)).map((row) => row.modelId));
            const providerRows = yield tx
                .select({
                slug: schema_1.inferenceProviders.slug,
                kind: schema_1.inferenceProviders.kind,
                retainsPayloads: schema_1.inferenceProviders.retainsPayloads,
                retentionDays: schema_1.inferenceProviders.retentionDays,
                trainsOnCustomerData: schema_1.inferenceProviders.trainsOnCustomerData,
                zeroDataRetentionAvailable: schema_1.inferenceProviders.zeroDataRetentionAvailable,
                subprocessors: schema_1.inferenceProviders.subprocessors,
                policyUrl: schema_1.inferenceProviders.policyUrl,
            })
                .from(schema_1.inferenceProviders);
            // Only providers Oxy itself pays: a BYOK provider row describes a
            // customer's own account, never a platform route.
            const providers = new Map(providerRows.filter((row) => row.kind !== 'customer_byok').map((row) => [row.slug, row]));
            const counts = {
                modelsSynced: 0,
                modelsCreated: 0,
                reviewedUntouched: 0,
                modelSkips: {},
                deploymentsUpserted: 0,
                deploymentsCreated: 0,
                deploymentSkips: {},
                priceVersionsCreated: 0,
                scorecardsWritten: 0,
                skippedModels: [],
            };
            for (let index = 0; index < catalogue.invalidEntries; index += 1)
                bump(counts.modelSkips, 'invalid_entry');
            const held = new Set();
            const seenLines = new Set();
            for (const entry of catalogue.models) {
                if (seenLines.has(entry.model)) {
                    bump(counts.modelSkips, 'invalid_entry');
                    continue;
                }
                seenLines.add(entry.model);
                const plan = planKaanaModel(entry, {
                    blocked,
                    knownProviders: new Set(providers.keys()),
                    attested,
                });
                for (const skip of plan.status === 'planned' ? plan.model.routeSkips : (_a = plan.routeSkips) !== null && _a !== void 0 ? _a : []) {
                    bump(counts.deploymentSkips, skip);
                }
                if (plan.status === 'skipped') {
                    bump(counts.modelSkips, plan.reason);
                    if (counts.skippedModels.length < MAX_REPORTED_SKIPS) {
                        counts.skippedModels.push({ modelId: entry.model, reason: plan.reason });
                    }
                    continue;
                }
                for (const deploymentId of yield applyPlannedModel(tx, plan.model, providers, evidenceRef, now, counts)) {
                    held.add(deploymentId);
                }
            }
            const live = yield tx
                .select({ id: schema_1.inferenceDeployments.id, internalRouteId: schema_1.inferenceDeployments.internalRouteId })
                .from(schema_1.inferenceDeployments)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.autoApprovalPolicyId, schema_1.KAANA_SYNC_AUTO_APPROVAL_POLICY_ID), (0, drizzle_orm_1.ne)(schema_1.inferenceDeployments.status, 'retired')));
            const stale = live.filter((row) => row.internalRouteId === null || !held.has(row.internalRouteId));
            const massRetirement = live.length > 0 && stale.length / live.length > exports.MAX_ROUTINE_RETIREMENT_FRACTION;
            let retired = 0;
            let retirementWithheld = 0;
            if (massRetirement && options.allowMassRetirement !== true) {
                retirementWithheld = stale.length;
                logger_1.logger.error('inference.catalogue_sync.retirement_withheld', new Error(`the Kaana report would retire ${stale.length} of ${live.length} synced routes`), { snapshotId: catalogue.snapshotId, stale: stale.length, live: live.length });
            }
            else {
                retired = yield retireSyncedDeployments(tx, stale.map((row) => row.id), RETIRED_NOTE, now);
            }
            return {
                status: 'synced',
                snapshotId: catalogue.snapshotId,
                models: {
                    reported: catalogue.models.length + catalogue.invalidEntries,
                    synced: counts.modelsSynced,
                    created: counts.modelsCreated,
                    reviewedUntouched: counts.reviewedUntouched,
                    skipped: counts.modelSkips,
                },
                deployments: {
                    upserted: counts.deploymentsUpserted,
                    created: counts.deploymentsCreated,
                    retired,
                    retirementWithheld,
                    skipped: counts.deploymentSkips,
                },
                priceVersionsCreated: counts.priceVersionsCreated,
                scorecardsWritten: counts.scorecardsWritten,
                skippedModels: counts.skippedModels,
            };
        }));
    });
}
/**
 * Resolve every priced deployment id through Kaana's signed attestation, in
 * batches of its maximum. The catalogue names a deployment and its provider but
 * not its attested region set, and the region set is part of the identity the
 * edge later signs and Kaana compares; taking it from the attestation means the
 * stored route is byte-for-byte the one the preflight will accept.
 */
function attestPricedDeployments(reader, catalogue) {
    return __awaiter(this, void 0, void 0, function* () {
        const ids = [
            ...new Set(catalogue.models.flatMap((model) => model.listPrices.filter((row) => row.price !== 'invalid').map((row) => row.deploymentId))),
        ].sort();
        const attested = new Map();
        for (let start = 0; start < ids.length; start += KAANA_ATTESTATION_BATCH) {
            const batch = ids.slice(start, start + KAANA_ATTESTATION_BATCH);
            const evidence = yield reader.attestDeployments(batch, {
                signal: AbortSignal.timeout(KAANA_CATALOGUE_FETCH_TIMEOUT_MS),
                scopedExecutionContractVersion: '3.6.0',
            });
            if (evidence.scopedExecutionContractVersion !== '3.6.0')
                throw new Error('Missing scoped deployment acknowledgement.');
            if (catalogue.models.some((model) => model.listPrices.some((price) => price.scopedExecution !== undefined)) &&
                (catalogue.snapshotId === undefined || evidence.snapshotId !== catalogue.snapshotId))
                throw new Error('Scoped catalogue snapshot changed before attestation.');
            for (const descriptor of evidence.deployments) {
                if (!batch.includes(descriptor.deploymentId))
                    continue;
                attested.set(descriptor.deploymentId, Object.assign(Object.assign({ deploymentId: descriptor.deploymentId, provider: descriptor.provider, modelReference: descriptor.modelReference, regions: [...new Set(descriptor.regions)].sort(), keyId: descriptor.keyId, upstreamModelId: descriptor.upstreamModelId, providerRateCardVersionId: descriptor.providerRateCardVersionId, providerSourceVersion: descriptor.providerSourceVersion }, (descriptor.scopedExecution === undefined ? {} : { scopedExecution: descriptor.scopedExecution })), (descriptor.acceptedParameters === undefined
                    ? {}
                    : { acceptedParameters: descriptor.acceptedParameters })));
            }
        }
        return attested;
    });
}
/** Fetch Kaana's catalogue and apply it. */
function runKaanaCatalogueSync() {
    return __awaiter(this, arguments, void 0, function* (options = {}) {
        var _a;
        const reader = (_a = options.reader) !== null && _a !== void 0 ? _a : (0, httpKaanaClient_1.createHttpKaanaCatalogueReader)();
        if (reader === undefined) {
            return {
                status: 'skipped',
                reason: 'not-configured',
                models: { reported: 0, synced: 0, created: 0, reviewedUntouched: 0, skipped: {} },
                deployments: { upserted: 0, created: 0, retired: 0, retirementWithheld: 0, skipped: {} },
                priceVersionsCreated: 0,
                scorecardsWritten: 0,
                skippedModels: [],
            };
        }
        const catalogue = parseKaanaCatalogue(yield reader.listModels(AbortSignal.timeout(KAANA_CATALOGUE_FETCH_TIMEOUT_MS)));
        const attested = yield attestPricedDeployments(reader, catalogue);
        const summary = yield applyKaanaCatalogue(catalogue, attested, options);
        logger_1.logger.info('inference.catalogue_sync.completed', {
            status: summary.status,
            reason: summary.reason,
            snapshotId: summary.snapshotId,
            modelsReported: summary.models.reported,
            modelsSynced: summary.models.synced,
            modelsCreated: summary.models.created,
            modelSkips: summary.models.skipped,
            deploymentsUpserted: summary.deployments.upserted,
            deploymentsRetired: summary.deployments.retired,
            retirementWithheld: summary.deployments.retirementWithheld,
            deploymentSkips: summary.deployments.skipped,
            priceVersionsCreated: summary.priceVersionsCreated,
        });
        return summary;
    });
}
function listCatalogueBlocks() {
    return __awaiter(this, void 0, void 0, function* () {
        const rows = yield (0, postgres_1.getDb)()
            .select()
            .from(schema_1.inferenceCatalogueBlocklist)
            .orderBy(schema_1.inferenceCatalogueBlocklist.modelId);
        return rows.map((row) => ({
            modelId: row.modelId,
            reason: row.reason,
            createdByUserId: row.createdByUserId,
            createdAt: row.createdAt.toISOString(),
        }));
    });
}
/**
 * Block a model line and retire its synced routes in the same commit, so the
 * brake takes effect now rather than at the next sync. Reviewed routes of the
 * line are not the sync's to retire; staff retire those through the
 * permission surface.
 */
function blockCatalogueModel(input) {
    return __awaiter(this, void 0, void 0, function* () {
        const now = new Date();
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            const inserted = yield tx
                .insert(schema_1.inferenceCatalogueBlocklist)
                .values({ modelId: input.modelId, reason: input.reason.trim(), createdByUserId: input.userId })
                .onConflictDoNothing({ target: schema_1.inferenceCatalogueBlocklist.modelId })
                .returning({ id: schema_1.inferenceCatalogueBlocklist.id });
            const revisionsOfLine = tx
                .select({ id: schema_1.inferenceModelRevisions.id })
                .from(schema_1.inferenceModelRevisions)
                .innerJoin(schema_1.inferenceModels, (0, drizzle_orm_1.eq)(schema_1.inferenceModelRevisions.modelId, schema_1.inferenceModels.id))
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceModels.modelId, input.modelId));
            const targets = yield tx
                .select({ id: schema_1.inferenceDeployments.id })
                .from(schema_1.inferenceDeployments)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.autoApprovalPolicyId, schema_1.KAANA_SYNC_AUTO_APPROVAL_POLICY_ID), (0, drizzle_orm_1.ne)(schema_1.inferenceDeployments.status, 'retired'), (0, drizzle_orm_1.inArray)(schema_1.inferenceDeployments.modelRevisionId, revisionsOfLine)))
                .for('update');
            const retired = yield retireSyncedDeployments(tx, targets.map((row) => row.id), BLOCKED_NOTE, now);
            return { created: inserted.length === 1, retired };
        }));
    });
}
/** Lift a block. The line's routes return at the next sync, not before. */
function unblockCatalogueModel(modelId) {
    return __awaiter(this, void 0, void 0, function* () {
        const removed = yield (0, postgres_1.getDb)()
            .delete(schema_1.inferenceCatalogueBlocklist)
            .where((0, drizzle_orm_1.eq)(schema_1.inferenceCatalogueBlocklist.modelId, modelId))
            .returning({ id: schema_1.inferenceCatalogueBlocklist.id });
        return removed.length === 1;
    });
}
/* -------------------------------------------------------------------------- */
/*  Schedule                                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Register the fleet-wide schedule. Every API task registers it; the advisory
 * lock lets exactly one run at a time and the rest return `locked`. A task with
 * no Kaana binding registers nothing.
 */
function startKaanaCatalogueSyncSchedule() {
    if ((0, httpKaanaClient_1.createHttpKaanaCatalogueReader)() === undefined) {
        logger_1.logger.info('inference.catalogue_sync.not_configured', {
            component: 'inference-catalogue-sync',
        });
        return undefined;
    }
    let running = false;
    const tick = () => {
        if (running)
            return;
        running = true;
        runKaanaCatalogueSync()
            .catch((error) => logger_1.logger.error('inference.catalogue_sync.failed', error instanceof Error ? error : new Error(String(error))))
            .finally(() => {
            running = false;
        });
    };
    const first = setTimeout(tick, KAANA_CATALOGUE_SYNC_FIRST_RUN_DELAY_MS);
    const interval = setInterval(tick, exports.KAANA_CATALOGUE_SYNC_INTERVAL_MS);
    first.unref();
    interval.unref();
    return {
        stop() {
            clearTimeout(first);
            clearInterval(interval);
        },
    };
}
