"use strict";
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
exports.I03_CANARY_OWNER_ID = void 0;
exports.prepareAliaRevocationCanary = prepareAliaRevocationCanary;
exports.issueAliaRevocationCanary = issueAliaRevocationCanary;
exports.revokeAliaRevocationCanary = revokeAliaRevocationCanary;
exports.inspectAliaRevocationCanary = inspectAliaRevocationCanary;
exports.verifyAliaCanaryAuthorityUnchanged = verifyAliaCanaryAuthorityUnchanged;
exports.retireAliaCanaryAfterTaskFailure = retireAliaCanaryAfterTaskFailure;
const node_crypto_1 = require("node:crypto");
const drizzle_orm_1 = require("drizzle-orm");
const postgres_1 = require("../config/postgres");
const accountClosureFences_1 = require("../db/schema/accountClosureFences");
const appGrants_1 = require("../db/schema/appGrants");
const applicationCredentialAuditEvents_1 = require("../db/schema/applicationCredentialAuditEvents");
const applicationCredentials_1 = require("../db/schema/applicationCredentials");
const applications_1 = require("../db/schema/applications");
const serviceActingAsAuthorityEpochs_1 = require("../db/schema/serviceActingAsAuthorityEpochs");
const serviceActingAsRevocations_1 = require("../db/schema/serviceActingAsRevocations");
const users_1 = require("../db/schema/users");
const applicationCredentialAudit_service_1 = require("./applicationCredentialAudit.service");
const applicationCredentialRevocation_service_1 = require("./applicationCredentialRevocation.service");
// Exact existing Alia application owner; no authority is inferred from branding.
exports.I03_CANARY_OWNER_ID = "01a0369b-1222-712f-8df6-f8ffeb78ccc2";
const fail = () => {
    throw new Error("alia_canary_precondition_failed");
};
const digest = (value) => (0, node_crypto_1.createHash)("sha256").update(JSON.stringify(value)).digest("hex");
function operator(actor) {
    if (!/^arn:aws:(?:iam|sts)::237343248947:(?:user\/[A-Za-z0-9+=,.@_\/-]+|assumed-role\/[A-Za-z0-9+=,.@_-]+\/[A-Za-z0-9+=,.@_-]+)$/.test(actor.operatorArn) ||
        !/^[a-f0-9]{64}$/.test(actor.authorizationSha256))
        fail();
}
function valid(plan, issuing) {
    operator(plan.operator);
    const start = Date.parse(plan.issuedAt);
    const end = Date.parse(plan.expiresAt);
    if (plan.kind !== "alia-credential-revocation-canary-v1" ||
        plan.applicationId !== applicationCredentialRevocation_service_1.I03_CANARY_APPLICATION_ID ||
        plan.ownerAccountId !== exports.I03_CANARY_OWNER_ID ||
        !/^[0-9a-f-]{36}$/.test(plan.credentialId) ||
        !/^[a-f0-9]{24}$/.test(plan.nonce) ||
        !/^[a-f0-9]{64}$/.test(plan.baselineSha256) ||
        !/^[a-f0-9]{64}$/.test(plan.authoritySha256) ||
        !plan.grantId ||
        !plan.principalId ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > 3600000 ||
        start > Date.now() ||
        (issuing && end <= Date.now()))
        fail();
}
function verifier(material) {
    if (!/^oxy_dk_[a-f0-9]{48}$/.test(material.publicKey) ||
        !/^[a-f0-9]{64}$/.test(material.secretHash))
        fail();
}
/** Reads only existing consent. No user grant is inserted or changed. */
function snapshot(tx, principalId) {
    return __awaiter(this, void 0, void 0, function* () {
        yield tx.execute((0, drizzle_orm_1.sql) `set local lock_timeout = '5s'`);
        yield tx.execute((0, drizzle_orm_1.sql) `set local statement_timeout = '10s'`);
        const accounts = yield tx
            .select({
            id: users_1.users.id,
            status: users_1.users.accountStatus,
            version: (0, drizzle_orm_1.sql) `xmin::text`,
        })
            .from(users_1.users)
            .where((0, drizzle_orm_1.inArray)(users_1.users.id, [...new Set([exports.I03_CANARY_OWNER_ID, principalId])].sort()))
            .orderBy(users_1.users.id)
            .for("share");
        if (accounts.length !== new Set([exports.I03_CANARY_OWNER_ID, principalId]).size ||
            accounts.some((row) => row.status !== "active"))
            fail();
        const fences = yield tx
            .select({ id: accountClosureFences_1.accountClosureFences.accountId })
            .from(accountClosureFences_1.accountClosureFences)
            .where((0, drizzle_orm_1.inArray)(accountClosureFences_1.accountClosureFences.accountId, accounts.map((row) => row.id)));
        if (fences.length)
            fail();
        const [app] = yield tx
            .select({
            id: applications_1.applications.id,
            owner: applications_1.applications.ownerAccountId,
            type: applications_1.applications.type,
            isOfficial: applications_1.applications.isOfficial,
            isInternal: applications_1.applications.isInternal,
            status: applications_1.applications.status,
            scopes: applications_1.applications.scopes,
            version: (0, drizzle_orm_1.sql) `xmin::text`,
        })
            .from(applications_1.applications)
            .where((0, drizzle_orm_1.eq)(applications_1.applications.id, applicationCredentialRevocation_service_1.I03_CANARY_APPLICATION_ID))
            .for("no key update");
        if (!app ||
            app.owner !== exports.I03_CANARY_OWNER_ID ||
            app.status !== "active" ||
            app.type !== "internal" ||
            !app.isOfficial ||
            !app.isInternal ||
            !applicationCredentialRevocation_service_1.I03_CANARY_SCOPES.every((scope) => app.scopes.includes(scope)))
            fail();
        const grants = yield tx
            .select({
            id: appGrants_1.appGrants.id,
            userId: appGrants_1.appGrants.userId,
            scopes: appGrants_1.appGrants.scopes,
            version: (0, drizzle_orm_1.sql) `xmin::text`,
        })
            .from(appGrants_1.appGrants)
            .where((0, drizzle_orm_1.eq)(appGrants_1.appGrants.applicationId, applicationCredentialRevocation_service_1.I03_CANARY_APPLICATION_ID))
            .orderBy(appGrants_1.appGrants.id)
            .for("share");
        const grant = grants.find((row) => row.userId === principalId);
        if (!grant ||
            !applicationCredentialRevocation_service_1.I03_CANARY_SCOPES.every((scope) => grant.scopes.includes(scope)))
            return fail();
        const revocations = yield tx
            .select({ userId: serviceActingAsRevocations_1.serviceActingAsRevocations.userId })
            .from(serviceActingAsRevocations_1.serviceActingAsRevocations)
            .where((0, drizzle_orm_1.eq)(serviceActingAsRevocations_1.serviceActingAsRevocations.applicationId, applicationCredentialRevocation_service_1.I03_CANARY_APPLICATION_ID));
        if (revocations.some((row) => row.userId === principalId))
            fail();
        const epochs = yield tx
            .select({
            userId: serviceActingAsAuthorityEpochs_1.serviceActingAsAuthorityEpochs.userId,
            epoch: (0, drizzle_orm_1.sql) `epoch::text`,
        })
            .from(serviceActingAsAuthorityEpochs_1.serviceActingAsAuthorityEpochs)
            .where((0, drizzle_orm_1.eq)(serviceActingAsAuthorityEpochs_1.serviceActingAsAuthorityEpochs.applicationId, applicationCredentialRevocation_service_1.I03_CANARY_APPLICATION_ID))
            .orderBy(serviceActingAsAuthorityEpochs_1.serviceActingAsAuthorityEpochs.userId);
        const credentials = yield tx
            .select({
            id: applicationCredentials_1.applicationCredentials.id,
            status: applicationCredentials_1.applicationCredentials.status,
            scopes: applicationCredentials_1.applicationCredentials.scopes,
            type: applicationCredentials_1.applicationCredentials.type,
            environment: applicationCredentials_1.applicationCredentials.environment,
            expiresAt: applicationCredentials_1.applicationCredentials.expiresAt,
            workloadIdentityId: applicationCredentials_1.applicationCredentials.workloadIdentityId,
        })
            .from(applicationCredentials_1.applicationCredentials)
            .where((0, drizzle_orm_1.eq)(applicationCredentials_1.applicationCredentials.applicationId, applicationCredentialRevocation_service_1.I03_CANARY_APPLICATION_ID))
            .orderBy(applicationCredentials_1.applicationCredentials.id)
            .for("share");
        return {
            accounts,
            app,
            grants,
            revocations,
            epochs,
            credentials,
            grantId: grant.id,
        };
    });
}
/** The canonical mint updates app.lastUsedAt (and therefore xmin). After use,
 * compare its unchanged authority fields separately from the pre-issue CAS. */
function authorityDigest(value) {
    return digest(Object.assign(Object.assign({}, value), { app: Object.assign(Object.assign({}, value.app), { version: null }) }));
}
/** Internal DB-only helper. The launcher authenticates AWS and the exact plan;
 * these strings do not authenticate a person or grant public API access. */
function prepareAliaRevocationCanary(principalId, actor) {
    return __awaiter(this, void 0, void 0, function* () {
        operator(actor);
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            const before = yield snapshot(tx, principalId);
            const issuedAt = new Date();
            return {
                kind: "alia-credential-revocation-canary-v1",
                applicationId: applicationCredentialRevocation_service_1.I03_CANARY_APPLICATION_ID,
                ownerAccountId: exports.I03_CANARY_OWNER_ID,
                credentialId: (0, node_crypto_1.randomUUID)(),
                nonce: (0, node_crypto_1.randomBytes)(12).toString("hex"),
                issuedAt: issuedAt.toISOString(),
                expiresAt: new Date(issuedAt.getTime() + 3600000).toISOString(),
                grantId: before.grantId,
                principalId,
                baselineSha256: digest(before),
                authoritySha256: authorityDigest(before),
                operator: Object.assign({}, actor),
            };
        }));
    });
}
function issueAliaRevocationCanary(plan, material, actor) {
    return __awaiter(this, void 0, void 0, function* () {
        operator(actor);
        valid(plan, true);
        if (plan.operator.operatorArn !== actor.operatorArn ||
            plan.operator.authorizationSha256 !== actor.authorizationSha256)
            fail();
        verifier(material);
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            const current = yield snapshot(tx, plan.principalId);
            if (current.grantId !== plan.grantId ||
                digest(current) !== plan.baselineSha256)
                fail();
            valid(plan, true);
            yield tx.insert(applicationCredentials_1.applicationCredentials).values({
                id: plan.credentialId,
                applicationId: plan.applicationId,
                name: `i03-canary-${plan.nonce}`,
                type: "service",
                environment: "production",
                status: "active",
                publicKey: material.publicKey,
                secretHash: material.secretHash,
                scopes: [...applicationCredentialRevocation_service_1.I03_CANARY_SCOPES],
                expiresAt: new Date(plan.expiresAt),
                createdByUserId: null,
            });
            yield (0, applicationCredentialAudit_service_1.recordOperationalCredentialLifecycleEvent)(tx, Object.assign(Object.assign({ applicationId: plan.applicationId, credentialId: plan.credentialId, eventType: "created", environment: "production", type: "service" }, actor), { nonce: plan.nonce }));
            return {
                credentialId: plan.credentialId,
                status: "active",
                expiresAt: plan.expiresAt,
            };
        }));
    });
}
/** Cleanup remains possible after expiry, narrowing, closure or app suspension.
 * It retires only this exact newly created row, never a workload or another key. */
function revokeAliaRevocationCanary(plan, material, actor) {
    return __awaiter(this, void 0, void 0, function* () {
        operator(actor);
        valid(plan, false);
        if (plan.operator.operatorArn !== actor.operatorArn ||
            plan.operator.authorizationSha256 !== actor.authorizationSha256)
            fail();
        verifier(material);
        return (0, applicationCredentialRevocation_service_1.revokeApplicationCredential)(plan.applicationId, plan.credentialId, Object.assign(Object.assign(Object.assign(Object.assign({ kind: "operational_canary" }, actor), { nonce: plan.nonce }), material), { expiresAt: new Date(plan.expiresAt) }));
    });
}
/** Read-only reconciliation. Exact own verifier checks precede any cleanup claim. */
function inspectAliaRevocationCanary(plan, material, actor) {
    return __awaiter(this, void 0, void 0, function* () {
        operator(actor);
        valid(plan, false);
        verifier(material);
        if (plan.operator.operatorArn !== actor.operatorArn ||
            plan.operator.authorizationSha256 !== actor.authorizationSha256)
            fail();
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const [row] = yield tx
                .select()
                .from(applicationCredentials_1.applicationCredentials)
                .where((0, drizzle_orm_1.eq)(applicationCredentials_1.applicationCredentials.id, plan.credentialId));
            if (!row)
                return { exists: false, status: null };
            if (row.applicationId !== plan.applicationId ||
                row.name !== `i03-canary-${plan.nonce}` ||
                row.publicKey !== material.publicKey ||
                row.secretHash !== material.secretHash ||
                row.type !== "service" ||
                row.environment !== "production" ||
                ((_a = row.expiresAt) === null || _a === void 0 ? void 0 : _a.toISOString()) !== plan.expiresAt ||
                row.createdByUserId !== null ||
                row.rotatedFromCredentialId !== null ||
                row.workloadIdentityId !== null ||
                JSON.stringify(row.scopes) !== JSON.stringify(applicationCredentialRevocation_service_1.I03_CANARY_SCOPES))
                fail();
            return { exists: true, status: row.status };
        }), { isolationLevel: "repeatable read", accessMode: "read only" });
    });
}
/** Compare existing authority only; caller must also prove exact own-row retirement.
 * A concurrent drift is reported, never silently attributed to this canary. */
function verifyAliaCanaryAuthorityUnchanged(plan, actor) {
    return __awaiter(this, void 0, void 0, function* () {
        operator(actor);
        valid(plan, false);
        if (plan.operator.operatorArn !== actor.operatorArn ||
            plan.operator.authorizationSha256 !== actor.authorizationSha256)
            fail();
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            const current = yield snapshot(tx, plan.principalId);
            current.credentials = current.credentials.filter((row) => row.id !== plan.credentialId);
            return authorityDigest(current) === plan.authoritySha256;
        }));
    });
}
/** Recovery after task death, with no plaintext or persisted bearer. The launcher
 * has a durable ID/nonce/operator intent. The immutable creation audit and exact
 * stored row identify only that intent's new credential. Verifier material is
 * read inside this service and never returned or logged. Missing evidence fails.
 */
function retireAliaCanaryAfterTaskFailure(plan, actor) {
    return __awaiter(this, void 0, void 0, function* () {
        operator(actor);
        valid(plan, false);
        if (plan.operator.operatorArn !== actor.operatorArn ||
            plan.operator.authorizationSha256 !== actor.authorizationSha256)
            fail();
        const recover = yield (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            const [row] = yield tx
                .select()
                .from(applicationCredentials_1.applicationCredentials)
                .where((0, drizzle_orm_1.eq)(applicationCredentials_1.applicationCredentials.id, plan.credentialId));
            if (!row)
                return null;
            if (row.applicationId !== plan.applicationId ||
                row.name !== `i03-canary-${plan.nonce}` ||
                row.type !== "service" ||
                row.environment !== "production" ||
                ((_a = row.expiresAt) === null || _a === void 0 ? void 0 : _a.toISOString()) !== plan.expiresAt ||
                row.createdByUserId !== null ||
                row.rotatedFromCredentialId !== null ||
                row.workloadIdentityId !== null ||
                !row.secretHash ||
                JSON.stringify(row.scopes) !== JSON.stringify(applicationCredentialRevocation_service_1.I03_CANARY_SCOPES))
                fail();
            const creation = yield tx
                .select()
                .from(applicationCredentialAuditEvents_1.applicationCredentialAuditEvents)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(applicationCredentialAuditEvents_1.applicationCredentialAuditEvents.applicationId, plan.applicationId), (0, drizzle_orm_1.eq)(applicationCredentialAuditEvents_1.applicationCredentialAuditEvents.credentialId, plan.credentialId), (0, drizzle_orm_1.eq)(applicationCredentialAuditEvents_1.applicationCredentialAuditEvents.eventType, "created")));
            if (creation.length !== 1 ||
                creation[0].actorUserId !== null ||
                creation[0].environment !== "production")
                return fail();
            const expected = Object.assign(Object.assign({ type: "service", actorKind: "operational_canary" }, actor), { nonce: plan.nonce });
            const meta = creation[0].metadata;
            if (!meta || typeof meta !== "object" || Array.isArray(meta))
                return fail();
            if (JSON.stringify(Object.keys(meta).sort()) !==
                JSON.stringify(Object.keys(expected).sort()) ||
                Object.entries(expected).some(([key, value]) => Reflect.get(meta, key) !== value))
                return fail();
            if (!row.secretHash || !row.publicKey)
                return fail();
            if (row.createdAt.getTime() < Date.parse(plan.issuedAt) ||
                row.createdAt.getTime() >= Date.parse(plan.expiresAt))
                fail();
            return {
                status: row.status,
                publicKey: row.publicKey,
                secretHash: row.secretHash,
            };
        }), { isolationLevel: "repeatable read", accessMode: "read only" });
        if (!recover)
            return { credentialId: plan.credentialId, exists: false, retired: true };
        if (recover.status !== "revoked")
            yield revokeAliaRevocationCanary(plan, recover, actor);
        const current = yield inspectAliaRevocationCanary(plan, recover, actor);
        if (!current.exists || current.status !== "revoked")
            fail();
        return { credentialId: plan.credentialId, exists: true, retired: true };
    });
}
