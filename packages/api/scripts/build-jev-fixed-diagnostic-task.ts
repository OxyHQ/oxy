import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildIsolatedReadbackTaskDefinition } from "../src/scripts/inboxPrincipalReadbackTask";
import { JEV_PRINCIPALS_READBACK_TASK_PROFILE } from "../src/scripts/jevPrincipalsReadbackTask";
const [arn, metadata] = process.argv.slice(2);
if (!arn || !metadata || process.argv.length !== 4) throw Error("exact_arn_and_metadata_required");
const source = readFileSync(new URL("./diagnose-jev-authority-fixed.mjs", import.meta.url), "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
if (sourceSha256 !== "4c459ba0f8884b0b6cb37a077bfa7b715a7ba08fb83fbc54791d5039a83c16e4") throw Error("fixed_source_hash_mismatch");
const task = buildIsolatedReadbackTaskDefinition({expectedTaskDefinitionArn:arn, liveTaskDefinition:JSON.parse(readFileSync(metadata,"utf8"))},
  {...JEV_PRINCIPALS_READBACK_TASK_PROFILE, family:"oxy-oxy-api-jev-fixed-diagnostic", command:["--eval",source]});
console.error("JEV_FIXED_DIAGNOSTIC_SOURCE_SHA256="+sourceSha256);
console.log(JSON.stringify(task,null,2));
