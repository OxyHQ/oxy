import {
  INBOX_PRINCIPAL_READBACK_SECRETS,
  type IsolatedReadbackTaskDefinition,
  type IsolatedReadbackTaskProfile,
  buildIsolatedReadbackTaskDefinition,
} from './inboxPrincipalReadbackTask';

/**
 * The isolated one-off task for `readback-jev-principals.ts`: the same
 * allowlist as the Inbox readback (no sidecars, task role, environment, ports,
 * mounts or dependencies; the live execution role, awslogs destination and
 * immutable image digest; a fixed bun entry point), with ONE secret.
 */
export const JEV_PRINCIPALS_READBACK_TASK_PROFILE: IsolatedReadbackTaskProfile = {
  family: 'oxy-oxy-api-jev-principals-readback',
  command: ['run', 'packages/api/scripts/readback-jev-principals.ts'],
  secrets: INBOX_PRINCIPAL_READBACK_SECRETS.filter((secret) => secret.name === 'DATABASE_URL'),
};

export function buildJevPrincipalsReadbackTaskDefinition(input: {
  readonly expectedTaskDefinitionArn: string;
  readonly liveTaskDefinition: unknown;
}): IsolatedReadbackTaskDefinition {
  return buildIsolatedReadbackTaskDefinition(input, JEV_PRINCIPALS_READBACK_TASK_PROFILE);
}
