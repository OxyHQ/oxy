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
if [ "$name" = "/oxy/test/key" ] && [ ! -e "$TEST_STATE/failed-once" ]; then
  touch "$TEST_STATE/failed-once"
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
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_STATE: fixture };

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

process.stdout.write("Partial service-credential handoff is repaired by exact package replay.\n");
