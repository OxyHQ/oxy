import { readFileSync } from "node:fs";
import {
  InboxPrincipalReadbackTaskError,
  buildInboxPrincipalReadbackTaskDefinition,
} from "../src/scripts/inboxPrincipalReadbackTask";

/**
 * Usage:
 *   bun run packages/api/scripts/build-inbox-principal-readback-task.ts \
 *     <exact live task-definition ARN> <describe-task-definition JSON file>
 *
 * The JSON file is `aws ecs describe-task-definition --query taskDefinition`
 * output for that exact ARN. Prints the isolated `register-task-definition`
 * input on stdout. Makes no AWS call.
 */
function main(): void {
  const [expectedTaskDefinitionArn, liveTaskDefinitionPath, ...extra] =
    process.argv.slice(2);
  if (
    expectedTaskDefinitionArn === undefined ||
    liveTaskDefinitionPath === undefined ||
    extra.length > 0
  ) {
    throw new InboxPrincipalReadbackTaskError(
      "Usage: build-inbox-principal-readback-task.ts <live-task-definition-arn> <live-task-definition.json>",
    );
  }
  let liveTaskDefinition: unknown;
  try {
    liveTaskDefinition = JSON.parse(readFileSync(liveTaskDefinitionPath, "utf8"));
  } catch {
    throw new InboxPrincipalReadbackTaskError(
      "The live task definition file is not readable JSON",
    );
  }
  const taskDefinition = buildInboxPrincipalReadbackTaskDefinition({
    expectedTaskDefinitionArn,
    liveTaskDefinition,
  });
  process.stdout.write(`${JSON.stringify(taskDefinition, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  const message =
    error instanceof InboxPrincipalReadbackTaskError
      ? error.message
      : "Unexpected failure building the readback task definition";
  process.stderr.write(`Inbox principal readback task build failed: ${message}\n`);
  process.exitCode = 1;
}
