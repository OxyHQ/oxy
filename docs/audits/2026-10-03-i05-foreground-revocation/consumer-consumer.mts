import { OxyServer } from '@oxy.so/core/server';
import { foregroundExecutionAuthorizationInputSchema, type ExecutionActorRef } from '@oxy.so/contracts';
const actor: ExecutionActorRef = { type: 'requester', accountId: 'principal' };
const input = foregroundExecutionAuthorizationInputSchema.parse({ tool: 'readViewerGraph',
 expectedCatalog: { registrationId: 'r', version: '1.0.0', digest: 'a'.repeat(64) }, runId: actor.accountId,
 expiresAt: '2026-10-03T10:00:00.000Z' });
export const invoke = (oxy: OxyServer, requesterToken: string) => oxy.agency.createForegroundExecutionAuthorization(input, { requesterToken });

export const revoke = (oxy: OxyServer, id: string, requesterToken: string) => oxy.agency.revokeExecutionAuthorization(id, { requesterToken });
