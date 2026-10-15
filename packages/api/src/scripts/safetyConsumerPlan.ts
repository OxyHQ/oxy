import { createHash } from 'node:crypto';
import {
  SAFETY_CONSUMERS,
  SAFETY_SCOPE,
  safetyWorkloadSubject,
  type SafetyConsumer,
} from '../config/safetyConsumers';
import { workloadBindingScopes } from '../utils/applicationScopes';
export interface SafetyConsumerObservation {
  application: {
    id: string;
    ownerAccountId: string;
    type: string;
    status: string;
    scopes: string[];
    capabilities: string[];
  };
  workloads: Array<{
    id: string;
    applicationId: string;
    provider: string;
    subject: string;
    scopes: string[];
    expiresAt: string | null;
  }>;
}
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
/** Candidate actions are never automatically enabled. An exact action requires its own reviewed plan. */
export function safetyConsumerPlan(
  consumer: SafetyConsumer,
  stage: 'base' | 'capability',
  actions: string[],
  before: SafetyConsumerObservation,
) {
  const target = SAFETY_CONSUMERS[consumer];
  if (
    before.application.id !== target.applicationId ||
    before.application.ownerAccountId !== target.ownerAccountId ||
    before.application.type !== target.type ||
    before.application.status !== 'active'
  )
    throw new Error('Canonical safety consumer identity differs');
  const subjects = target.roles.map(safetyWorkloadSubject);
  if (
    before.workloads.length !== subjects.length ||
    before.workloads.some(
      (row) =>
        row.applicationId !== target.applicationId ||
        row.provider !== 'aws-iam' ||
        !subjects.includes(row.subject) ||
        row.expiresAt !== null,
    ) ||
    new Set(before.workloads.map((row) => row.subject)).size !== subjects.length
  )
    throw new Error('Canonical safety workload binding differs');
  if (stage === 'base' && actions.length)
    throw new Error('Base policy scope never grants supervised capabilities');
  if (
    stage === 'capability' &&
    (!actions.length ||
      actions.some((action) => !(target.candidateActions as readonly string[]).includes(action)))
  )
    throw new Error('The requested action is not a reviewed consumer candidate');
  if (
    stage === 'capability' &&
    (!before.application.scopes.includes(SAFETY_SCOPE) ||
      before.workloads.some(
        (row) =>
          !workloadBindingScopes(row.scopes, before.application.scopes).includes(SAFETY_SCOPE),
      ))
  )
    throw new Error('Provision base scope before reviewing supervised action capabilities');
  const after = {
    application: {
      ...before.application,
      scopes:
        stage === 'base'
          ? sorted([...before.application.scopes, SAFETY_SCOPE])
          : [...before.application.scopes],
      capabilities:
        stage === 'capability'
          ? sorted([
              ...before.application.capabilities,
              ...actions.map((action) => `safety:${action}:v1`),
            ])
          : [...before.application.capabilities],
    },
    workloads: before.workloads.map((row) => ({
      ...row,
      scopes:
        stage === 'base'
          ? sorted([
              ...(row.scopes.length
                ? row.scopes
                : workloadBindingScopes(row.scopes, before.application.scopes)),
              SAFETY_SCOPE,
            ])
          : [...row.scopes],
    })),
  };
  const plan = { version: 1, consumer, stage, actions: sorted(actions), before, after };
  const planSha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return { plan, planSha256 };
}
