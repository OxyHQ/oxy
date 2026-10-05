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
exports.scopeSeedOptions = scopeSeedOptions;
exports.seedOxyApplicationScopes = seedOxyApplicationScopes;
exports.scopeSeedMain = scopeSeedMain;
/** Official seed's DB-operator boundary, restricted to existing exact-ID scope unions.
 * No HTTP identity, staff session, credential or membership is manufactured here.
 */
const node_crypto_1 = require("node:crypto");
const drizzle_orm_1 = require("drizzle-orm");
const postgres_1 = require("../config/postgres");
const schema_1 = require("../db/schema");
const applicationScopes_1 = require("../utils/applicationScopes");
const mentionClassifierEconomics_1 = require("../config/mentionClassifierEconomics");
const seedEntrySelection_1 = require("./seedEntrySelection");
const seedOxyApplicationsSpecs_1 = require("./seedOxyApplicationsSpecs");
const sorted = (values) => [...new Set(values)].sort();
const fail = (code) => {
    throw new Error(code);
};
function scopeSeedOptions(env) {
    var _a, _b;
    if (env.SCOPES_ONLY !== "true" ||
        env.ONLY_APPS !== undefined ||
        !env.ONLY_APP_IDS ||
        (env.OXY_USERNAME !== undefined && env.OXY_USERNAME !== "oxy"))
        fail("scope_seed_explicit_ids_required");
    if (env.DRY_RUN !== undefined &&
        !["true", "1", "false", "0"].includes(env.DRY_RUN))
        fail("scope_seed_invalid_dry_run");
    const apply = env.DRY_RUN !== "true" && env.DRY_RUN !== "1";
    if (apply
        ? !/^[a-f0-9]{64}$/.test((_a = env.EXPECTED_PLAN_SHA256) !== null && _a !== void 0 ? _a : "")
        : env.EXPECTED_PLAN_SHA256 !== undefined) {
        fail("scope_seed_plan_hash_required");
    }
    return Object.assign({ onlyAppIds: (_b = env.ONLY_APP_IDS) !== null && _b !== void 0 ? _b : fail("scope_seed_explicit_ids_required"), apply }, (env.EXPECTED_PLAN_SHA256 === undefined
        ? {}
        : { expectedPlanSha256: env.EXPECTED_PLAN_SHA256 }));
}
function seedOxyApplicationScopes(options) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        if (!options.onlyAppIds ||
            (options.apply && !/^[a-f0-9]{64}$/.test((_a = options.expectedPlanSha256) !== null && _a !== void 0 ? _a : ""))) {
            fail("scope_seed_plan_hash_required");
        }
        const selected = (0, seedEntrySelection_1.selectSeedEntriesByExactIds)(seedOxyApplicationsSpecs_1.SEED_APPS, options.onlyAppIds, {
            envVar: "ONLY_APP_IDS",
            singular: "application",
            plural: "applications",
        })
            .map((spec) => {
            var _a;
            return (Object.assign(Object.assign({}, spec), { id: (_a = spec.id) !== null && _a !== void 0 ? _a : fail("scope_seed_exact_id_required") }));
        })
            .sort((a, b) => a.id.localeCompare(b.id));
        return (0, postgres_1.getDb)().transaction((tx) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            yield tx.execute((0, drizzle_orm_1.sql) `SELECT set_config('statement_timeout','25000',true),
      set_config('lock_timeout','3000',true),set_config('idle_in_transaction_session_timeout','30000',true)`);
            // Closure uses the same user row FOR UPDATE before installing its fence.
            const readOwner = (username) => __awaiter(this, void 0, void 0, function* () {
                const query = tx
                    .select({
                    id: schema_1.users.id,
                    kind: schema_1.users.kind,
                    status: schema_1.users.accountStatus,
                    parentAccountId: schema_1.users.parentAccountId,
                    type: schema_1.users.type,
                })
                    .from(schema_1.users)
                    .where((0, drizzle_orm_1.sql) `lower(btrim(${schema_1.users.username})) = lower(btrim(${username}))`)
                    .limit(2);
                const rows = yield (options.apply ? query.for("update") : query);
                if (rows.length !== 1 ||
                    rows[0].status !== "active" ||
                    rows[0].type !== "local")
                    fail("scope_seed_owner_not_active");
                const [fence] = yield tx
                    .select({ id: schema_1.accountClosureFences.accountId })
                    .from(schema_1.accountClosureFences)
                    .where((0, drizzle_orm_1.eq)(schema_1.accountClosureFences.accountId, rows[0].id));
                if (fence)
                    fail("scope_seed_owner_fenced");
                return rows[0];
            });
            const platformOwner = yield readOwner("oxy");
            const rows = [];
            for (const spec of selected) {
                const owner = spec.ownerAccountUsername === undefined
                    ? platformOwner
                    : yield readOwner(spec.ownerAccountUsername);
                if (spec.ownerAccountUsername !== undefined &&
                    (owner.kind !== "project" ||
                        owner.parentAccountId !== platformOwner.id)) {
                    fail("scope_seed_dedicated_owner_mismatch");
                }
                const query = tx
                    .select({
                    id: schema_1.applications.id,
                    name: schema_1.applications.name,
                    createdByUserId: schema_1.applications.createdByUserId,
                    ownerAccountId: schema_1.applications.ownerAccountId,
                    type: schema_1.applications.type,
                    isInternal: schema_1.applications.isInternal,
                    isOfficial: schema_1.applications.isOfficial,
                    status: schema_1.applications.status,
                    scopes: schema_1.applications.scopes,
                })
                    .from(schema_1.applications)
                    .where((0, drizzle_orm_1.eq)(schema_1.applications.id, spec.id));
                const [app] = yield (options.apply ? query.for("update") : query);
                if (!app ||
                    app.name !== spec.name ||
                    app.createdByUserId !== platformOwner.id ||
                    app.ownerAccountId !== owner.id ||
                    app.type !== spec.type ||
                    app.isInternal !== (spec.type === "internal") ||
                    !app.isOfficial ||
                    app.status !== "active")
                    fail("scope_seed_application_identity_mismatch");
                if (!app.scopes.every(applicationScopes_1.isValidApplicationScope))
                    fail("scope_seed_unknown_existing_scope");
                const desired = sorted([
                    ...app.scopes,
                    ...((_a = spec.scopes) !== null && _a !== void 0 ? _a : ["user:read"]),
                ]);
                const bindingQuery = tx
                    .select({
                    id: schema_1.applicationWorkloadIdentities.id,
                    provider: schema_1.applicationWorkloadIdentities.provider,
                    subject: schema_1.applicationWorkloadIdentities.subject,
                    scopes: schema_1.applicationWorkloadIdentities.scopes,
                    expiresAt: schema_1.applicationWorkloadIdentities.expiresAt,
                })
                    .from(schema_1.applicationWorkloadIdentities)
                    .where((0, drizzle_orm_1.eq)(schema_1.applicationWorkloadIdentities.applicationId, app.id))
                    .orderBy((0, drizzle_orm_1.asc)(schema_1.applicationWorkloadIdentities.id));
                const bindings = yield (options.apply
                    ? bindingQuery.for("update")
                    : bindingQuery);
                const credentialQuery = tx
                    .select({
                    id: schema_1.applicationCredentials.id,
                    type: schema_1.applicationCredentials.type,
                    environment: schema_1.applicationCredentials.environment,
                    status: schema_1.applicationCredentials.status,
                    scopes: schema_1.applicationCredentials.scopes,
                    expiresAt: schema_1.applicationCredentials.expiresAt,
                    workloadIdentityId: schema_1.applicationCredentials.workloadIdentityId,
                })
                    .from(schema_1.applicationCredentials)
                    .where((0, drizzle_orm_1.eq)(schema_1.applicationCredentials.applicationId, app.id))
                    .orderBy((0, drizzle_orm_1.asc)(schema_1.applicationCredentials.id));
                const credentials = yield (options.apply
                    ? credentialQuery.for("update")
                    : credentialQuery);
                const expansions = [];
                for (const binding of bindings) {
                    const before = (0, applicationScopes_1.workloadBindingScopes)(binding.scopes, app.scopes);
                    const added = (0, applicationScopes_1.workloadBindingScopes)(binding.scopes, desired).filter((scope) => !before.includes(scope));
                    const own = app.id === mentionClassifierEconomics_1.MENTION_CLASSIFIER_IDENTITY.applicationId &&
                        binding.id === mentionClassifierEconomics_1.MENTION_CLASSIFIER_IDENTITY.bindingId &&
                        binding.subject === mentionClassifierEconomics_1.MENTION_CLASSIFIER_IDENTITY.subject &&
                        binding.provider === "aws-iam";
                    if (added.length && !own)
                        expansions.push({
                            kind: "binding",
                            id: binding.id,
                            added: sorted(added),
                        });
                }
                for (const credential of credentials) {
                    if (credential.type === "workload")
                        continue; // Its binding, not attribution-row scopes, is authoritative.
                    const before = credential.type === "service" && !credential.scopes.length
                        ? app.scopes
                        : (0, applicationScopes_1.intersectScopes)(credential.scopes, app.scopes);
                    const after = credential.type === "service" && !credential.scopes.length
                        ? desired
                        : (0, applicationScopes_1.intersectScopes)(credential.scopes, desired);
                    const added = after.filter((scope) => !before.includes(scope));
                    if (added.length)
                        expansions.push({
                            kind: "credential",
                            id: credential.id,
                            added: sorted(added),
                        });
                }
                rows.push({
                    identity: app,
                    owner,
                    ownerClosureFenced: false,
                    before: [...app.scopes],
                    desired,
                    added: desired.filter((scope) => !app.scopes.includes(scope)),
                    bindings,
                    credentials,
                    nonTargetExpansions: expansions,
                });
            }
            const plan = {
                kind: "official-application-scopes-only-v1",
                platformOwner,
                applications: rows,
            };
            const planSha256 = (0, node_crypto_1.createHash)("sha256")
                .update(JSON.stringify(plan))
                .digest("hex");
            const refused = rows.some((row) => row.nonTargetExpansions.length > 0);
            if (options.apply &&
                (options.expectedPlanSha256 !== planSha256 || refused)) {
                fail(refused
                    ? "scope_seed_non_target_expansion"
                    : "scope_seed_plan_changed");
            }
            let changed = 0;
            if (options.apply) {
                for (const row of rows) {
                    if (!row.added.length)
                        continue;
                    // Preserve the timestamp too: the shared column has an automatic onUpdate hook.
                    // Row lock plus exact prior scopes prevents lost updates; metadata values remain identical.
                    const updated = yield tx
                        .update(schema_1.applications)
                        .set({
                        scopes: row.desired,
                        updatedAt: (0, drizzle_orm_1.sql) `${schema_1.applications.updatedAt}`,
                    })
                        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.applications.id, row.identity.id), (0, drizzle_orm_1.sql) `${schema_1.applications.scopes} = ${drizzle_orm_1.sql.param(row.before)}::text[]`))
                        .returning({ id: schema_1.applications.id });
                    if (updated.length !== 1)
                        fail("scope_seed_scope_cas_failed");
                    changed++;
                }
            }
            return Object.assign(Object.assign({}, plan), { planSha256, applied: options.apply, changed, applyEligible: !refused, authority: "existing_official_seed_database_operator", sessionCreated: false, noCredentialOrMetadataWrites: true, oauthSessionGrantSemanticsNotEvaluated: true });
        }), {
            isolationLevel: options.apply ? "serializable" : "repeatable read",
            accessMode: options.apply ? "read write" : "read only",
        });
    });
}
/** Shipped Node entrypoint; the source Bun wrapper calls this exact implementation. */
function scopeSeedMain() {
    return __awaiter(this, arguments, void 0, function* (args = process.argv.slice(2), env = process.env) {
        if (args.length)
            fail("scope_seed_arguments_not_supported");
        const options = scopeSeedOptions(env);
        // Validate the exact-ID filter before even connecting, including unknown/duplicate IDs.
        (0, seedEntrySelection_1.selectSeedEntriesByExactIds)(seedOxyApplicationsSpecs_1.SEED_APPS, options.onlyAppIds, {
            envVar: "ONLY_APP_IDS",
            singular: "application",
            plural: "applications",
        });
        yield (0, postgres_1.connectPostgres)();
        try {
            console.log(JSON.stringify(yield seedOxyApplicationScopes(options)));
        }
        finally {
            yield (0, postgres_1.closePostgres)();
        }
    });
}
if (require.main === module)
    scopeSeedMain().catch(() => {
        console.error("Official scopes-only seed refused; inspect the reviewed plan and current state before retrying.");
        process.exitCode = 1;
    });
