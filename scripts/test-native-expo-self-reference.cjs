/** Execute the sealed CLI module in a private directory with no package alias. */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const test = require("node:test");
const root = path.resolve(__dirname, "..");
const archive = process.argv[2]
	? path.resolve(process.argv[2])
	: path.join(
			root,
			"vendor/expo-native/oxy.so-expo-cli-native-57.0.23+oxy.native.3.tgz",
		);
const scratch = fs.mkdtempSync(
	path.join(os.tmpdir(), "oxy-cli-self-reference-"),
);
execFileSync("tar", ["-xzf", archive, "-C", scratch]);
const packageRoot = path.join(scratch, "package");
const source = path.join(
	packageRoot,
	"build/src/start/server/metro/externals.js",
);
const local = createRequire(source);
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
test("Metro externals imports without @expo/cli self alias and resolves own shim bytes", () => {
	assert.throws(() => local.resolve("@expo/cli/package.json"), {
		code: "MODULE_NOT_FOUND",
	});
	const externals = local(source);
	const relative = "react-native-web/dist/exports/BackHandler/index.js";
	const shim = externals.shouldCreateVirtualShim(relative);
	assert.equal(shim, path.join(packageRoot, "static/shims", relative));
	assert.equal(
		fs.readFileSync(shim, "utf8"),
		fs.readFileSync(path.join(packageRoot, "static/shims", relative), "utf8"),
	);
	assert.equal(externals.shouldCreateVirtualShim("not_a_shim.js"), null);
	assert.equal(externals.isNodeExternal("node:fs"), "fs");
});
test("Polyfill resolver points at own real Metro require module without self alias", () => {
	const file = path.join(
		packageRoot,
		"build/src/start/server/metro/withMetroMultiPlatform.js",
	);
	const text = fs.readFileSync(file, "utf8");
	const match = text.match(
		/const metroRequirePolyfill = require.resolve\('([^']+)'\)/,
	);
	assert(match);
	const target = createRequire(file).resolve(match[1]);
	assert.equal(
		target,
		path.join(packageRoot, "build/metro-require/require.js"),
	);
	assert(fs.readFileSync(target).length > 0);
});
test("All remaining own template resolvers target packaged files; project lookup preserved", () => {
	const rows = [
		[
			"build/src/start/server/metro/MetroBundlerDevServer.js",
			"../../../../../static/template/[...rsc]+api.ts",
		],
		[
			"build/src/start/server/metro/createServerRouteMiddleware.js",
			"../../../../../static/template/[...rsc]+api.ts",
		],
		[
			"build/src/lint/ESlintPrerequisite.js",
			"../../../static/template/eslint.config.js",
		],
		[
			"build/src/customize/templates.js",
			"../../../static/template/eslint.config.js",
		],
	];
	for (const [file, relative] of rows) {
		const target = createRequire(path.join(packageRoot, file)).resolve(
			relative,
		);
		assert(target.startsWith(packageRoot + path.sep));
		assert(fs.statSync(target).isFile());
	}
	const customize = fs.readFileSync(
		path.join(packageRoot, "build/src/customize/templates.js"),
		"utf8",
	);
	assert(
		customize.includes(
			"(projectRoot, '@expo/cli/static/template/' + moduleId)",
		),
	);
	const prebuild = fs.readFileSync(
		path.join(packageRoot, "build/src/prebuild/resolveLocalTemplate.js"),
		"utf8",
	);
	assert(prebuild.includes("_path().default.resolve(__dirname, '../../../')"));
	assert.equal(
		path.resolve(packageRoot, "build/src/prebuild", "../../../"),
		packageRoot,
	);
});
