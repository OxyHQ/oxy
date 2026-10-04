"use strict";
/**
 * The catalogue's commercial-permission workflow (issue #972, workstream 11).
 *
 * A technically callable provider route is not automatically publicly
 * resellable. This is the surface that moves a route between permission states,
 * and it is deliberately small: four verbs, each writing one state plus who did
 * it and when.
 *
 * ## Staff-gated, consistently with how this repo already gates staff-only fields
 *
 * `Application.type` / `isOfficial` / `isInternal` / `capabilities` are gated by
 * `requireStaff` (`middleware/requireStaff.ts`), and so is this — a route's
 * commercial permission is the same class of decision: it cannot be granted
 * through any customer-held role, because the thing being asserted is that OXY
 * has the right to resell somebody else's model, which no customer can know.
 *
 * ## What is NOT here, and where it goes instead
 *
 * **Publishing a price version.** `price_versions` is the LEDGER's table
 * (workstream 7). This is the natural home for its authoring verb — the model
 * revision and provider a price is scoped to already live here — but that table
 * is not in this schema barrel yet, so writing it now would be code that cannot
 * compile. It is an INTENDED addition to this module, not an existing one, and
 * the append-only rule is not negotiable when it lands: a price change is a new
 * row, and an existing row is never edited.
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
exports.DeploymentPermissionRefused = exports.DeploymentNotFoundError = exports.ACTION_TARGET_STATE = exports.DEPLOYMENT_PERMISSION_ACTIONS = void 0;
exports.classifyDeploymentPermissionWriteError = classifyDeploymentPermissionWriteError;
exports.setDeploymentRoutingScores = setDeploymentRoutingScores;
exports.recordLegalReview = recordLegalReview;
exports.applyPermissionAction = applyPermissionAction;
exports.setDeploymentPlatformFeePriceVersion = setDeploymentPlatformFeePriceVersion;
const drizzle_orm_1 = require("drizzle-orm");
const postgres_1 = require("../config/postgres");
const inferenceRoutingScoreValidity_1 = require("../config/inferenceRoutingScoreValidity");
const schema_1 = require("../db/schema");
const postgresErrors_1 = require("../utils/postgresErrors");
const inferenceCatalogue_service_1 = require("./inferenceCatalogue.service");
/** The four transitions this workflow offers, as the route layer names them. */
exports.DEPLOYMENT_PERMISSION_ACTIONS = [
    'approve',
    'restrict',
    'suspend',
    'retire',
];
/**
 * The state each action writes.
 *
 * A map rather than a switch so the pairing is DATA, and a test can assert that
 * every action lands on a real permission state and that no action lands on
 * `pending_review` — an action that walked a route BACK to the default would be
 * indistinguishable from never having reviewed it.
 */
exports.ACTION_TARGET_STATE = {
    approve: 'approved',
    restrict: 'restricted',
    suspend: 'suspended',
    retire: 'retired',
};
/** Raised when the requested route does not exist. */
class DeploymentNotFoundError extends Error {
    constructor(deploymentId) {
        super(`No inference deployment with id ${deploymentId}`);
        this.name = 'DeploymentNotFoundError';
    }
}
exports.DeploymentNotFoundError = DeploymentNotFoundError;
/**
 * Raised when the transition is refused for a reason the database would state
 * as a constraint violation.
 *
 * Distinguished from a constraint error so the route layer can answer 409 with
 * a sentence rather than surfacing a SQLSTATE — but the CONSTRAINT is still
 * there and still authoritative: this class is a better message, never the
 * enforcement.
 */
class DeploymentPermissionRefused extends Error {
    constructor(message) {
        super(message);
        this.name = 'DeploymentPermissionRefused';
    }
}
exports.DeploymentPermissionRefused = DeploymentPermissionRefused;
const SERVING_AVAILABILITY_SCOPES = [
    'public_payg',
    'oxy_hosted',
    'platform_internal',
    'byok_only',
];
const APPROVED_IDENTITY_CONFLICT = 'This Kaana deploymentId already backs another approved catalogue row.';
/**
 * Convert only the approved-Kaana-identity unique race into the public 409.
 * Other database failures must retain their original identity and surface as
 * server errors rather than being mislabeled as an operator conflict.
 */
function classifyDeploymentPermissionWriteError(error) {
    return (0, postgresErrors_1.violatesUniqueIndex)(error, schema_1.APPROVED_INTERNAL_ROUTE_ID_UNIQUE_INDEX)
        ? new DeploymentPermissionRefused(APPROVED_IDENTITY_CONFLICT)
        : undefined;
}
function unavailableScorecardReason(scorecard, priceVersionId, minimumValidUntil) {
    if (scorecard.price.score === null ||
        scorecard.latency.score === null ||
        scorecard.throughput.score === null ||
        scorecard.balanced.score === null) {
        return 'all four routing scores must be explicit non-null values';
    }
    if (priceVersionId === null || scorecard.price.priceVersionId !== priceVersionId) {
        return 'the price score must name the route current exact priceVersionId';
    }
    if (Date.parse(scorecard.latency.validUntil) < minimumValidUntil.getTime()) {
        return 'the latency score evidence does not cover the configured minimum validity horizon';
    }
    if (Date.parse(scorecard.throughput.validUntil) < minimumValidUntil.getTime()) {
        return 'the throughput score evidence does not cover the configured minimum validity horizon';
    }
    if (Date.parse(scorecard.balanced.validUntil) < minimumValidUntil.getTime()) {
        return 'the balanced score evidence does not cover the configured minimum validity horizon';
    }
    return undefined;
}
function billingPriceVersionId(deployment) {
    return deployment.availabilityScope === 'byok_only'
        ? deployment.platformFeePriceVersionId
        : deployment.priceVersionId;
}
/**
 * Replace every routing score for one exact Kaana deployment identity.
 *
 * This intentionally looks up `internal_route_id`, not the catalogue row id or
 * provider slug. A partial update is not offered: the four values are one
 * reviewed scorecard, and NULL explicitly withdraws a signal so routing fails
 * closed rather than continuing on stale data. Each signal carries its own
 * evidence and validity contract; changing one still means reviewing and
 * resubmitting the complete scorecard.
 */
function setDeploymentRoutingScores(input) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const changedAt = new Date();
        const scorecard = {
            price: Object.assign(Object.assign({}, input.scorecard.price), { evidenceRef: input.scorecard.price.evidenceRef.trim(), priceVersionId: input.scorecard.price.priceVersionId.trim() }),
            latency: Object.assign(Object.assign({}, input.scorecard.latency), { evidenceRef: input.scorecard.latency.evidenceRef.trim() }),
            throughput: Object.assign(Object.assign({}, input.scorecard.throughput), { evidenceRef: input.scorecard.throughput.evidenceRef.trim() }),
            balanced: Object.assign(Object.assign({}, input.scorecard.balanced), { evidenceRef: input.scorecard.balanced.evidenceRef.trim(), formulaRef: input.scorecard.balanced.formulaRef.trim() }),
            economics: Object.assign(Object.assign({}, input.scorecard.economics), { evidenceRef: input.scorecard.economics.evidenceRef.trim(), remainingUnit: (_b = (_a = input.scorecard.economics.remainingUnit) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : null }),
            reason: input.scorecard.reason.trim(),
        };
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            const mapped = yield tx
                .select({
                deploymentId: schema_1.inferenceDeployments.internalRouteId,
                priceVersionId: schema_1.inferenceDeployments.priceVersionId,
                platformFeePriceVersionId: schema_1.inferenceDeployments.platformFeePriceVersionId,
                status: schema_1.inferenceDeployments.status,
                permissionState: schema_1.inferenceDeployments.permissionState,
                availabilityScope: schema_1.inferenceDeployments.availabilityScope,
            })
                .from(schema_1.inferenceDeployments)
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.internalRouteId, input.deploymentId))
                .for('update');
            if (mapped.length === 0)
                throw new DeploymentNotFoundError(input.deploymentId);
            if (mapped.length !== 1) {
                throw new DeploymentPermissionRefused('This Kaana deploymentId maps to more than one catalogue row; authoring is refused until the identity collision is resolved.');
            }
            if (billingPriceVersionId(mapped[0]) !== scorecard.price.priceVersionId) {
                throw new DeploymentPermissionRefused('The price score priceVersionId is not assigned to this exact Kaana deployment.');
            }
            if (Date.parse(scorecard.latency.measurementWindowEnd) > changedAt.getTime() ||
                Date.parse(scorecard.throughput.measurementWindowEnd) > changedAt.getTime()) {
                throw new DeploymentPermissionRefused('A routing measurement window cannot end in the future.');
            }
            if (Date.parse(scorecard.latency.validUntil) <= changedAt.getTime() ||
                Date.parse(scorecard.throughput.validUntil) <= changedAt.getTime() ||
                Date.parse(scorecard.balanced.validUntil) <= changedAt.getTime()) {
                throw new DeploymentPermissionRefused('Routing evidence must still be valid when it is written.');
            }
            if (scorecard.economics.validUntil !== null &&
                Date.parse(scorecard.economics.validUntil) <= changedAt.getTime()) {
                throw new DeploymentPermissionRefused('Funding evidence must still be valid when it is written.');
            }
            const approvedServing = mapped.filter((deployment) => deployment.permissionState === 'approved' &&
                SERVING_AVAILABILITY_SCOPES.includes((0, schema_1.normalizeInferenceDeploymentAvailabilityScope)(deployment.availabilityScope)));
            const minimumValidUntil = approvedServing.length === 0 ? changedAt : (0, inferenceRoutingScoreValidity_1.routingScoreValidityThreshold)(changedAt);
            for (const deployment of approvedServing) {
                const unavailable = unavailableScorecardReason(scorecard, billingPriceVersionId(deployment), minimumValidUntil);
                if (unavailable !== undefined) {
                    throw new DeploymentPermissionRefused(`Suspend or restrict this approved serving-scope route before withdrawing its routing evidence: ${unavailable}.`);
                }
            }
            const values = {
                deploymentId: input.deploymentId,
                priceScore: scorecard.price.score,
                priceSource: scorecard.price.source,
                priceEvidenceRef: scorecard.price.evidenceRef,
                priceVersionId: scorecard.price.priceVersionId,
                latencyScore: scorecard.latency.score,
                latencySource: scorecard.latency.source,
                latencyEvidenceRef: scorecard.latency.evidenceRef,
                latencyMeasurementWindowStart: new Date(scorecard.latency.measurementWindowStart),
                latencyMeasurementWindowEnd: new Date(scorecard.latency.measurementWindowEnd),
                latencyValidUntil: new Date(scorecard.latency.validUntil),
                throughputScore: scorecard.throughput.score,
                throughputSource: scorecard.throughput.source,
                throughputEvidenceRef: scorecard.throughput.evidenceRef,
                throughputMeasurementWindowStart: new Date(scorecard.throughput.measurementWindowStart),
                throughputMeasurementWindowEnd: new Date(scorecard.throughput.measurementWindowEnd),
                throughputValidUntil: new Date(scorecard.throughput.validUntil),
                balancedScore: scorecard.balanced.score,
                balancedSource: scorecard.balanced.source,
                balancedEvidenceRef: scorecard.balanced.evidenceRef,
                balancedFormulaRef: scorecard.balanced.formulaRef,
                balancedValidUntil: new Date(scorecard.balanced.validUntil),
                fundingClass: scorecard.economics.fundingClass,
                fundingState: scorecard.economics.state,
                fundingEvidenceRef: scorecard.economics.evidenceRef,
                fundingRemaining: scorecard.economics.remaining,
                fundingRemainingUnit: scorecard.economics.remainingUnit,
                fundingObservedAt: scorecard.economics.observedAt === null
                    ? null
                    : new Date(scorecard.economics.observedAt),
                fundingValidUntil: scorecard.economics.validUntil === null
                    ? null
                    : new Date(scorecard.economics.validUntil),
                reason: scorecard.reason,
                changedByUserId: input.staffUserId,
            };
            const [row] = yield tx
                .insert(schema_1.inferenceDeploymentRoutingScores)
                .values(Object.assign(Object.assign({}, values), { changedAt }))
                .onConflictDoUpdate({
                target: schema_1.inferenceDeploymentRoutingScores.deploymentId,
                set: Object.assign(Object.assign({}, values), { changedByUserId: input.staffUserId, changedAt, updatedAt: changedAt }),
            })
                .returning({
                deploymentId: schema_1.inferenceDeploymentRoutingScores.deploymentId,
            });
            if (row === undefined)
                throw new DeploymentNotFoundError(input.deploymentId);
            yield tx.insert(schema_1.inferenceDeploymentRoutingScoreEvents).values(Object.assign(Object.assign({}, values), { createdAt: changedAt }));
            return {
                deploymentId: row.deploymentId,
                scorecard,
            };
        }));
    });
}
/**
 * Record the outcome of a contract/legal review.
 *
 * Separate from {@link applyPermissionAction} on purpose. Reviewing and
 * approving are two decisions, usually by two people, and folding them into one
 * call would make "approved" mean "somebody clicked approve" — the database
 * refuses an approval whose review is not itself approved, and this is the only
 * way to satisfy it.
 */
function recordLegalReview(input, executor) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const evidenceRef = (_a = input.evidenceRef) === null || _a === void 0 ? void 0 : _a.trim();
        if (input.status === 'approved' && (evidenceRef === undefined || evidenceRef.length === 0)) {
            throw new DeploymentPermissionRefused('A legal approval must cite its evidence reference. The catalogue stores a pointer into the contract register, never the contract.');
        }
        const reviewedAt = new Date();
        const [row] = yield (executor !== null && executor !== void 0 ? executor : (0, postgres_1.getDb)())
            .update(schema_1.inferenceDeployments)
            .set({
            legalReviewStatus: input.status,
            legalReviewEvidenceRef: evidenceRef !== null && evidenceRef !== void 0 ? evidenceRef : null,
            legalReviewedAt: reviewedAt,
            legalReviewedByUserId: input.reviewerUserId,
        })
            .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.id, input.deploymentId))
            .returning({
            deploymentId: schema_1.inferenceDeployments.id,
            permissionState: schema_1.inferenceDeployments.permissionState,
            legalReviewStatus: schema_1.inferenceDeployments.legalReviewStatus,
        });
        if (row === undefined)
            throw new DeploymentNotFoundError(input.deploymentId);
        return {
            deploymentId: row.deploymentId,
            permissionState: row.permissionState,
            legalReviewStatus: row.legalReviewStatus,
            changedAt: reviewedAt,
        };
    });
}
/**
 * Approve, restrict, suspend or retire a route.
 *
 * `approve` is refused by the DATABASE unless the legal review is itself
 * approved (`inference_deployments_approval_requires_legal_review`), so this
 * function checks the same thing first only to produce a readable message. The
 * check here is a courtesy; the constraint is the control, and removing this
 * function would not make an unreviewed route approvable.
 *
 * A retired route stays retired: moving out of `retired` is not offered, because
 * a route that was withdrawn and quietly restored is exactly the state a
 * customer cannot verify and a contract review cannot audit. Re-offering means
 * a new row.
 */
function applyPermissionAction(input) {
    return __awaiter(this, void 0, void 0, function* () {
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const [existing] = yield tx
                .select({
                id: schema_1.inferenceDeployments.id,
                permissionState: schema_1.inferenceDeployments.permissionState,
                legalReviewStatus: schema_1.inferenceDeployments.legalReviewStatus,
                internalRouteId: schema_1.inferenceDeployments.internalRouteId,
                priceVersionId: schema_1.inferenceDeployments.priceVersionId,
                platformFeePriceVersionId: schema_1.inferenceDeployments.platformFeePriceVersionId,
                availabilityScope: schema_1.inferenceDeployments.availabilityScope,
            })
                .from(schema_1.inferenceDeployments)
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.id, input.deploymentId))
                .for('update');
            if (existing === undefined)
                throw new DeploymentNotFoundError(input.deploymentId);
            if (existing.permissionState === 'retired') {
                throw new DeploymentPermissionRefused('A retired route stays retired. Re-offering the same model on the same provider is a new deployment, so the decision is visible and reviewable.');
            }
            if (input.action === 'approve') {
                if (existing.legalReviewStatus !== 'approved') {
                    throw new DeploymentPermissionRefused('This route cannot be approved until its contract/legal review is approved and its evidence reference recorded.');
                }
                const requiresRoutingReadiness = SERVING_AVAILABILITY_SCOPES.includes((0, schema_1.normalizeInferenceDeploymentAvailabilityScope)(existing.availabilityScope));
                if (requiresRoutingReadiness && existing.internalRouteId === null) {
                    throw new DeploymentPermissionRefused('This route cannot be approved until it maps to one exact Kaana deploymentId.');
                }
                if (requiresRoutingReadiness) {
                    // Narrowed by the refusal immediately above.
                    const internalRouteId = existing.internalRouteId;
                    const [scorecard] = yield tx
                        .select({
                        priceScore: schema_1.inferenceDeploymentRoutingScores.priceScore,
                        priceVersionId: schema_1.inferenceDeploymentRoutingScores.priceVersionId,
                        latencyScore: schema_1.inferenceDeploymentRoutingScores.latencyScore,
                        latencyMeasurementWindowEnd: schema_1.inferenceDeploymentRoutingScores.latencyMeasurementWindowEnd,
                        latencyValidUntil: schema_1.inferenceDeploymentRoutingScores.latencyValidUntil,
                        throughputScore: schema_1.inferenceDeploymentRoutingScores.throughputScore,
                        throughputMeasurementWindowEnd: schema_1.inferenceDeploymentRoutingScores.throughputMeasurementWindowEnd,
                        throughputValidUntil: schema_1.inferenceDeploymentRoutingScores.throughputValidUntil,
                        balancedScore: schema_1.inferenceDeploymentRoutingScores.balancedScore,
                        balancedValidUntil: schema_1.inferenceDeploymentRoutingScores.balancedValidUntil,
                    })
                        .from(schema_1.inferenceDeploymentRoutingScores)
                        .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeploymentRoutingScores.deploymentId, internalRouteId))
                        .for('update');
                    const now = new Date();
                    const minimumValidUntil = (0, inferenceRoutingScoreValidity_1.routingScoreValidityThreshold)(now);
                    if (scorecard === undefined) {
                        throw new DeploymentPermissionRefused('This route cannot be approved until its exact Kaana deployment has a complete routing scorecard.');
                    }
                    if (scorecard.priceScore === null ||
                        scorecard.latencyScore === null ||
                        scorecard.throughputScore === null ||
                        scorecard.balancedScore === null) {
                        throw new DeploymentPermissionRefused('This route cannot be approved until all four routing scores are explicit non-null values.');
                    }
                    if (billingPriceVersionId(existing) === null ||
                        scorecard.priceVersionId !== billingPriceVersionId(existing)) {
                        throw new DeploymentPermissionRefused('This route cannot be approved until its price score names the current exact priceVersionId.');
                    }
                    if (scorecard.latencyMeasurementWindowEnd > now ||
                        scorecard.throughputMeasurementWindowEnd > now) {
                        throw new DeploymentPermissionRefused('This route cannot be approved with a routing measurement window that ends in the future.');
                    }
                    if (scorecard.latencyValidUntil < minimumValidUntil ||
                        scorecard.throughputValidUntil < minimumValidUntil ||
                        scorecard.balancedValidUntil < minimumValidUntil) {
                        throw new DeploymentPermissionRefused('This route cannot be approved unless all routing evidence covers the configured minimum validity horizon.');
                    }
                }
                if (existing.internalRouteId !== null) {
                    const [duplicate] = yield tx
                        .select({ id: schema_1.inferenceDeployments.id })
                        .from(schema_1.inferenceDeployments)
                        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.ne)(schema_1.inferenceDeployments.id, existing.id), (0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.internalRouteId, existing.internalRouteId), (0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.permissionState, 'approved')))
                        .limit(1);
                    if (duplicate !== undefined) {
                        throw new DeploymentPermissionRefused(APPROVED_IDENTITY_CONFLICT);
                    }
                }
            }
            const changedAt = new Date();
            const [row] = yield tx
                .update(schema_1.inferenceDeployments)
                .set({
                permissionState: exports.ACTION_TARGET_STATE[input.action],
                permissionStateChangedAt: changedAt,
                permissionStateChangedByUserId: input.staffUserId,
                permissionStateNote: (_b = (_a = input.note) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : null,
            })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.id, input.deploymentId), (0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.permissionState, existing.permissionState)))
                .returning({
                deploymentId: schema_1.inferenceDeployments.id,
                permissionState: schema_1.inferenceDeployments.permissionState,
                legalReviewStatus: schema_1.inferenceDeployments.legalReviewStatus,
            });
            if (row === undefined) {
                throw new DeploymentPermissionRefused('The route changed state while this request was in flight. Re-read it and decide again.');
            }
            return {
                deploymentId: row.deploymentId,
                permissionState: row.permissionState,
                legalReviewStatus: row.legalReviewStatus,
                changedAt,
            };
        })).catch((error) => {
            const conflict = classifyDeploymentPermissionWriteError(error);
            if (conflict !== undefined)
                throw conflict;
            throw error;
        });
    });
}
/**
 * Associate an existing immutable price version with a BYOK deployment.
 *
 * This deliberately creates no money and edits no price. It only writes the
 * exact foreign-key pointer after proving the version describes this exact
 * model revision and provider. Activation/effective-window checks remain in the
 * edge, so a draft, inactive or future version cannot become chargeable merely
 * by being associated here.
 */
function setDeploymentPlatformFeePriceVersion(input) {
    return __awaiter(this, void 0, void 0, function* () {
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            const [deployment] = yield tx
                .select({
                id: schema_1.inferenceDeployments.id,
                availabilityScope: schema_1.inferenceDeployments.availabilityScope,
                provider: schema_1.inferenceDeployments.providerSlug,
                modelRevisionId: schema_1.inferenceDeployments.modelRevisionId,
            })
                .from(schema_1.inferenceDeployments)
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.id, input.deploymentId))
                .for('update');
            if (deployment === undefined)
                throw new DeploymentNotFoundError(input.deploymentId);
            if (deployment.availabilityScope !== 'byok_only') {
                throw new DeploymentPermissionRefused('A platform-fee price version may be associated only with a BYOK-only deployment.');
            }
            const [revision] = yield tx
                .select({ modelId: schema_1.inferenceModels.modelId, revision: schema_1.inferenceModelRevisions.revision })
                .from(schema_1.inferenceModelRevisions)
                .innerJoin(schema_1.inferenceModels, (0, drizzle_orm_1.eq)(schema_1.inferenceModelRevisions.modelId, schema_1.inferenceModels.id))
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceModelRevisions.id, deployment.modelRevisionId));
            const [price] = yield tx
                .select({
                id: schema_1.priceVersions.id,
                modelReference: schema_1.priceVersions.modelReference,
                provider: schema_1.priceVersions.provider,
            })
                .from(schema_1.priceVersions)
                .where((0, drizzle_orm_1.eq)(schema_1.priceVersions.id, input.platformFeePriceVersionId));
            if ((revision === null || revision === void 0 ? void 0 : revision.modelId) === null || revision === undefined || price === undefined) {
                throw new DeploymentPermissionRefused('The platform-fee price version must exist and name this exact deployment model revision and provider.');
            }
            const exactModelReference = (0, inferenceCatalogue_service_1.composeModelReference)(revision.modelId, revision.revision);
            if (price.modelReference !== exactModelReference ||
                price.provider !== deployment.provider) {
                throw new DeploymentPermissionRefused('The platform-fee price version must name this exact deployment model revision and provider.');
            }
            yield tx
                .update(schema_1.inferenceDeployments)
                .set({ platformFeePriceVersionId: price.id })
                .where((0, drizzle_orm_1.eq)(schema_1.inferenceDeployments.id, deployment.id));
            return {
                deploymentId: deployment.id,
                platformFeePriceVersionId: price.id,
            };
        }));
    });
}
