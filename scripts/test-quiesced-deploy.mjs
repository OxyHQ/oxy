import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFinalDefinition,
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
let tests = 0;
function ok(run) {
  run();
  tests++;
}
function deny(mutate, target = state, evaluate = (value) => assertQuiesced(plan, value)) {
  const value = structuredClone(target);
  mutate(value);
  assert.throws(() => evaluate(value));
  tests++;
}
ok(() => validatePlan(plan, context));
ok(() => assertQuiesced(plan, state));
const finalDefinition = structuredClone(definition);
finalDefinition.taskDefinitionArn = next;
finalDefinition.containerDefinitions[0].image = plan.finalImage;
ok(() => assertFinalDefinition(plan, finalDefinition));
deny(
  (value) => {
    value.containerDefinitions[0].environment[0].value = 'changed';
  },
  finalDefinition,
  (value) => assertFinalDefinition(plan, value),
);
deny(
  (value) => {
    value.containerDefinitions[0].image = plan.previousImage;
  },
  finalDefinition,
  (value) => assertFinalDefinition(plan, value),
);
for (const key of ['desiredCount', 'runningCount', 'pendingCount'])
  deny((value) => {
    value.service.services[0][key] = 1;
  });
for (const key of ['desiredCount', 'runningCount', 'pendingCount'])
  deny((value) => {
    value.service.services[0].deployments[0][key] = 1;
  });
deny((value) => {
  value.service.services[0].taskDefinition = next;
});
deny((value) => {
  value.service.services[0].status = 'DRAINING';
});
deny((value) => {
  value.running.taskArns = [newTask];
});
deny((value) => {
  value.running.nextToken = 'more';
});
deny((value) => {
  value.tasks.tasks[0].lastStatus = 'STOPPING';
});
deny((value) => {
  value.tasks.tasks = [];
  value.tasks.failures = [{ arn: task, reason: 'MISSING' }];
});
deny((value) => {
  value.tasks.tasks[0].taskDefinitionArn = next;
});
deny((value) => {
  value.definition.containerDefinitions[0].image = plan.finalImage;
});
deny((value) => {
  value.definition.containerDefinitions[0].environment[0].value = 'drift';
});
deny((value) => {
  value.targets[group].TargetHealthDescriptions = [{ TargetHealth: { State: 'draining' } }];
});
deny((value) => {
  value.service.services[0].loadBalancers = [];
});
for (const key of Object.keys(state.scalers.ScalableTargets[0].SuspendedState))
  deny((value) => {
    value.scalers.ScalableTargets[0].SuspendedState[key] = false;
  });
deny((value) => {
  value.scalers.ScalableTargets[0].MaxCapacity = 8;
});
deny((value) => {
  value.scheduled.ScheduledActions = [{ ScheduledActionName: 'wake' }];
});
deny((value) => {
  value.scheduled.NextToken = 'more';
});
for (const change of [
  (value) => {
    value.restoreCount = 0;
  },
  (value) => {
    value.restoreCount = 7;
  },
  (value) => {
    value.sourceSha = 'd'.repeat(40);
  },
  (value) => {
    value.finalImage = image;
  },
  (value) => {
    value.service = 'foreign';
  },
  (value) => {
    value.cluster = 'foreign';
  },
  (value) => {
    value.previousTasks = [];
  },
  (value) => {
    value.previousTasks.push(task);
  },
  (value) => {
    value.targetGroups = [];
  },
  (value) => {
    value.unreviewed = true;
  },
])
  deny(change, plan, (value) => validatePlan(value, context));

// An omitted old task may already have desired STOPPED while still executing.
// Exercise the actual reader, rather than a plan-only synthetic snapshot.
const omittedTask = task.replace('a'.repeat(32), 'e'.repeat(32));
function censusRead({ status = 'STOPPING', revision = old, fault } = {}) {
  return (...args) => {
    const route = `${args[0]} ${args[1]}`;
    if (route === 'ecs describe-services') return state.service;
    if (route === 'ecs describe-task-definition') return { taskDefinition: definition };
    if (route === 'elbv2 describe-target-health') return state.targets[group];
    if (route === 'application-autoscaling describe-scalable-targets') return state.scalers;
    if (route === 'application-autoscaling describe-scheduled-actions') return state.scheduled;
    if (route === 'ecs list-tasks') {
      if (fault === 'read') throw new Error('Synthetic incomplete AWS read');
      return {
        taskArns: args.includes('STOPPED') ? [omittedTask] : [],
        ...(fault === 'page' ? { nextToken: 'more' } : {}),
      };
    }
    if (route === 'ecs describe-tasks') {
      const requested = args.slice(args.indexOf('--tasks') + 1);
      return {
        failures: fault === 'failure' ? [{ arn: omittedTask, reason: 'MISSING' }] : [],
        tasks: requested
          .filter((arn) => !(fault === 'missing' && arn === omittedTask))
          .map((arn) =>
            arn === task
              ? state.tasks.tasks[0]
              : {
                  taskArn: fault === 'identity' ? newTask : arn,
                  group: 'service:oxy-api',
                  taskDefinitionArn: revision,
                  lastStatus: status,
                },
          ),
      };
    }
    throw new Error('Unknown synthetic AWS request');
  };
}
ok(() => assert.throws(() => assertQuiesced(plan, readSnapshot(plan, censusRead()))));
ok(() => assertQuiesced(plan, readSnapshot(plan, censusRead({ status: 'STOPPED' }))));
ok(() =>
  assertQuiesced(
    plan,
    readSnapshot(plan, censusRead({ status: 'STOPPED', revision: old.replace(':692', ':690') })),
  ),
);
ok(() =>
  assert.throws(() =>
    assertQuiesced(plan, readSnapshot(plan, censusRead({ revision: old.replace(':692', ':694') }))),
  ),
);
for (const fault of ['page', 'read', 'failure', 'missing', 'identity'])
  ok(() => assert.throws(() => assertQuiesced(plan, readSnapshot(plan, censusRead({ fault })))));

const scratch = mkdtempSync(join(tmpdir(), 'quiesced-deploy-'));
try {
  const omittedPath = join(scratch, 'omitted-tasks.json');
  ok(() =>
    assert.deepEqual(recordAttemptTasks(plan, next, omittedPath, censusRead()), [
      task,
      omittedTask,
    ]),
  );
  ok(() =>
    assert.throws(() => assertRecoveryStopped(plan, next, [task, omittedTask], censusRead())),
  );
  ok(() =>
    assertRecoveryStopped(plan, next, [task, omittedTask], censusRead({ status: 'STOPPED' })),
  );
  for (const fault of ['failure', 'missing', 'identity'])
    ok(() =>
      assert.throws(() => recordAttemptTasks(plan, next, omittedPath, censusRead({ fault }))),
    );
  ok(() => assert.deepEqual(JSON.parse(readFileSync(omittedPath)), [task, omittedTask]));
  let recovery = structuredClone(state);
  recovery.service.services[0].taskDefinition = next;
  let newStatus = 'STOPPING';
  let drifted = false;
  const read = (...args) => {
    const route = `${args[0]} ${args[1]}`;
    if (route === 'ecs describe-services') return recovery.service;
    if (route === 'ecs describe-task-definition') return { taskDefinition: recovery.definition };
    if (route === 'elbv2 describe-target-health') return recovery.targets[group];
    if (route === 'application-autoscaling describe-scalable-targets') return recovery.scalers;
    if (route === 'application-autoscaling describe-scheduled-actions') return recovery.scheduled;
    if (route === 'ecs list-tasks') return { taskArns: args.includes('STOPPED') ? [newTask] : [] };
    if (route === 'ecs describe-tasks') {
      const requested = args.slice(args.indexOf('--tasks') + 1);
      return {
        failures: [],
        tasks: requested.map((arn) =>
          arn === task
            ? recovery.tasks.tasks[0]
            : {
                taskArn: arn,
                group: 'service:oxy-api',
                taskDefinitionArn: drifted ? old.replace(':692', ':694') : next,
                lastStatus: newStatus,
              },
        ),
      };
    }
    throw new Error('unrecognized readonly request');
  };
  const trackedPath = join(scratch, 'tasks.json');
  ok(() => assert.deepEqual(recordAttemptTasks(plan, next, trackedPath, read), [task, newTask]));
  ok(() => assert.throws(() => assertRecoveryStopped(plan, next, [task, newTask], read)));
  newStatus = 'STOPPED';
  ok(() => assertRecoveryStopped(plan, next, [task, newTask], read));
  recovery.service.services[0].taskDefinition = old.replace(':692', ':694');
  ok(() => assert.throws(() => assertRecoveryStopped(plan, next, [task, newTask], read)));
  recovery.service.services[0].taskDefinition = next;
  recovery.scalers.ScalableTargets[0].SuspendedState.DynamicScalingOutSuspended = false;
  ok(() => assert.throws(() => assertRecoveryStopped(plan, next, [task, newTask], read)));
  recovery = structuredClone(state);
  drifted = true;
  newStatus = 'STOPPING';
  ok(() => assert.throws(() => recordAttemptTasks(plan, next, trackedPath, read)));
  ok(() => assert.deepEqual(JSON.parse(readFileSync(trackedPath)), [task, newTask]));
} finally {
  rmSync(scratch, { recursive: true });
}
console.log(
  `Quiesced deployment preflight/recovery: ${tests} checks PASS (synthetic AWS responses; no live mutation).`,
);
