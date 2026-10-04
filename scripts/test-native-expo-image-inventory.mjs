import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectImage } from "./native-expo-image-inventory.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-image-"));
	try {
		const expected = {};
		for (const name of [
			"@oxy.so/expo-cli-native",
			"@oxy.so/expo-code-signing-native",
		]) {
			const dir = path.join(root, name);
			fs.mkdirSync(dir, { recursive: true });
			const files = {
				"package.json": JSON.stringify({ name, version: "fixture" }),
				"index.cjs": "module.exports = {}",
			};
			for (const [file, bytes] of Object.entries(files))
				fs.writeFileSync(path.join(dir, file), bytes);
			expected[name] = {
				version: "fixture",
				files: Object.fromEntries(
					Object.entries(files).map(([file, bytes]) => [file, sha(bytes)]),
				),
			};
		}
		fn(root, expected);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}
test("actual native files and two identities are required", () =>
	fixture((root, expected) =>
		assert.equal(inspectImage(root, expected).length, 2),
	));
test("cached unreachable Forge path is rejected", () =>
	fixture((root, expected) => {
		fs.mkdirSync(path.join(root, "node-forge@1.4.0"));
		assert.throws(() => inspectImage(root, expected), /Forge/);
	}));
test("renamed Forge package identity is rejected", () =>
	fixture((root, expected) => {
		const dir = path.join(root, "renamed");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "node-forge" }),
		);
		assert.throws(() => inspectImage(root, expected), /Forge/);
	}));
test("tampered native code fails byte integrity", () =>
	fixture((root, expected) => {
		fs.appendFileSync(
			path.join(root, "@oxy.so/expo-cli-native/index.cjs"),
			"tamper",
		);
		assert.throws(() => inspectImage(root, expected), /bytes differ/);
	}));
test("missing native package fails even when Forge is absent", () =>
	fixture((root, expected) => {
		fs.rmSync(path.join(root, "@oxy.so/expo-cli-native"), { recursive: true });
		assert.throws(() => inspectImage(root, expected), /missing/);
	}));

test("native file symlink cannot substitute mounted proof bytes", () =>
	fixture((root, expected) => {
		const file = path.join(root, "@oxy.so/expo-cli-native/index.cjs");
		const replacement = path.join(root, "replacement.cjs");
		fs.renameSync(file, replacement);
		fs.symlinkSync(replacement, file);
		assert.throws(() => inspectImage(root, expected), /physical/);
	}));
