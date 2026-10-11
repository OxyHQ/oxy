import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFinalDefinition,
  assertFinalDeployment,
  assertQuiesced,
  assertRecoveryStopped,
  readSnapshot,
  recordAttemptTasks,
  shapeHash,
  validatePlan,
} from '../.github/scripts/guard-quiesced-deploy.mjs';

const old = 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:692';
const next = 'arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-oxy-api:693';
const task = `arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/${'a'.repeat(32)}`;
const newTask = task.replace('a'.repeat(32), 'b'.repeat(32));
const group =
  'arn:aws:elasticloadbalancing:us-west-2:237343248947:targetgroup/oxy-api/0123456789abcdef';
const image = `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:${'1'.repeat(64)}`;
const definition = {
  taskDefinitionArn: old,
  revision: 692,
  status: 'ACTIVE',
  family: 'oxy-oxy-api',
  containerDefinitions: [
    {
      name: 'oxy-api',
      image,
      environment: [{ name: 'PUBLIC_CONFIG', value: 'retained' }],
    },
  ],
};
const plan = {
  schemaVersion: 1,
  region: 'us-west-2',
  cluster: 'oxy-cluster',
  service: 'oxy-api',
  container: 'oxy-api',
  previousTaskDefinition: old,
  previousImage: image,
  previousShapeSha256: shapeHash(definition),
  finalImage: image.replace('1'.repeat(64), '2'.repeat(64)),
  sourceSha: 'c'.repeat(40),
  restoreCount: 2,
  previousTasks: [task],
  targetGroups: [group],
  scaler: { min: 2, max: 6 },
};
const context = {
  region: plan.region,
  cluster: plan.cluster,
  service: plan.service,
  container: plan.container,
  sourceSha: plan.sourceSha,
  image: plan.finalImage,
};
const state = {
  service: {
    failures: [],
    services: [
      {
        serviceName: 'oxy-api',
        status: 'ACTIVE',
        taskDefinition: old,
        desiredCount: 0,
        runningCount: 0,
        pendingCount: 0,
        deployments: [{ desiredCount: 0, runningCount: 0, pendingCount: 0 }],
        loadBalancers: [{ targetGroupArn: group }],
      },
    ],
  },
  running: { taskArns: [] },
  stopped: { taskArns: [] },
  tasks: {
    failures: [],
    tasks: [
      {
        taskArn: task,
        group: 'service:oxy-api',
        taskDefinitionArn: old,
        lastStatus: 'STOPPED',
      },
    ],
  },
  definition,
  targets: { [group]: { TargetHealthDescriptions: [] } },
  scalers: {
    ScalableTargets: [
      {
        ResourceId: 'service/oxy-cluster/oxy-api',
        ScalableDimension: 'ecs:service:DesiredCount',
        MinCapacity: 2,
        MaxCapacity: 6,
        SuspendedState: {
          DynamicScalingInSuspended: true,
          DynamicScalingOutSuspended: true,
          ScheduledScalingSuspended: true,
        },
      },
    ],
  },
  scheduled: { ScheduledActions: [] },
};

const id = 'ecs-svc/3580599208454400896';
const finalDefinition = {
  ...definition,
  taskDefinitionArn: next,
  containerDefinitions: definition.containerDefinitions.map((c) => ({
    ...c,
    image: plan.finalImage,
  })),
};
function fixture(admitted = false, maxPercent = 150) {
  const s = structuredClone(state);
  const service = s.service.services[0];
  service.taskDefinition = next;
  service.deploymentConfiguration = {
    deploymentCircuitBreaker: { enable: true, rollback: false },
    minimumHealthyPercent: 100,
    maximumPercent: maxPercent,
  };
  service.deployments = [
    {
      id,
      status: 'PRIMARY',
      taskDefinition: next,
      rolloutState: 'COMPLETED',
      desiredCount: admitted ? 2 : 0,
      runningCount: admitted ? 2 : 0,
      pendingCount: 0,
    },
  ];
  s.tasks.tasks[0].desiredStatus = 'STOPPED';
  if (admitted) {
    service.desiredCount = service.runningCount = 2;
    s.running.taskArns = [newTask];
    s.tasks.tasks.push({
      taskArn: newTask,
      group: 'service:oxy-api',
      taskDefinitionArn: next,
      lastStatus: 'RUNNING',
      desiredStatus: 'RUNNING',
      startedBy: id,
    });
    s.targets[group].TargetHealthDescriptions = [
      {
        Target: { Id: '10.0.0.1', Port: 3001 },
        TargetHealth: { State: 'healthy' },
      },
    ];
  }
  return s;
}
function reader(s, late) {
  let reads = 0;
  return (...args) => {
    const route = `${args[0]} ${args[1]}`;
    if (route === 'ecs describe-services') {
      reads++;
      return reads >= 2 && late ? late(s) : s.service;
    }
    if (route === 'ecs list-tasks') return args.includes('RUNNING') ? s.running : s.stopped;
    if (route === 'ecs describe-tasks') {
      const ids = args.slice(args.indexOf('--tasks') + 1);
      return {
        failures: s.tasks.failures,
        tasks: s.tasks.tasks.filter((t) => ids.includes(t.taskArn)),
      };
    }
    if (route === 'ecs describe-task-definition')
      return {
        taskDefinition: args.includes(next) ? finalDefinition : s.definition,
      };
    if (route === 'elbv2 describe-target-health') return s.targets[group];
    if (route === 'application-autoscaling describe-scalable-targets') return s.scalers;
    if (route === 'application-autoscaling describe-scheduled-actions') return s.scheduled;
    throw new Error('Unexpected AWS read');
  };
}
let checks = 0;
function pass(admitted = false, max = 150) {
  assertFinalDeployment(plan, next, id, [task], max, admitted, reader(fixture(admitted, max)));
  checks++;
}
function deny(mutate, { admitted = false, max = 150, late } = {}) {
  const s = fixture(admitted, max);
  mutate(s);
  assert.throws(
    () => assertFinalDeployment(plan, next, id, [task], max, admitted, reader(s, late)),
    String(mutate),
  );
  checks++;
}
pass();
pass(false, 200);
pass(true);
pass(true, 200);
for (const admitted of [false, true]) {
  for (const mutate of [
    (s) =>
      s.service.services[0].deployments.push({
        ...s.service.services[0].deployments[0],
        id: 'old',
        taskDefinition: old,
      }),
    (s) => {
      s.service.services[0].deployments[0].id = 'foreign';
    },
    (s) => {
      s.service.services[0].deployments[0].rolloutState = 'FAILED';
    },
    (s) => {
      s.service.services[0].taskDefinition = old;
    },
    (s) => {
      s.service.services[0].deploymentConfiguration.deploymentCircuitBreaker.rollback = true;
    },
    (s) => {
      s.service.services[0].deploymentConfiguration.maximumPercent = 200;
    },
    (s) => {
      s.service.services[0].deploymentConfiguration.minimumHealthyPercent = 0;
    },
    (s) => {
      s.scalers.ScalableTargets[0].SuspendedState.DynamicScalingOutSuspended = false;
    },
    (s) => s.scheduled.ScheduledActions.push({}),
    (s) => {
      s.tasks.tasks[0].lastStatus = 'STOPPING';
    },
    (s) => {
      s.tasks.tasks[0].desiredStatus = 'RUNNING';
    },
    (s) => {
      s.tasks.tasks[0].taskDefinitionArn = next.replace(':693', ':694');
    },
    (s) => {
      s.tasks.tasks = [];
    },
    (s) => s.tasks.failures.push({ arn: task, reason: 'MISSING' }),
  ])
    deny(mutate, { admitted });
  deny(() => {}, {
    admitted,
    late: (s) => ({
      failures: [],
      services: [{ ...s.service.services[0], taskDefinition: old }],
    }),
  });
  deny(() => {}, {
    admitted,
    late: (s) => ({
      failures: [],
      services: [
        {
          ...s.service.services[0],
          deployments: [{ ...s.service.services[0].deployments[0], id: 'replacement' }],
        },
      ],
    }),
  });
}
deny((s) => {
  s.service.services[0].deployments[0].rolloutState = 'IN_PROGRESS';
});
deny((s) => {
  s.service.services[0].runningCount = 1;
});
deny((s) =>
  s.targets[group].TargetHealthDescriptions.push({
    TargetHealth: { State: 'draining' },
  }),
);
deny(
  (s) => {
    s.tasks.tasks[1].startedBy = 'foreign';
  },
  { admitted: true },
);
deny(
  (s) => {
    s.tasks.tasks[1].taskDefinitionArn = old;
  },
  { admitted: true },
);
for (const max of [100, 149, 201, Number.NaN]) {
  assert.throws(() => assertFinalDeployment(plan, next, id, [task], max, false, reader(fixture())));
  checks++;
}
console.log(
  `Maintenance final retirement/admission: ${checks} checks PASS (synthetic AWS; no mutation).`,
);

// Pending is narrowly classified only after identity, config, census and zero
// admission checks. Every other mismatch remains a fatal guard failure.
for (const mutate of [
  (s) => {
    s.service.services[0].deployments[0].rolloutState = 'IN_PROGRESS';
  },
  (s) =>
    s.service.services[0].deployments.push({
      id: 'retiring',
      status: 'ACTIVE',
      taskDefinition: old,
      rolloutState: 'COMPLETED',
      desiredCount: 0,
      runningCount: 0,
      pendingCount: 0,
    }),
]) {
  const s = fixture();
  mutate(s);
  assert.throws(
    () => assertFinalDeployment(plan, next, id, [task], 150, false, reader(s)),
    (error) => error.name === 'Error' && error.constructor.name === 'RetirementPendingError',
  );
  for (const drift of [
    (s) => {
      s.scalers.ScalableTargets[0].SuspendedState.DynamicScalingOutSuspended = false;
    },
    (s) => {
      s.tasks.tasks[0].lastStatus = 'STOPPING';
    },
    (s) => {
      s.service.services[0].deploymentConfiguration.deploymentCircuitBreaker.rollback = true;
    },
    (s) => {
      s.service.services[0].taskDefinition = old;
    },
  ]) {
    const changed = structuredClone(s);
    drift(changed);
    assert.throws(
      () => assertFinalDeployment(plan, next, id, [task], 150, false, reader(changed)),
      (error) => error.constructor.name !== 'RetirementPendingError',
    );
  }
}
console.log('Maintenance pending-vs-fatal: 10 checks PASS.');

let steadyChecks = 0;
const observe = (late) =>
  assertFinalDeployment(plan, next, id, [task], 150, true, reader(fixture(true), late), true);
assert.deepEqual(observe(), {
  kind: 'quiesced-admitted-observation-v1',
  deploymentId: id,
  steady: true,
});
steadyChecks++;
for (const mutate of [
  (s) => {
    s.deployments[0].rolloutState = 'IN_PROGRESS';
  },
  (s) => {
    s.runningCount = 1;
    s.pendingCount = 1;
  },
  (s) => {
    s.deployments[0].runningCount = 1;
    s.deployments[0].pendingCount = 1;
  },
  (s) => {
    s.deployments[0].desiredCount = 1;
  },
]) {
  const observed = observe((original) => {
    const response = structuredClone(original.service);
    mutate(response.services[0]);
    return response;
  });
  assert.equal(observed.steady, false);
  steadyChecks++;
}
for (const mutate of [
  (s) => {
    s.loadBalancers[0].targetGroupArn = 'foreign-target-group';
  },
  (s) => {
    s.serviceName = 'foreign';
  },
  (s) => {
    s.status = 'INACTIVE';
  },
  (s) => {
    s.taskDefinition = old;
  },
  (s) => {
    s.deploymentConfiguration.deploymentCircuitBreaker.rollback = true;
  },
  (s) => {
    s.deployments[0].id = 'foreign';
  },
  (s) => {
    s.deployments[0].pendingCount = -1;
  },
  (s) => {
    delete s.runningCount;
  },
]) {
  assert.throws(() =>
    observe((original) => {
      const response = structuredClone(original.service);
      mutate(response.services[0]);
      return response;
    }),
  );
  steadyChecks++;
}
console.log(
  `Latest validated admitted observation: ${steadyChecks} checks PASS (synthetic AWS; no mutation).`,
);
