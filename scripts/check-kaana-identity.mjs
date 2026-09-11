#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(process.env.KAANA_IDENTITY_GATE_ROOT ?? process.cwd());
const problems = [];

const canonicalDocuments = new Map([
	[
		"docs/adr/0011-inference-data-plane-name.md",
		[
			"Kaana is the canonical inference data-plane name",
			"OxyHQ/Kaana",
			"https://kaana.ai",
			"X-Oxy-Kaana-*",
		],
	],
	[
		"docs/adr/0006-oxy-kaana-boundary.md",
		["Kaana executes inference", "Kaana PostgreSQL"],
	],
	[
		"docs/adr/0015-oxy-kaana-envelope-signing.md",
		["The Oxy → Kaana envelope", "OxyHQ/Kaana", "X-Oxy-Kaana-Key-Id"],
	],
	[
		"docs/inference/request-routing.md",
		["Canonical AI request routing", "https://kaana.ai", "Kaana's PostgreSQL"],
	],
	[
		"docs/runbooks/kaana-edge-signing-key-rotation.md",
		[
			"rotating the Oxy→Kaana edge signing key",
			"OxyHQ/Kaana",
			"KAANA_EDGE_SIGNING_PRIVATE_KEY",
		],
	],
]);

const retiredPaths = [
	".github/workflows/cloudflare-dns-relay.yml",
	"docs/adr/0006-oxy-relay-boundary.md",
	"docs/adr/0015-oxy-relay-envelope-signing.md",
	"docs/runbooks/relay-edge-signing-key-rotation.md",
	"packages/api/src/config/relayDataPlane.ts",
	"packages/api/src/services/httpRelayClient.ts",
	"packages/api/src/services/relayClient.ts",
];

const excludedDirectories = new Set([
	".git",
	".worktrees",
	"coverage",
	"dist",
	"lib",
	"node_modules",
]);
const excludedFiles = new Set([
	"scripts/check-kaana-identity.mjs",
	"scripts/test-check-kaana-identity.mjs",
]);
const textExtensions = new Set([
	".cjs",
	".env",
	".example",
	".js",
	".jsx",
	".json",
	".md",
	".mdx",
	".mjs",
	".sh",
	".ts",
	".tsx",
	".yaml",
	".yml",
]);

const oldBindings =
	'["RELAY_BASE_URL","RELAY_EDGE_SIGNING_KEY_ID","RELAY_EDGE_SIGNING_PRIVATE_KEY","ALIA_API_KEY","AI_LABELING_MODEL"]';
const approvedRelayLines = new Map([
	[
		".github/scripts/test-deploy-ecs-image.sh",
		new Set([`grep -F '${oldBindings}' \\`]),
	],
	[
		"docs/architecture/inference-responsibility-matrix.md",
		new Set([
			"MCP/TNP relay remain valid. None denotes inference and none is a Kaana alias.",
		]),
	],
]);

const forbiddenContent = [
	["retired repository identity", /\bOxyHQ\/Relay\b/i],
	["retired signed hostname", /\b(?:[a-z0-9-]+\.)*relay\.oxy\.so\b/i],
	["retired signed header", /\bX-Oxy-Relay-[A-Za-z-]*\b/i],
	["retired signing domain separator", /\boxy-relay-envelope(?::v\d+)?\b/i],
	[
		"retired inference symbol",
		/\b(?:HttpRelayClient|RelayClient|RelayDataPlane|httpRelayClient|relayClient|relayDataPlane|relayStreaming)\b/,
	],
	["retired inference application fixture", /\bappName\s*:\s*['"]relay['"]/i],
	[
		"retired inference environment binding",
		/\bRELAY_(?:BASE_URL|EDGE_SIGNING_(?:KEY_ID|PRIVATE_KEY))\b/,
	],
	[
		"retired inference product prose",
		/(?:\bRelay\b.{0,96}\b(?:credential|data[ -]?plane|inference|model|provider)\b|\b(?:credential|data[ -]?plane|inference|model|provider)\b.{0,96}\bRelay\b)/i,
	],
];

function isInferenceIdentitySurface(path) {
	return (
		path.startsWith("docs/inference/") ||
		path === "docs/architecture/inference-responsibility-matrix.md" ||
		/^docs\/adr\/00(?:0[5-9]|1\d)-/.test(path) ||
		path.startsWith("docs/runbooks/kaana-") ||
		/(?:^|\/)(?:[^/]*(?:inference|kaana)[^/]*)\.(?:[cm]?[jt]sx?|md|ya?ml|sh)$/i.test(
			path,
		) ||
		path === ".github/workflows/provision-service-credential.yml"
	);
}

function isApprovedOccurrence(path, index, lines) {
	const trimmed = lines[index].trim();
	if (
		path === ".github/workflows/deploy-aws.yml" &&
		trimmed === oldBindings &&
		lines[index - 1]?.trim() === "TASK_REMOVE_NAMES_JSON: >-"
	)
		return true;
	return approvedRelayLines.get(path)?.has(trimmed) ?? false;
}

function normalizedPath(path) {
	return relative(root, path).split("\\").join("/");
}

function isTextFile(path) {
	const name = path.split("/").at(-1) ?? "";
	return (
		textExtensions.has(extname(name)) ||
		name === "Dockerfile" ||
		name.startsWith(".env")
	);
}

function walk(directory, files = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walk(path, files);
		else if (entry.isFile() && isTextFile(path)) files.push(path);
	}
	return files;
}

for (const [path, requiredFragments] of canonicalDocuments) {
	const absolutePath = join(root, path);
	if (!existsSync(absolutePath)) {
		problems.push(`${path}: canonical Kaana document is missing`);
		continue;
	}
	const contents = readFileSync(absolutePath, "utf8");
	for (const fragment of requiredFragments) {
		const count = contents.split(fragment).length - 1;
		if (count < 1)
			problems.push(
				`${path}: canonical marker ${JSON.stringify(fragment)} is missing`,
			);
	}
}

for (const path of retiredPaths) {
	if (existsSync(join(root, path)))
		problems.push(`${path}: retired inference path returned`);
}

let scannedFiles = 0;
for (const absolutePath of walk(root)) {
	const path = normalizedPath(absolutePath);
	if (excludedFiles.has(path)) continue;
	scannedFiles += 1;
	const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		if (isApprovedOccurrence(path, index, lines)) continue;
		for (const [label, pattern] of forbiddenContent) {
			if (
				label === "retired inference product prose" &&
				!isInferenceIdentitySurface(path)
			)
				continue;
			if (pattern.test(line)) problems.push(`${path}:${index + 1}: ${label}`);
		}
	}
}

if (scannedFiles < canonicalDocuments.size) {
	problems.push(
		`text-file census saw ${scannedFiles} files; expected at least ${canonicalDocuments.size}`,
	);
}

if (problems.length > 0) {
	console.error("Kaana identity is BROKEN:\n");
	for (const problem of problems) console.error(`- ${problem}`);
	process.exit(1);
}

console.log(
	`Kaana identity is exact across ${scannedFiles} text files; only approved removal receipts and unrelated relay roles remain.`,
);
