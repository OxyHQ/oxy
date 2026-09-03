#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = join(repoRoot, "scripts", "check-kaana-identity.mjs");
const fixtures = [];
const failures = [];
const oldBindings =
	'["RELAY_BASE_URL","RELAY_EDGE_SIGNING_KEY_ID","RELAY_EDGE_SIGNING_PRIVATE_KEY","ALIA_API_KEY","AI_LABELING_MODEL"]';

const canonicalFiles = {
	"docs/adr/0011-inference-data-plane-name.md": [
		"# ADR 0011 — Kaana is the canonical inference data-plane name",
		"The repository is OxyHQ/Kaana.",
		"The origin is https://kaana.ai.",
		"Headers use X-Oxy-Kaana-*.",
	].join("\n"),
	"docs/adr/0006-oxy-kaana-boundary.md":
		"Kaana executes inference with Kaana PostgreSQL.\n",
	"docs/adr/0015-oxy-kaana-envelope-signing.md": [
		"# The Oxy → Kaana envelope",
		"Repository: OxyHQ/Kaana.",
		"Header: X-Oxy-Kaana-Key-Id.",
	].join("\n"),
	"docs/inference/request-routing.md": [
		"# Canonical AI request routing",
		"Origin: https://kaana.ai.",
		"Provider keys: Kaana's PostgreSQL database.",
	].join("\n"),
	"docs/runbooks/kaana-edge-signing-key-rotation.md": [
		"# Runbook — rotating the Oxy→Kaana edge signing key",
		"Repository: OxyHQ/Kaana.",
		"Secret: KAANA_EDGE_SIGNING_PRIVATE_KEY.",
	].join("\n"),
};

function fixture(extraFiles = {}, removeFiles = []) {
	const root = mkdtempSync(join(tmpdir(), "oxy-kaana-identity-"));
	fixtures.push(root);
	for (const [path, contents] of Object.entries({
		...canonicalFiles,
		...extraFiles,
	})) {
		if (removeFiles.includes(path)) continue;
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, contents);
	}
	return root;
}

function verdict(name, root, expectedCode, expectedText) {
	let code = 0;
	let output = "";
	try {
		output = execFileSync("node", [check], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, KAANA_IDENTITY_GATE_ROOT: root },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		code = error.status ?? 1;
		output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
	}
	if (code !== expectedCode || !output.includes(expectedText)) {
		failures.push(
			`${name}: expected exit ${expectedCode} containing ${JSON.stringify(expectedText)}; got ${code}\n${output}`,
		);
	}
}

verdict(
	"canonical identity and unrelated relay roles",
	fixture({
		"docs/protocol-roles.md": [
			"SMTP relay uses SMTP_RELAY_HOST.",
			"ATProto Relay distributes events.",
			"The OAuth popup relay posts to its opener.",
			"The device ciphertext relay cannot decrypt the payload.",
			"A TNP relay forwards a protocol message.",
		].join("\n"),
	}),
	0,
	"Kaana identity is exact",
);
verdict(
	"approved removal receipts",
	fixture({
		".github/workflows/deploy-aws.yml": `TASK_REMOVE_NAMES_JSON: >-\n  ${oldBindings}\n`,
		".github/scripts/test-deploy-ecs-image.sh": [
			`grep -F '${oldBindings}' \\`,
			'  "$workflow_file" >/dev/null',
		].join("\n"),
	}),
	0,
	"Kaana identity is exact",
);

const mutations = [
	[
		"repository alias",
		"See OxyHQ/Relay for the data plane.",
		"retired repository identity",
	],
	[
		"old hostname",
		"Use https://relay.oxy.so for signed calls.",
		"retired signed hostname",
	],
	["old header", "Send X-Oxy-Relay-Key-Id.", "retired signed header"],
	[
		"old domain separator",
		"Sign oxy-relay-envelope:v1.",
		"retired signing domain separator",
	],
	["old symbol", "Construct httpRelayClient here.", "retired inference symbol"],
	[
		"old application fixture",
		"const claim = { appName: 'relay' };",
		"retired inference application fixture",
	],
	[
		"old live environment binding",
		"RELAY_BASE_URL=https://example.invalid",
		"retired inference environment binding",
	],
	[
		"old product prose",
		"The Relay provider executes inference.",
		"retired inference product prose",
	],
];

for (const [name, contents, expectedText] of mutations) {
	verdict(
		name,
		fixture({ [`docs/inference/${name.replaceAll(" ", "-")}.md`]: contents }),
		1,
		expectedText,
	);
}

verdict(
	"retired path",
	fixture({ "packages/api/src/services/httpRelayClient.ts": "export {};\n" }),
	1,
	"retired inference path returned",
);
verdict(
	"removal binding outside the removal field",
	fixture({ ".github/workflows/deploy-aws.yml": oldBindings }),
	1,
	"retired inference environment binding",
);
verdict(
	"missing canonical document",
	fixture({}, ["docs/adr/0011-inference-data-plane-name.md"]),
	1,
	"canonical Kaana document is missing",
);

for (const root of fixtures) rmSync(root, { recursive: true, force: true });
if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}

console.log(
	`Kaana identity guard discriminated ${fixtures.length} fixture cases.`,
);
