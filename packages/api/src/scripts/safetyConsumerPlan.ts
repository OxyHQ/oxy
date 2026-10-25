import { createHash } from 'node:crypto';
import {
  SAFETY_CONSUMERS,
  safetyWorkloadSubject,
  type SafetyConsumer,
} from '../config/safetyConsumers';
export interface SafetyConsumerObservation {
  owner: { id: string; status: string; kind: string; reputation: string; supervised: boolean };
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
    environment: string | null;
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
    before.owner.id !== target.ownerAccountId ||
    before.owner.status !== 'active' ||
    before.owner.kind !== target.ownerKind ||
    before.owner.reputation === 'restricted' ||
    before.owner.supervised ||
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
        row.environment !== 'production' ||
        !subjects.includes(row.subject) ||
        row.expiresAt !== null,
    ) ||
    new Set(before.workloads.map((row) => row.subject)).size !== subjects.length
  )
    throw new Error('Canonical safety workload binding differs');
  if (stage === 'base' && actions.length)
    throw new Error('Base identity verification never grants supervised capabilities');
  if (
    stage === 'capability' &&
    (!actions.length ||
      actions.some((action) => !(target.candidateActions as readonly string[]).includes(action)))
  )
    throw new Error('The requested action is not a reviewed consumer candidate');
  const after = {
    owner: before.owner,
    application: {
      ...before.application,
      // These are external credential ceilings, not workload authority.
      scopes: [...before.application.scopes],
      capabilities:
        stage === 'capability'
          ? sorted([
              ...before.application.capabilities,
              ...actions.map((action) => `safety:${action}:v1`),
            ])
          : [...before.application.capabilities],
    },
    workloads: before.workloads.map((row) => ({ ...row })),
  };
  const plan = { version: 2, consumer, stage, actions: sorted(actions), before, after };
  const planSha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return { plan, planSha256 };
}
