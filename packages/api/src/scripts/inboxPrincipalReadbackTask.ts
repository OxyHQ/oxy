/**
 * Builds the isolated one-off ECS task definition for the Inbox principal
 * readback from the EXACT live `oxy-api` task definition.
 *
 * Pure: it reads one `describe-task-definition` document and returns a
 * `register-task-definition` input. It never calls AWS. The live definition may
 * carry sidecars; the output keeps only the `oxy-api` container, rebuilt from an
 * allowlist, so nothing the live service is granted reaches the readback unless
 * it is named below:
 *
 *  - no task role (`taskRoleArn` is dropped), the live execution role only;
 *  - no environment, and exactly two secrets, each from its exact SSM parameter;
 *  - no sidecars, port mappings, health check, `dependsOn`, mount points,
 *    `volumesFrom` or volumes;
 *  - a fixed bun entry point and command that run only the readback. The
 *    image's default `CMD` (the API server) and the base image's
 *    `docker-entrypoint.sh` are both bypassed, so nothing else starts and no
 *    migration runs.
 */

export const OXY_API_LIVE_TASK_DEFINITION_ARN_PATTERN =
  /^arn:aws:ecs:us-west-2:237343248947:task-definition\/oxy-oxy-api:[1-9][0-9]*$/;

const OXY_API_FAMILY = "oxy-oxy-api";
const OXY_API_CONTAINER = "oxy-api";
const OXY_API_IMAGE_PATTERN =
  /^237343248947\.dkr\.ecr\.us-west-2\.amazonaws\.com\/oxy\/oxy-api@sha256:[a-f0-9]{64}$/;
const EXECUTION_ROLE_PATTERN = /^arn:aws:iam::237343248947:role\/[\w+=,.@/-]+$/;

export const INBOX_PRINCIPAL_READBACK_TASK_FAMILY =
  "oxy-oxy-api-inbox-principal-readback";

/** `/usr/local/bin/bun` is where the oxy-api Dockerfile installs bun. */
export const INBOX_PRINCIPAL_READBACK_ENTRY_POINT = ["/usr/local/bin/bun"] as const;
export const INBOX_PRINCIPAL_READBACK_COMMAND = [
  "run",
  "packages/api/scripts/readback-inbox-principal.ts",
] as const;
/** The oxy-api image's `WORKDIR`. */
export const INBOX_PRINCIPAL_READBACK_WORKING_DIRECTORY = "/app";

/** The only two values the readback task may receive, from these exact parameters. */
export const INBOX_PRINCIPAL_READBACK_SECRETS = [
  {
    name: "DATABASE_URL",
    valueFrom:
      "arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL",
  },
  {
    name: "INBOX_APPLICATION_KEY",
    valueFrom:
      "arn:aws:ssm:us-west-2:237343248947:parameter/oxy/inbox/OXY_APPLICATION_KEY",
  },
] as const;

export interface InboxPrincipalReadbackTaskDefinition {
  readonly family: typeof INBOX_PRINCIPAL_READBACK_TASK_FAMILY;
  readonly executionRoleArn: string;
  readonly networkMode: "awsvpc";
  readonly requiresCompatibilities: readonly ["FARGATE"];
  readonly cpu: string;
  readonly memory: string;
  readonly runtimePlatform?: {
    readonly cpuArchitecture: string;
    readonly operatingSystemFamily: string;
  };
  readonly volumes: readonly [];
  readonly containerDefinitions: readonly [
    {
      readonly name: typeof OXY_API_CONTAINER;
      readonly image: string;
      readonly essential: true;
      readonly entryPoint: readonly string[];
      readonly command: readonly string[];
      readonly workingDirectory: string;
      readonly environment: readonly [];
      readonly secrets: readonly { name: string; valueFrom: string }[];
      readonly portMappings: readonly [];
      readonly mountPoints: readonly [];
      readonly volumesFrom: readonly [];
      readonly logConfiguration: {
        readonly logDriver: "awslogs";
        readonly options: {
          readonly "awslogs-group": string;
          readonly "awslogs-region": "us-west-2";
          readonly "awslogs-stream-prefix": string;
        };
      };
    },
  ];
}

export class InboxPrincipalReadbackTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxPrincipalReadbackTaskError";
  }
}

function fail(message: string): never {
  throw new InboxPrincipalReadbackTaskError(message);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown, description: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${description} must be a list`);
  return value;
}

function nonEmptyString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${description} must be an exact non-empty string`);
  }
  return value;
}

export function buildInboxPrincipalReadbackTaskDefinition(input: {
  readonly expectedTaskDefinitionArn: string;
  readonly liveTaskDefinition: unknown;
}): InboxPrincipalReadbackTaskDefinition {
  if (!OXY_API_LIVE_TASK_DEFINITION_ARN_PATTERN.test(input.expectedTaskDefinitionArn)) {
    fail("The expected ARN is not an exact production oxy-api task definition");
  }
  const live = input.liveTaskDefinition;
  if (!isObject(live)) fail("The live task definition must be a JSON object");
  if (live.taskDefinitionArn !== input.expectedTaskDefinitionArn) {
    fail("The live task definition is not the exact reviewed ARN");
  }
  if (live.family !== OXY_API_FAMILY) fail("The live task family is not oxy-oxy-api");
  if (live.status !== "ACTIVE") fail("The live task definition is not ACTIVE");
  if (live.networkMode !== "awsvpc") fail("The live task does not use awsvpc");
  if (!list(live.requiresCompatibilities, "requiresCompatibilities").includes("FARGATE")) {
    fail("The live task is not Fargate-compatible");
  }
  const executionRoleArn = nonEmptyString(live.executionRoleArn, "executionRoleArn");
  if (!EXECUTION_ROLE_PATTERN.test(executionRoleArn)) {
    fail("The live execution role is not a role in the production account");
  }
  const cpu = nonEmptyString(live.cpu, "Task cpu");
  const memory = nonEmptyString(live.memory, "Task memory");

  let runtimePlatform: InboxPrincipalReadbackTaskDefinition["runtimePlatform"];
  if (live.runtimePlatform !== undefined) {
    if (!isObject(live.runtimePlatform)) fail("runtimePlatform must be an object");
    runtimePlatform = {
      cpuArchitecture: nonEmptyString(
        live.runtimePlatform.cpuArchitecture,
        "runtimePlatform.cpuArchitecture",
      ),
      operatingSystemFamily: nonEmptyString(
        live.runtimePlatform.operatingSystemFamily,
        "runtimePlatform.operatingSystemFamily",
      ),
    };
  }

  // Sidecars are allowed in the live definition and dropped here.
  const apiContainers = list(live.containerDefinitions, "containerDefinitions").filter(
    (container) => isObject(container) && container.name === OXY_API_CONTAINER,
  );
  if (apiContainers.length !== 1) {
    fail("The live task must contain exactly one oxy-api container");
  }
  const api = apiContainers[0] as JsonObject;
  if (api.essential === false) fail("The live oxy-api container is not essential");
  const image = nonEmptyString(api.image, "oxy-api image");
  if (!OXY_API_IMAGE_PATTERN.test(image)) {
    fail("The live oxy-api image is not pinned to an immutable production digest");
  }

  const environment = list(api.environment, "oxy-api environment");
  const secrets = list(api.secrets, "oxy-api secrets");
  for (const expected of INBOX_PRINCIPAL_READBACK_SECRETS) {
    const bound = secrets.filter(
      (secret) => isObject(secret) && secret.name === expected.name,
    );
    if (bound.length !== 1) {
      fail(`${expected.name} must have exactly one live secret binding`);
    }
    if ((bound[0] as JsonObject).valueFrom !== expected.valueFrom) {
      fail(`${expected.name} is not bound from its exact production SSM parameter`);
    }
    if (environment.some((entry) => isObject(entry) && entry.name === expected.name)) {
      fail(`${expected.name} must not also be a plain environment value`);
    }
  }

  // Logs reuse the live awslogs destination, which the existing execution role
  // can already write. `awslogs-create-group` and `secretOptions` are dropped:
  // either would ask for more than the live task needs.
  const logConfiguration = api.logConfiguration;
  if (!isObject(logConfiguration) || logConfiguration.logDriver !== "awslogs") {
    fail("The live oxy-api container must log through awslogs");
  }
  const options = logConfiguration.options;
  if (!isObject(options) || options["awslogs-region"] !== "us-west-2") {
    fail("The live oxy-api awslogs options must name us-west-2");
  }
  const logGroup = nonEmptyString(options["awslogs-group"], "awslogs-group");
  const logPrefix = nonEmptyString(options["awslogs-stream-prefix"], "awslogs-stream-prefix");

  return {
    family: INBOX_PRINCIPAL_READBACK_TASK_FAMILY,
    executionRoleArn,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu,
    memory,
    ...(runtimePlatform === undefined ? {} : { runtimePlatform }),
    volumes: [],
    containerDefinitions: [
      {
        name: OXY_API_CONTAINER,
        image,
        essential: true,
        entryPoint: [...INBOX_PRINCIPAL_READBACK_ENTRY_POINT],
        command: [...INBOX_PRINCIPAL_READBACK_COMMAND],
        workingDirectory: INBOX_PRINCIPAL_READBACK_WORKING_DIRECTORY,
        environment: [],
        secrets: INBOX_PRINCIPAL_READBACK_SECRETS.map((secret) => ({ ...secret })),
        portMappings: [],
        mountPoints: [],
        volumesFrom: [],
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": logGroup,
            "awslogs-region": "us-west-2",
            "awslogs-stream-prefix": logPrefix,
          },
        },
      },
    ],
  };
}
