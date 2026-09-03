#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repo = process.cwd();
const gate = join(repo, "scripts/check-kaana-catalogue-bootstrap-workflow.mjs");
const files = [
	".github/workflows/bootstrap-kaana-catalogue.yml",
	".github/workflows/ci.yml",
	"packages/api/scripts/bootstrap-kaana-catalogue.ts",
	"packages/api/src/config/kaanaInitialCatalogue.ts",
	"packages/api/src/scripts/kaanaCatalogueBootstrapPlan.ts",
];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "oxy-kaana-catalogue-gate-"));
	for (const file of files) {
		const target = join(root, file);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(repo, file), target);
	}
	return root;
}

function mutate(root, file, from, to) {
	const path = join(root, file);
	const source = readFileSync(path, "utf8");
	assert.ok(source.includes(from), `${file} fixture lost its mutation anchor`);
	writeFileSync(path, source.replace(from, to));
}

function verdict(root, expected, label = "clean fixture") {
	const result = spawnSync(process.execPath, [gate], {
		cwd: repo,
		env: { ...process.env, KAANA_CATALOGUE_BOOTSTRAP_GATE_ROOT: root },
		encoding: "utf8",
	});
	assert.equal(
		result.status,
		expected,
		`${label}: ${result.stderr || result.stdout}`,
	);
}

const roots = [];
try {
	const clean = fixture();
	roots.push(clean);
	verdict(clean, 0);

	for (const mutation of [
		{
			file: ".github/workflows/bootstrap-kaana-catalogue.yml",
			from: "if: github.ref == 'refs/heads/main'",
			to: "if: github.ref != ''",
		},
		{
			file: ".github/workflows/bootstrap-kaana-catalogue.yml",
			from: ".image == $image",
			to: '.image | startswith("237343248947.dkr.ecr")',
		},
		{
			file: ".github/workflows/bootstrap-kaana-catalogue.yml",
			from: 'taskRoleArn == "arn:aws:iam::237343248947:role/oxy-kaana-catalogue-bootstrap"',
			to: 'taskRoleArn | type == "string"',
		},
		{
			file: ".github/workflows/bootstrap-kaana-catalogue.yml",
			from: 'name:"DATABASE_URL",',
			to: 'name:"MONGODB_URI",',
		},
		{
			file: ".github/workflows/bootstrap-kaana-catalogue.yml",
			from: "dry_envelope=$(run_task",
			to: "dry_envelope=$(printf",
		},
		{
			file: ".github/workflows/bootstrap-kaana-catalogue.yml",
			from: "echo '::error::apply outcome is ambiguous; no retry or success claim was made'",
			to: "echo 'apply succeeded'",
		},
		{
			file: ".github/workflows/bootstrap-kaana-catalogue.yml",
			from: "GROQ_DEPLOYMENT_ID: dep_groq_openai_gpt_oss_120b_observed_2026_09_01",
			to: "GROQ_DEPLOYMENT_ID: dep_groq_selected_by_name",
		},
		{
			file: ".github/workflows/bootstrap-kaana-catalogue.yml",
			from: 'REVIEWER_USER_ID" != "$REVIEWER_USER_ID_EXPECTED"',
			to: 'REVIEWER_USER_ID" != ""',
		},
		{
			file: "packages/api/scripts/bootstrap-kaana-catalogue.ts",
			from: "sql`select pg_advisory_xact_lock",
			to: "sql`select now() from (select 1) as ignored where 1 = 0 or ",
		},
			{
				file: "packages/api/scripts/bootstrap-kaana-catalogue.ts",
				from: '.where(eq(users.id, reviewerUserId))\n    .for("update");',
				to: ".where(eq(users.id, reviewerUserId));",
			},
		{
			file: "packages/api/scripts/bootstrap-kaana-catalogue.ts",
			from: ".where(eq(inferenceModels.modelId, KAANA_INITIAL_MODEL_ID))",
			to: ".where(eq(inferenceModels.displayName, KAANA_INITIAL_MODEL_ID))",
		},
		{
			file: "packages/api/scripts/bootstrap-kaana-catalogue.ts",
			from: ".where(eq(inferenceDeployments.internalRouteId, provider.deploymentId))",
			to: ".where(eq(inferenceDeployments.providerSlug, provider.slug))",
		},
		{
			file: "packages/api/scripts/bootstrap-kaana-catalogue.ts",
			from: "const candidate = requireExactlyOne(\n      `Routing-profile primary key ${profile.id} reviewed candidate`,\n      candidateRows,\n    );",
			to: "const candidate = candidateRows.at(0);",
		},
		{
			file: "packages/api/src/scripts/kaanaCatalogueBootstrapPlan.ts",
			from: "expectedPlanSha256 !== authorization.actualPlanSha256",
			to: "expectedPlanSha256 === authorization.actualPlanSha256",
		},
		{
			file: "packages/api/scripts/bootstrap-kaana-catalogue.ts",
			from: "reviewedFactsSha256: summaryWithoutPlan.reviewedFactsSha256,",
			to: "reviewedFactsSha256: \"0\".repeat(64),",
		},
		{
			file: "packages/api/src/scripts/kaanaCatalogueBootstrapPlan.ts",
			from: "readonly inventorySnapshotId: string;",
			to: "readonly inventorySnapshotId: string;\n\treadonly inventoryVersionId: string;",
		},
	]) {
		const root = fixture();
		roots.push(root);
		mutate(root, mutation.file, mutation.from, mutation.to);
		verdict(root, 1, `${mutation.file}: ${mutation.from}`);
	}
} finally {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write("Kaana catalogue bootstrap gate mutation tests passed.\n");
