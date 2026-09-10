#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.INBOX_ROUTING_READBACK_GATE_ROOT ?? process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/inbox-routing-profile-readback.yml");
const script = read("packages/api/scripts/readback-inbox-routing-profile.ts");
const validator = read(
  "packages/api/src/scripts/inboxRoutingProfileReadback.ts",
);

const failures = [];
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message);
};
const forbid = (source, pattern, message) => {
  if (pattern.test(source)) failures.push(message);
};

requireMatch(
  workflow,
  /workflow_dispatch:[\s\S]*?expected_live_task_definition_arn:[\s\S]*?required: true[\s\S]*?expected_live_image_digest:[\s\S]*?required: true[\s\S]*?routing_profile_id:[\s\S]*?required: true[\s\S]*?reason:[\s\S]*?required: true/,
  "the readback must be manually bounded by an exact task, image, profile primary key and reason",
);
forbid(
  workflow,
  /\n\s+default:/,
  "manual readback inputs must carry no operational defaults",
);
requireMatch(
  workflow,
  /if: github\.ref == 'refs\/heads\/main'/,
  "the production readback must run only from main",
);
requireMatch(
  workflow,
  /role-to-assume: arn:aws:iam::237343248947:role\/oxy-github-deploy/,
  "the readback must use the reviewed GitHub OIDC role",
);
requireMatch(
  workflow,
  /ROUTING_PROFILE_ID" != '01a06477-94f5-74f0-bc25-4c5c13b93ccd'/,
  "the workflow must independently pin the reviewed Inbox primary key",
);
requireMatch(
  workflow,
  /live_task_definition" != "\$EXPECTED_LIVE_TASK_DEFINITION_ARN"/,
  "the workflow must bind to the exact reviewed live task definition",
);
requireMatch(
  workflow,
  /\[ "\$\(jq '\.deployments \| length' <<<"\$service_json"\)" != 1 \] \|\|[\s\S]*?\.desiredCount > 0[\s\S]*?\.runningCount == \.desiredCount/,
  "the workflow must require exactly one non-empty completed steady deployment",
);
requireMatch(
  workflow,
  /live_image" != "237343248947\.dkr\.ecr\.us-west-2\.amazonaws\.com\/oxy\/oxy-api@\$EXPECTED_LIVE_IMAGE_DIGEST"/,
  "the workflow must bind to the exact immutable live image digest",
);
requireMatch(
  workflow,
  /select\(\.name == "DATABASE_URL"\)[\s\S]*?length == 1[\s\S]*?parameter\/oxy\/oxy-api\/DATABASE_URL/,
  "the workflow must derive the one exact production DATABASE_URL secret binding",
);
requireMatch(
  workflow,
  /\.family = "oxy-oxy-api-inbox-routing-readback"[\s\S]*?del\(\.taskRoleArn\)[\s\S]*?\.environment = \[\][\s\S]*?\.secrets = \[\$database_secret\]/,
  "the throwaway task must drop application IAM and retain only DATABASE_URL",
);
requireMatch(
  workflow,
  /command:\["bun","run","packages\/api\/scripts\/readback-inbox-routing-profile\.ts"\][\s\S]*?environment:\[\s*\{name:"INBOX_ROUTING_PROFILE_READBACK_ID",value:\$profile\}\s*\]/,
  "the task must run only the fixed readback with the exact ID override",
);
requireMatch(
  workflow,
  /INBOX_ROUTING_PROFILE_READBACK_RESULT=[\s\S]*?transactionReadOnly:true[\s\S]*?modelReference:"openai\/gpt-oss-120b@observed-2026-09-01"[\s\S]*?priority:100/,
  "the workflow must validate the complete safe read-only result before reporting success",
);

const minimizedTask = workflow.slice(
  workflow.indexOf("readback_task_json=$(jq"),
  workflow.indexOf("readback_task_definition=''"),
);
requireMatch(
  minimizedTask,
  /\.secrets = \[\$database_secret\]/,
  "the minimized task must preserve DATABASE_URL through its reviewed binding only",
);
forbid(
  minimizedTask,
  /\.secrets\s*=\s*\[(?!\$database_secret\])/,
  "the minimized task must not introduce another secret list",
);
forbid(
  minimizedTask,
  /\.secrets\s*=\s*\[\$database_secret\s*,/,
  "the minimized task must not receive any secret beyond DATABASE_URL",
);
const secretAssignments =
  minimizedTask.match(/\.secrets\s*(?:=|\+=|\|=)/g) ?? [];
if (secretAssignments.length !== 1) {
  failures.push(
    "the minimized task must contain exactly one reviewed secret assignment",
  );
}
forbid(
  minimizedTask,
  /REDIS_URL|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|INBOX_APPLICATION_KEY|KAANA_EDGE|PROVIDER_KEY|API_KEY|SECRET_KEY/,
  "the minimized task must not retain Redis, signing, application or provider authority",
);

requireMatch(
  script,
  /INBOX_ROUTING_PROFILE_READBACK_ID\s*\?\?\s*["']{2}/,
  "the script must take one explicit unnormalized primary key",
);
requireMatch(
  script,
  /tx\.execute\(sql`set transaction read only`\);[\s\S]*?show transaction_read_only[\s\S]*?\.select\(/,
  "the first transaction statement must establish and verify PostgreSQL READ ONLY mode",
);
requireMatch(
  script,
  /\.where\(eq\(inferenceRoutingProfiles\.id, requestedRoutingProfileId\)\)/,
  "the routing profile must be selected only by its exact database primary key",
);
requireMatch(
  script,
  /\.where\(\s*eq\(\s*inferenceRoutingProfileCandidates\.routingProfileId,\s*requestedRoutingProfileId,\s*\),\s*\);/,
  "all candidate rows must be selected only by the exact routing-profile foreign key",
);
requireMatch(
  script,
  /INBOX_ROUTING_PROFILE_READBACK_RESULT=[\s\S]*?JSON\.stringify\(result\)/,
  "the script must emit only the validated operator-safe result projection",
);
forbid(
  script,
  /\.orderBy\(|\.limit\(/,
  "the readback must never choose a first or ordered row",
);
forbid(
  script,
  /eq\(inferenceRoutingProfiles\.(?:slug|displayName)|eq\(inferenceModels\.(?:slug|displayName)/,
  "the readback must never discover a profile or model through a name predicate",
);
forbid(
  script,
  /\.(?:insert|update|delete)\(/,
  "the PostgreSQL readback must contain no Drizzle mutation",
);
const rawSqlStatements = [...script.matchAll(/sql`([^`]*)`/g)].map((match) =>
  match[1]?.trim(),
);
if (
  JSON.stringify(rawSqlStatements) !==
  JSON.stringify(["set transaction read only", "show transaction_read_only"])
) {
  failures.push(
    "the readback must contain only the reviewed READ ONLY and verification raw SQL statements",
  );
}
forbid(
  script,
  /mongo|mongoose/i,
  "the Inbox routing-profile readback must remain PostgreSQL-only",
);

requireMatch(
  validator,
  /requestedRoutingProfileId !== expected\.id[\s\S]*?profiles\.length !== 1[\s\S]*?candidates\.length !== 1/,
  "validation must refuse a different ID and missing or duplicate rows",
);
requireMatch(
  validator,
  /profile\.slug !== expected\.slug[\s\S]*?profile\.displayName !== expected\.displayName[\s\S]*?profile\.description !== expected\.description[\s\S]*?profile\.optimiseFor !== expected\.optimiseFor[\s\S]*?profile\.isProductPreset !== expected\.isProductPreset/,
  "validation must bind every reviewed routing-profile metadata field",
);
requireMatch(
  validator,
  /candidate\.modelReference !== expected\.candidate\.modelReference[\s\S]*?candidate\.priority !== expected\.candidate\.priority/,
  "validation must bind the exact reviewed candidate model and priority",
);

if (failures.length > 0) {
  process.stderr.write(
    `Inbox routing-profile readback gate failed:\n- ${failures.join("\n- ")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  "Inbox routing-profile readback stays exact-PK, PostgreSQL READ ONLY, live-image-bound and DATABASE_URL-only.\n",
);
