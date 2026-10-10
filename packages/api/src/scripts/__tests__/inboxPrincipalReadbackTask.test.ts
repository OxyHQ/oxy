import {
  INBOX_PRINCIPAL_READBACK_SECRETS,
  buildInboxPrincipalReadbackTaskDefinition,
} from '../inboxPrincipalReadbackTask';
import { buildJevPrincipalsReadbackTaskDefinition } from '../jevPrincipalsReadbackTask';

const ARN = 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:412';
const IMAGE = `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:${'a'.repeat(64)}`;
const EXECUTION_ROLE = 'arn:aws:iam::237343248947:role/ecsTaskExecutionRole';
const SSM = 'arn:aws:ssm:us-west-2:237343248947:parameter';

/** The shape `describe-task-definition` returns for the live service, sidecar included. */
// A describe-task-definition fixture that each negative case mutates in place.
// biome-ignore lint/suspicious/noExplicitAny: a describe-task-definition fixture that each negative case mutates in place
type LiveTaskDefinition = Record<string, any>;

function liveTaskDefinition(): LiveTaskDefinition {
  return {
    taskDefinitionArn: ARN,
    family: 'oxy-oxy-api',
    revision: 412,
    status: 'ACTIVE',
    taskRoleArn: 'arn:aws:iam::237343248947:role/ecsTaskRole',
    executionRoleArn: EXECUTION_ROLE,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    compatibilities: ['EC2', 'FARGATE'],
    cpu: '1024',
    memory: '2048',
    runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
    volumes: [{ name: 'scratch' }],
    proxyConfiguration: { type: 'APPMESH', containerName: 'adot' },
    containerDefinitions: [
      {
        name: 'oxy-api',
        image: IMAGE,
        essential: true,
        portMappings: [{ containerPort: 3001, protocol: 'tcp' }],
        healthCheck: { command: ['CMD-SHELL', 'curl -f localhost:3001/health'] },
        dependsOn: [{ containerName: 'adot', condition: 'START' }],
        mountPoints: [{ sourceVolume: 'scratch', containerPath: '/scratch' }],
        volumesFrom: [{ sourceContainer: 'adot' }],
        entryPoint: ['sh', '-c'],
        command: ['node', 'packages/api/dist/server.js'],
        environment: [
          { name: 'NODE_ENV', value: 'production' },
          { name: 'KAANA_BASE_URL', value: 'https://kaana.ai' },
        ],
        secrets: [
          { name: 'DATABASE_URL', valueFrom: `${SSM}/oxy/oxy-api/DATABASE_URL` },
          { name: 'INBOX_APPLICATION_KEY', valueFrom: `${SSM}/oxy/inbox/OXY_APPLICATION_KEY` },
          {
            name: 'INBOX_APPLICATION_SECRET',
            valueFrom: `${SSM}/oxy/inbox/OXY_APPLICATION_SECRET`,
          },
          {
            name: 'SERVICE_TOKEN_PRIVATE_KEY',
            valueFrom: `${SSM}/oxy/oxy-api/SERVICE_TOKEN_PRIVATE_KEY`,
          },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': '/ecs/oxy-apps',
            'awslogs-region': 'us-west-2',
            'awslogs-stream-prefix': 'oxy-api',
            'awslogs-create-group': 'true',
          },
          secretOptions: [{ name: 'x', valueFrom: `${SSM}/oxy/oxy-api/LOG_TOKEN` }],
        },
      },
      {
        name: 'adot',
        image: 'public.ecr.aws/aws-observability/aws-otel-collector:latest',
        essential: false,
        secrets: [{ name: 'OTEL_TOKEN', valueFrom: `${SSM}/oxy/oxy-api/OTEL_TOKEN` }],
      },
    ],
  };
}

function build(live: unknown = liveTaskDefinition(), expectedTaskDefinitionArn = ARN) {
  return buildInboxPrincipalReadbackTaskDefinition({
    expectedTaskDefinitionArn,
    liveTaskDefinition: live,
  });
}

describe('Inbox principal readback task isolation', () => {
  it('keeps only the oxy-api container rebuilt from an allowlist', () => {
    expect(build()).toEqual({
      family: 'oxy-oxy-api-inbox-principal-readback',
      executionRoleArn: EXECUTION_ROLE,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: '1024',
      memory: '2048',
      runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      volumes: [],
      containerDefinitions: [
        {
          name: 'oxy-api',
          image: IMAGE,
          essential: true,
          entryPoint: ['/usr/local/bin/bun'],
          command: ['run', 'packages/api/scripts/readback-inbox-principal.ts'],
          workingDirectory: '/app',
          environment: [],
          secrets: [
            { name: 'DATABASE_URL', valueFrom: `${SSM}/oxy/oxy-api/DATABASE_URL` },
            { name: 'INBOX_APPLICATION_KEY', valueFrom: `${SSM}/oxy/inbox/OXY_APPLICATION_KEY` },
          ],
          portMappings: [],
          mountPoints: [],
          volumesFrom: [],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': '/ecs/oxy-apps',
              'awslogs-region': 'us-west-2',
              'awslogs-stream-prefix': 'oxy-api',
            },
          },
        },
      ],
    });
  });

  it('drops the task role, sidecars and every other secret', () => {
    const serialized = JSON.stringify(build());
    for (const dropped of [
      'taskRoleArn',
      'ecsTaskRole',
      'adot',
      'INBOX_APPLICATION_SECRET',
      'SERVICE_TOKEN_PRIVATE_KEY',
      'OTEL_TOKEN',
      'LOG_TOKEN',
      'secretOptions',
      'awslogs-create-group',
      'NODE_ENV',
      'healthCheck',
      'dependsOn',
      '"sh"',
      'server.js',
      'proxyConfiguration',
      'scratch',
      '3001',
    ]) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it('is a pure function of its input', () => {
    const live = liveTaskDefinition();
    const before = JSON.stringify(live);
    build(live);
    expect(JSON.stringify(live)).toBe(before);
  });

  it.each([
    'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api',
    'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:0',
    'arn:aws:ecs:us-east-1:237343248947:task-definition/oxy-oxy-api:412',
    'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-kaana:412',
    ` ${ARN}`,
  ])('refuses a non-exact expected ARN %j', (expected) => {
    expect(() => build(liveTaskDefinition(), expected)).toThrow(
      'not an exact production oxy-api task definition',
    );
  });

  it('refuses a live document of a different revision', () => {
    expect(() => build(liveTaskDefinition(), ARN.replace(':412', ':413'))).toThrow(
      'not the exact reviewed ARN',
    );
  });

  it.each<[string, (live: LiveTaskDefinition) => void, string]>([
    [
      'inactive',
      (live) => {
        live.status = 'INACTIVE';
      },
      'not ACTIVE',
    ],
    [
      'other family',
      (live) => {
        live.family = 'oxy-kaana';
      },
      'family',
    ],
    [
      'bridge network',
      (live) => {
        live.networkMode = 'bridge';
      },
      'awsvpc',
    ],
    [
      'no execution role',
      (live) => {
        delete live.executionRoleArn;
      },
      'executionRoleArn',
    ],
    [
      'foreign execution role',
      (live) => {
        live.executionRoleArn = 'arn:aws:iam::111111111111:role/x';
      },
      'production account',
    ],
    [
      'mutable image tag',
      (live) => {
        live.containerDefinitions[0].image =
          '237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api:latest';
      },
      'immutable',
    ],
    [
      'no oxy-api container',
      (live) => {
        live.containerDefinitions.shift();
      },
      'exactly one oxy-api',
    ],
    [
      'two oxy-api containers',
      (live) => {
        live.containerDefinitions.push(live.containerDefinitions[0]);
      },
      'exactly one oxy-api',
    ],
    [
      'missing DATABASE_URL',
      (live) => {
        live.containerDefinitions[0].secrets.splice(0, 1);
      },
      'DATABASE_URL must have exactly one',
    ],
    [
      'duplicate key binding',
      (live) => {
        live.containerDefinitions[0].secrets.push({
          name: 'INBOX_APPLICATION_KEY',
          valueFrom: `${SSM}/oxy/inbox/OXY_APPLICATION_KEY`,
        });
      },
      'INBOX_APPLICATION_KEY must have exactly one',
    ],
    [
      'key from another parameter',
      (live) => {
        live.containerDefinitions[0].secrets[1].valueFrom = `${SSM}/oxy/inbox/OTHER`;
      },
      'exact production SSM parameter',
    ],
    [
      'key also in environment',
      (live) => {
        live.containerDefinitions[0].environment.push({
          name: 'INBOX_APPLICATION_KEY',
          value: 'oxy_dk_x',
        });
      },
      'plain environment',
    ],
    [
      'firelens logging',
      (live) => {
        live.containerDefinitions[0].logConfiguration = { logDriver: 'awsfirelens' };
      },
      'awslogs',
    ],
    [
      'other log region',
      (live) => {
        live.containerDefinitions[0].logConfiguration.options['awslogs-region'] = 'us-east-1';
      },
      'us-west-2',
    ],
  ])('refuses a live task with %s', (_label, mutate, message) => {
    const live = liveTaskDefinition();
    mutate(live);
    expect(() => build(live)).toThrow(message);
  });

  it('binds exactly the two reviewed parameters', () => {
    expect(INBOX_PRINCIPAL_READBACK_SECRETS.map((secret) => secret.name)).toEqual([
      'DATABASE_URL',
      'INBOX_APPLICATION_KEY',
    ]);
  });
});

describe('Jev principals readback task isolation', () => {
  const buildJev = (live: unknown = liveTaskDefinition()) =>
    buildJevPrincipalsReadbackTaskDefinition({
      expectedTaskDefinitionArn: ARN,
      liveTaskDefinition: live,
    });

  it('runs only the Jev command with DATABASE_URL as its sole secret', () => {
    const inbox = build();
    const jev = buildJev();
    expect(jev.family).toBe('oxy-oxy-api-jev-principals-readback');
    expect(jev.containerDefinitions).toEqual([
      {
        ...inbox.containerDefinitions[0],
        command: ['run', 'packages/api/scripts/readback-jev-principals.ts'],
        secrets: [{ name: 'DATABASE_URL', valueFrom: `${SSM}/oxy/oxy-api/DATABASE_URL` }],
      },
    ]);
    // Everything else is the same allowlist: live execution role, no task role.
    expect({ ...jev, family: inbox.family, containerDefinitions: [] }).toEqual({
      ...inbox,
      containerDefinitions: [],
    });
    expect(jev.containerDefinitions[0].entryPoint).toEqual(['/usr/local/bin/bun']);
  });

  it('drops the Inbox key, every other secret, sidecars and the task role', () => {
    const serialized = JSON.stringify(buildJev());
    for (const dropped of [
      'INBOX_APPLICATION_KEY',
      'OXY_APPLICATION_KEY',
      'INBOX_APPLICATION_SECRET',
      'SERVICE_TOKEN_PRIVATE_KEY',
      'OTEL_TOKEN',
      'taskRoleArn',
      'adot',
      'readback-inbox-principal',
      '3001',
    ]) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it('still requires the exact live DATABASE_URL binding and reviewed ARN', () => {
    const live = liveTaskDefinition();
    live.containerDefinitions[0].secrets[0].valueFrom = `${SSM}/oxy/other/DATABASE_URL`;
    expect(() => buildJev(live)).toThrow('exact production SSM parameter');
    expect(() =>
      buildJevPrincipalsReadbackTaskDefinition({
        expectedTaskDefinitionArn: ARN.replace(':412', ':411'),
        liveTaskDefinition: liveTaskDefinition(),
      }),
    ).toThrow('not the exact reviewed ARN');
  });
});
