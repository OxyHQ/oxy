#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.KAANA_CATALOGUE_BOOTSTRAP_GATE_ROOT ?? process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/bootstrap-kaana-catalogue.yml");
const bootstrap = read("packages/api/scripts/bootstrap-kaana-catalogue.ts");
const plan = read("packages/api/src/scripts/kaanaCatalogueBootstrapPlan.ts");
const catalogue = read("packages/api/src/config/kaanaInitialCatalogue.ts");
const ci = read(".github/workflows/ci.yml");

const failures = [];
const requireMatch = (source, pattern, message) => {
	if (!pattern.test(source)) failures.push(message);
};
const forbid = (source, pattern, message) => {
	if (pattern.test(source)) failures.push(message);
};

requireMatch(
	workflow,
	/workflow_dispatch:[\s\S]*?mode:[\s\S]*?default: dry-run[\s\S]*?expected_live_task_definition_arn:[\s\S]*?required: true[\s\S]*?expected_bootstrap_task_definition_arn:[\s\S]*?required: true[\s\S]*?expected_live_image_digest:[\s\S]*?required: true[\s\S]*?reviewer_user_id:[\s\S]*?required: true[\s\S]*?expected_plan_sha256:[\s\S]*?reason:/,
	"manual inputs must bind the dry-run mode, both task revisions, image, reviewer, plan and reason",
);
requireMatch(
	workflow,
	/if: github\.ref == 'refs\/heads\/main'/,
	"the production bootstrap must run only from main",
);
requireMatch(
	workflow,
	/group: kaana-catalogue-bootstrap-production[\s\S]*?cancel-in-progress: false/,
	"workflow runs must be serialized without cancellation",
);
requireMatch(
	workflow,
	/id-token: write[\s\S]*?role-to-assume: arn:aws:iam::237343248947:role\/oxy-github-deploy/,
	"the workflow must use the reviewed GitHub OIDC role",
);
requireMatch(
	workflow,
	/EXPECTED_LIVE_TASK_DEFINITION_ARN" =~ \^arn:aws:ecs:us-west-2:237343248947:task-definition\/oxy-oxy-api:\[0-9\]\+\$/,
	"the live task input must be one exact oxy-api revision",
);
requireMatch(
	workflow,
	/EXPECTED_BOOTSTRAP_TASK_DEFINITION_ARN" =~ \^arn:aws:ecs:us-west-2:237343248947:task-definition\/oxy-kaana-catalogue-bootstrap:\[0-9\]\+\$/,
	"the bootstrap input must be one exact dedicated task revision",
);
requireMatch(
	workflow,
	/live_task_definition" != "\$EXPECTED_LIVE_TASK_DEFINITION_ARN"[\s\S]*?live_image" != "\$immutable_image"/,
	"the live service must match the exact reviewed task and immutable image",
);
requireMatch(
	workflow,
	/\.family == "oxy-kaana-catalogue-bootstrap"[\s\S]*?\.image == \$image[\s\S]*?\.command == \["bun","run","packages\/api\/scripts\/bootstrap-kaana-catalogue\.ts"\]/,
	"the dedicated task family, immutable image and command must be exact",
);
requireMatch(
	workflow,
	/\.taskRoleArn == "arn:aws:iam::237343248947:role\/oxy-kaana-catalogue-bootstrap"/,
	"the task must use only the dedicated inventory-read role",
);
requireMatch(
	workflow,
	/\.containerDefinitions\[0\]\.secrets == \[\{[\s\S]*?name:"DATABASE_URL"[\s\S]*?parameter\/oxy\/oxy-api\/DATABASE_URL[\s\S]*?\}\]/,
	"the task must receive only the exact production DATABASE_URL binding",
);
requireMatch(
	workflow,
	/KAANA_INVENTORY_BUCKET",value:"oxy-kaana-inventory-usw2-237343248947"[\s\S]*?KAANA_INVENTORY_KEY",value:"inventory\/current\.json"/,
	"the task must read only the exact reviewed inventory object",
);
requireMatch(
	workflow,
	/NETWORK_SERVICE: kaana-publisher[\s\S]*?assignPublicIp == "ENABLED"/,
	"the network must be copied from the live Kaana publisher and keep public egress",
);
requireMatch(
	workflow,
	/GROQ_DEPLOYMENT_ID: dep_groq_openai_gpt_oss_120b_observed_2026_09_01/,
	"the workflow environment must pin the exact reviewed Groq deployment ID",
);
requireMatch(
	workflow,
	/REVIEWER_USER_ID_EXPECTED: 6981c9178fcdefaf81988ffb[\s\S]*?REVIEWER_USER_ID" != "\$REVIEWER_USER_ID_EXPECTED"/,
	"the workflow must accept only the exact source-reviewed reviewer primary key",
);

for (const exact of [
	"snap_7c760c006f5ac633",
	"openai/gpt-oss-120b",
	"openai/gpt-oss-120b@observed-2026-09-01",
	"dep_cerebras_gpt_oss_120b_observed_2026_09_01",
	"dep_groq_openai_gpt_oss_120b_observed_2026_09_01",
	"01a06477-94f5-74f0-bc25-4a1ff59d6945",
	"01a06477-94f5-74f0-bc25-4c5c13b93ccd",
	"01a06477-94f5-74f0-bc25-52437e0c724d",
	"01a06477-94f5-74f0-bc25-55ea2ebdb2b6",
	"01a06477-94f5-74f0-bc25-5a78baecbef6",
	"01a06477-94f5-74f0-bc25-5d796b49b616",
	"01a06477-94f5-74f0-bc25-628b5f45d802",
	"01a06477-94f5-74f0-bc25-658eeb277737",
]) {
	if (!workflow.includes(exact)) {
		failures.push(`workflow must pin reviewed identity ${exact}`);
	}
	if (
		exact !== "openai/gpt-oss-120b@observed-2026-09-01" &&
		!catalogue.includes(exact)
	) {
		failures.push(`source catalogue must own reviewed identity ${exact}`);
	}
}
requireMatch(
	catalogue,
	/KAANA_INITIAL_MODEL_REFERENCE =\s*`\$\{KAANA_INITIAL_MODEL_ID\}@observed-2026-09-01`/,
	"the source catalogue must compose the exact revision-pinned model reference",
);

const dryRunIndex = workflow.indexOf("dry_envelope=$(run_task");
const applyIndex = workflow.indexOf("apply_envelope=$(run_task");
if (dryRunIndex < 0 || applyIndex < 0 || dryRunIndex >= applyIndex) {
	failures.push("every apply must execute a fresh dry run first");
}
requireMatch(
	workflow,
	/observed_plan" != "\$expected_plan"[\s\S]*?EXPECTED_PLAN_SHA256",value:\$expected/,
	"apply must compare and forward the exact fresh dry-run plan SHA",
);
requireMatch(
	workflow,
	/BOOTSTRAP_REASON",value:\$reason[\s\S]*?KAANA_CATALOGUE_REVIEWER_USER_ID",value:\$reviewer/,
	"apply must bind the auditable reason and exact reviewer PK",
);
requireMatch(
	workflow,
	/select\(startswith\(\$prefix\)\)[\s\S]*?resultCount:[\s\S]*?length/,
	"task success must require exactly one prefixed machine-readable result",
);
requireMatch(
	workflow,
	/validate_bootstrap_result[\s\S]*?\(keys \| sort\) == \[[\s\S]*?\.candidate == \{modelReference:\$revision,priority:100\}[\s\S]*?\(\.inserted - \$allowed\)/,
	"the workflow must allow-list the complete result, exact candidate and operations",
);
requireMatch(
	workflow,
	/readback_command='\["bun","run","packages\/api\/scripts\/readback-inbox-routing-profile\.ts"\]'/,
	"apply must finish with the existing exact-PK PostgreSQL READ ONLY proof",
);
requireMatch(
	workflow,
	/database == \{engine:"postgresql",transactionReadOnly:true,writes:0\}/,
	"the exact-PK readback must prove PostgreSQL READ ONLY and zero writes",
);
requireMatch(
	workflow,
	/if \[ "\$apply_verified" != true \]; then[\s\S]*?SELECT-only readback[\s\S]*?outcome is ambiguous; no retry or success claim was made/,
	"an ambiguous apply must report SELECT-only state and refuse retries or success",
);
requireMatch(
	workflow,
	/noop_envelope=\$\(run_task[\s\S]*?\.inserted' <<<"\$noop_result"\)" != '\[\]'/,
	"the post-apply transaction must prove a zero-operation dry-run no-op",
);
forbid(
	workflow,
	/::group::|\.events\[\]\.message\s*\|\s*select\(startswith\(\$prefix\) \| not\)|echo "\$log_json"/,
	"the workflow must never dump free-form task logs",
);
forbid(
	workflow,
	/\$\{\{\s*secrets\.|(?:OPENAI|ANTHROPIC|GROQ|CEREBRAS|XAI|OPENROUTER)_(?:API_)?KEY/i,
	"the catalogue bootstrap must never receive GitHub or provider secrets",
);
forbid(
	workflow,
	/mongo|mongoose/i,
	"the production bootstrap must remain PostgreSQL-only",
);

requireMatch(
	bootstrap,
	/KAANA_CATALOGUE_BOOTSTRAP_RESULT=[\s\S]*?process\.stdout\.write\(`\$\{RESULT_PREFIX\}\$\{JSON\.stringify\(result\)\}\\n`\)/,
	"the bootstrap must emit one explicit allowlisted result envelope",
);
requireMatch(
	bootstrap,
	/pg_advisory_xact_lock\(hashtextextended\(\$\{BOOTSTRAP_LOCK_NAMESPACE\}, 0\)\)[\s\S]*?requireReviewer\(tx\)/,
	"the PostgreSQL transaction must serialize before checking authority or writing",
);
requireMatch(
	bootstrap,
	/\.where\(eq\(users\.id, reviewerUserId\)\)\s*\.for\("update"\)/,
	"the exact reviewer row must stay locked through commit",
);
requireMatch(
	bootstrap,
	/\.where\(eq\(inferenceModels\.modelId, KAANA_INITIAL_MODEL_ID\)\)/,
	"the reviewed model must be selected only by its exact canonical model ID",
);
requireMatch(
	bootstrap,
	/\.where\(eq\(inferenceDeployments\.internalRouteId, provider\.deploymentId\)\)[\s\S]*?requireAtMostOne\(\s*`Exact deployment ID \$\{provider\.deploymentId\}`/,
	"deployments must be resolved by exact Kaana ID with ambiguity refusal",
);
requireMatch(
	bootstrap,
	/\.where\(eq\(inferenceRoutingProfiles\.id, profile\.id\)\)[\s\S]*?requireAtMostOne\(\s*`Routing-profile primary key \$\{profile\.id\}`/,
	"routing profiles must be resolved only by permanent primary key",
);
requireMatch(
	bootstrap,
	/\.where\(eq\(inferenceRoutingProfileCandidates\.routingProfileId, profile\.id\)\)[\s\S]*?requireExactlyOne\(\s*`Routing-profile primary key \$\{profile\.id\} reviewed candidate`,\s*candidateRows/,
	"each exact profile must have exactly one complete candidate",
);
requireMatch(
	bootstrap,
	/createKaanaCatalogueBootstrapPlan\([\s\S]*?requireKaanaCatalogueBootstrapApplyAuthorization\([\s\S]*?if \(!APPLY\) throw new DryRunRollback/,
	"plan hashing and apply authorization must happen inside the still-rollbackable transaction",
);
requireMatch(
	bootstrap,
	/createKaanaCatalogueReviewedFactsSha256\(REVIEWED_CATALOGUE_FACTS\)[\s\S]*?reviewedFactsSha256: summaryWithoutPlan\.reviewedFactsSha256/,
	"the plan must bind the canonical hash of every source-reviewed catalogue fact",
);
forbid(
	bootstrap,
	/\.orderBy\(|\.limit\(/,
	"the bootstrap must never select a first or name-ordered catalogue row",
);
forbid(
	bootstrap,
	/\b(?:const|let)\s+\[[A-Za-z_$][\w$]*\]\s*=/,
	"the bootstrap must never trust the first row without an exact cardinality check",
);
forbid(bootstrap, /mongo|mongoose/i, "the writer must remain PostgreSQL-only");

requireMatch(
	plan,
	/databaseEngine: "postgresql"/,
	"the plan hash must bind PostgreSQL, exact operations and all reviewed identities",
);
requireMatch(
	plan,
	/reviewedFactsSha256:[\s\S]*?wouldInsert:[\s\S]*?canonicalSha256\(plan\)/,
	"the plan hash must bind reviewed facts and the exact allowlisted operation set",
);
requireMatch(
	plan,
	/if \(!authorization\.apply\) return;[\s\S]*?expectedPlanSha256 !== authorization\.actualPlanSha256[\s\S]*?authorization\.actor[\s\S]*?authorization\.reason/,
	"the writer itself must reject apply without matching SHA, actor and reason",
);
forbid(
	plan,
	/inventoryIssuedAt|inventoryVersionId|createdAt|updatedAt/,
	"volatile inventory or database-generated metadata must not enter the plan hash",
);

requireMatch(
	ci,
	/node scripts\/test-check-kaana-catalogue-bootstrap-workflow\.mjs[\s\S]*?node scripts\/check-kaana-catalogue-bootstrap-workflow\.mjs/,
	"CI must execute the mutation suite and clean bootstrap gate",
);

if (failures.length > 0) {
	process.stderr.write(
		`Kaana catalogue bootstrap gate failed:\n- ${failures.join("\n- ")}\n`,
	);
	process.exit(1);
}

process.stdout.write(
	"Kaana catalogue bootstrap stays dry-run-first, exact-ID, plan-bound, PostgreSQL-only and result-allowlisted.\n",
);
