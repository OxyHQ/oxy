import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor/expo-native");
const original = path.join(vendor, "expo-cli-57.0.23-upstream.tgz");
const expected = JSON.parse(
	fs.readFileSync(path.join(vendor, "upstream-integrity.json"), "utf8"),
);
const bytes = fs.readFileSync(original);
assert.equal(
	`sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	expected.integrity,
);
assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oxy-expo-fork-"));
try {
	execFileSync("tar", ["-xzf", original, "-C", scratch]);
	const fork = path.join(scratch, "package");
	const manifest = path.join(fork, "package.json");
	const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
	assert.equal(pkg.name, "@expo/cli");
	assert.equal(pkg.version, "57.0.23");
	assert.equal(pkg.dependencies["node-forge"], "^1.3.3");
	pkg.dependencies = Object.fromEntries(
		Object.entries(pkg.dependencies).filter(([name]) => name !== "node-forge"),
	);
	pkg.name = "@oxy.so/expo-cli-native";
	pkg.version = "57.0.23+oxy.native.1";
	pkg.oxyUpstream = {
		name: "@expo/cli",
		version: "57.0.23",
		integrity: expected.integrity,
	};
	fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
	const security = path.join(fork, "build/src/run/ios/codeSigning/Security.js");
	let source = fs.readFileSync(security, "utf8");
	assert.equal(source.split('require("node-forge")').length, 2);
	assert.equal(
		source.split("_nodeforge().default.pki.certificateFromPem(pem)").length,
		2,
	);
	source = source
		.replaceAll("_nodeforge", "_nativeCodeSigning")
		.replace(
			'require("node-forge")',
			'require("@expo/code-signing-certificates")',
		)
		.replace(
			"_nativeCodeSigning().default.pki.certificateFromPem(pem)",
			"_nativeCodeSigning().default.convertCertificatePEMToCertificate(pem)",
		);
	fs.writeFileSync(security, source);
	// This compiled-file fork has no regenerated source map; prevent a stale map
	// from presenting the upstream Forge implementation as the executed code.
	fs.rmSync(`${security}.map`);
	fs.writeFileSync(
		security,
		source.replace(/\n\/\/# sourceMappingURL=Security\.js\.map\s*$/, "\n"),
	);
	execFileSync("bun", ["pm", "pack", "--destination", vendor], {
		cwd: fork,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const native = path.join(root, "tooling/expo-code-signing-native");
	execFileSync("bun", ["run", "build"], {
		cwd: native,
		stdio: ["ignore", "pipe", "pipe"],
	});
	execFileSync("bun", ["pm", "pack", "--destination", vendor], {
		cwd: native,
		stdio: ["ignore", "pipe", "pipe"],
	});
	console.log(
		"Verified upstream archive; built private native adapter and explicitly identified Expo CLI fork.",
	);
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
