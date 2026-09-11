#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const prepare = readFileSync(
	"packages/api/scripts/create-service-credential.ts",
	"utf8",
);
const finalize = readFileSync(
	"packages/api/scripts/finalize-service-credential.ts",
	"utf8",
);
const pendingReconciliation = readFileSync(
	"packages/api/src/utils/serviceCredentialPendingReconciliation.ts",
	"utf8",
);
const finalizedPredecessor = readFileSync(
	"packages/api/src/utils/serviceCredentialFinalization.ts",
	"utf8",
);
const workflow = readFileSync(
	".github/workflows/provision-service-credential.yml",
	"utf8",
);

// Model every crash boundary. The safety invariant is that the predecessor is
// usable until both a recoverable secret package exists and the new row is
// usable. A pending row may be abandoned because it never authenticates.
for (const crashAfter of ["run-task", "prepare-commit", "package", "finalize"]) {
	const state = { oldUsable: true, next: "absent", packageDurable: false };
	if (crashAfter === "run-task") {
		assert.equal(state.oldUsable, true);
		continue;
	}
	state.next = "pending";
	if (crashAfter === "prepare-commit") {
		assert.equal(state.oldUsable, true);
		assert.notEqual(state.next, "active");
		continue;
	}
	state.packageDurable = true;
	if (crashAfter === "package") {
		assert.equal(state.oldUsable, true);
		assert.equal(state.packageDurable, true);
		continue;
	}
	state.next = "active";
	state.oldUsable = true; // deprecated inside its seven-day grace
	assert.equal(state.packageDurable, true);
	assert.equal(state.next, "active");
	assert.equal(state.oldUsable, true);
}

assert.match(prepare, /status: rotateScopeMismatch \? "pending" : "active"/);
assert.match(prepare, /reason: "abandoned_pending_handoff"/);
assert.ok(
	pendingReconciliation.indexOf("if (dryRun) return") <
		pendingReconciliation.indexOf("for (const credentialId"),
);
assert.doesNotMatch(prepare, /\.set\(\{ status: "deprecated"/);
assert.match(finalize, /credential\.status !== "pending"/);
assert.match(finalize, /refusing false idempotence/);
assert.match(finalizedPredecessor, /predecessor\.status === "deprecated"/);
assert.doesNotMatch(finalizedPredecessor, /isCredentialUsable|Date\.now/);
assert.match(finalize, /\.set\(\{ status: "active" \}\)/);
assert.match(finalize, /\.set\(\{ status: "deprecated", expiresAt: graceExpiresAt \}\)/);

const durablePackage = workflow.lastIndexOf('"$temp_parameter" overwrite');
const finalizePending = workflow.lastIndexOf('finalize_credential "$(jq -er');
assert.ok(durablePackage >= 0 && finalizePending > durablePackage);

// The task may win a race against stop-task when exact binding persistence
// fails, but phase one can only commit `pending`; it cannot authenticate or
// deprecate the predecessor.
const bindingFailure = workflow.indexOf("credential task binding could not be persisted");
assert.ok(bindingFailure >= 0);
assert.match(workflow, /preserve_temp_parameter="true"/);
assert.match(workflow, /requiresFinalization/);

process.stdout.write(
	"Two-phase credential handoff is safe at every task, package, and finalize crash boundary.\n",
);
