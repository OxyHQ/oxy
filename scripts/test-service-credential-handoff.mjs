#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const fixture = mkdtempSync(join(tmpdir(), "oxy-credential-handoff-"));
const bin = join(fixture, "bin");
mkdirSync(bin);

writeFileSync(
  join(bin, "aws"),
  `#!/usr/bin/env bash
set -euo pipefail
name=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--name" ]; then name="$2"; shift 2; else shift; fi
done
value=$(</dev/stdin)
file="$TEST_STATE/$(printf '%s' "$name" | tr '/' '_')"
marker="$TEST_STATE/failed$(printf '%s' "$name" | tr '/' '_')"
if [ "$name" = "$FAIL_PARAMETER" ] && [ ! -e "$marker" ]; then
  touch "$marker"
  exit 42
fi
printf '%s' "$value" >"$file"
`,
);
writeFileSync(
  join(bin, "curl"),
  `#!/usr/bin/env bash
set -euo pipefail
payload=$(</dev/stdin)
key=$(jq -r '.apiKey' <<<"$payload")
secret=$(jq -r '.apiSecret' <<<"$payload")
[ "$key" = "$(<"$TEST_STATE/_oxy_test_key")" ]
[ "$secret" = "$(<"$TEST_STATE/_oxy_test_secret")" ]
printf '200'
`,
);
chmodSync(join(bin, "aws"), 0o755);
chmodSync(join(bin, "curl"), 0o755);

const oldKey = `oxy_dk_${crypto.randomBytes(24).toString("hex")}`;
const oldSecret = crypto.randomBytes(32).toString("hex");
const newKey = `oxy_dk_${crypto.randomBytes(24).toString("hex")}`;
const newSecret = crypto.randomBytes(32).toString("hex");
writeFileSync(join(fixture, "_oxy_test_key"), oldKey);
writeFileSync(join(fixture, "_oxy_test_secret"), oldSecret);
const recoveryPackage = JSON.stringify({ publicKey: newKey, secret: newSecret });
const env = {
	...process.env,
	PATH: `${bin}:${process.env.PATH}`,
	TEST_STATE: fixture,
	FAIL_PARAMETER: "/oxy/test/key",
};

const first = spawnSync(
  "bash",
  [".github/scripts/handoff-service-credential-pair.sh", "/oxy/test/key", "/oxy/test/secret"],
  { cwd: process.cwd(), env, input: recoveryPackage, encoding: "utf8" },
);
assert.notEqual(first.status, 0, "the injected public-key write must fail");
assert.equal(readFileSync(join(fixture, "_oxy_test_key"), "utf8"), oldKey);
assert.equal(readFileSync(join(fixture, "_oxy_test_secret"), "utf8"), newSecret, first.stderr);

const retry = spawnSync(
  "bash",
  [".github/scripts/handoff-service-credential-pair.sh", "/oxy/test/key", "/oxy/test/secret"],
  { cwd: process.cwd(), env, input: recoveryPackage, encoding: "utf8" },
);
assert.equal(retry.status, 0, retry.stderr);
assert.equal(readFileSync(join(fixture, "_oxy_test_key"), "utf8"), newKey);
assert.equal(readFileSync(join(fixture, "_oxy_test_secret"), "utf8"), newSecret);

// A failed atomic SSM overwrite leaves the pre-existing envelope key durable.
// The workflow's trap has already been switched to preserve this parameter, so
// its exact task/log recovery path can reconstruct this same package.
const recoveryParameter = "/oxy/_ops/service-credential-alia-34557117644-2";
const recoveryFile = join(fixture, "_oxy__ops_service-credential-alia-34557117644-2");
const encryptionKey = crypto.randomBytes(32).toString("hex");
writeFileSync(recoveryFile, encryptionKey);
const failedPersistence = spawnSync(
	"bash",
	[
		".github/scripts/put-secure-parameter.sh",
		recoveryParameter,
		"overwrite",
	],
	{
		cwd: process.cwd(),
		env: { ...env, FAIL_PARAMETER: recoveryParameter },
		input: recoveryPackage,
		encoding: "utf8",
	},
);
assert.notEqual(failedPersistence.status, 0);
assert.equal(readFileSync(recoveryFile, "utf8"), encryptionKey);

process.stdout.write("Partial service-credential handoff is repaired by exact package replay.\n");
