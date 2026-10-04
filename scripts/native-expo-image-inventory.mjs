import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function inspectImage(root, expected) {
	const packages = [];
	const forbidden = [];
	assert.deepEqual(Object.keys(expected).sort(), [
		"@oxy.so/expo-cli-native",
		"@oxy.so/expo-code-signing-native",
	]);
	function walk(dir) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.name === "node-forge" || entry.name.startsWith("node-forge@"))
				forbidden.push(file);
			if (entry.isDirectory()) {
				if (!["/proc", "/sys", "/dev", "/native-expo-proof"].includes(file))
					walk(file);
			} else if (entry.isFile() && entry.name === "package.json") {
				const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
				if (pkg.name === "node-forge") forbidden.push(file);
				const identity = expected[pkg.name];
				if (identity) {
					assert.equal(pkg.version, identity.version);
					const root = path.dirname(file);
					for (const [name, wanted] of Object.entries(identity.files)) {
						const installedFile = path.join(root, name);
						assert(
							fs.lstatSync(installedFile).isFile(),
							"Native package file must be physical, not a symlink",
						);
						const bytes = fs.readFileSync(installedFile);
						assert.equal(
							sha256(bytes),
							wanted,
							`Installed image bytes differ: ${pkg.name}/${name}`,
						);
					}
					packages.push({
						name: pkg.name,
						version: pkg.version,
						root,
						verifiedFiles: Object.keys(identity.files).length,
					});
				}
			}
		}
	}
	walk(root);
	assert.equal(forbidden.length, 0, "Actual image retains a Forge copy");
	for (const name of Object.keys(expected))
		assert(
			packages.some((pkg) => pkg.name === name),
			`Expected native package missing: ${name}`,
		);
	return packages;
}
if (
	process.argv[1] &&
	import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
	const [expectedPath, sourceSha, imageId] = process.argv.slice(2);
	assert.match(sourceSha, /^[a-f0-9]{40}$/);
	assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
	const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
	const packages = inspectImage("/", expected);
	console.log(
		JSON.stringify({
			schemaVersion: 1,
			sourceSha,
			imageId,
			forgeCopies: 0,
			installedNativePackages: packages,
			expectedFilesSha256: sha256(fs.readFileSync(expectedPath)),
			approval: false,
		}),
	);
}
