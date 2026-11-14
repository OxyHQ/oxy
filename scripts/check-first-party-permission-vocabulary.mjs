#!/usr/bin/env bun
/**
 * ADR 0066: Oxy's own services act for people on what the first-party registry
 * declares; they never hold a person's session, a task, a requester context or
 * a "reauthorise" flow. Those proofs are retiring. This gate stops them from
 * spreading: a source file that uses the retired vocabulary must be one of the
 * files below, which still implement or test it until its last caller moves to
 * `actingFor`. The list only shrinks — delete a line when its file stops
 * matching (the gate tells you), never add one.
 */
import { execFileSync } from 'node:child_process';

const RETIRED = [
  'withRequester\\(',
  'requesterToken',
  'createTask\\(',
  'createTaskExecutionAuthorization',
  'createForegroundExecutionAuthorization',
  '[Xx]-[Oo]xy-[Tt]ask-[Ii]d',
  '[Xx]-[Oo]xy-[Rr]equester-[Tt]oken',
  '[Xx]-[Oo]xy-[Rr]equester-[Cc]ontext',
  'requesterContext',
  'reauthori[sz]e',
];

/** Files that still carry the retiring proofs. Shrinks only. */
export const ALLOWED = new Set([
  'packages/api/src/capabilities/__tests__/inbox.contract.test.ts',
  'packages/api/src/capabilities/oxy-profile.handlers.ts',
  'packages/api/src/capabilities/oxy-profile.transport.ts',
  'packages/api/src/middleware/__tests__/emailCapabilityAuth.test.ts',
  'packages/api/src/middleware/emailCapabilityAuth.ts',
  'packages/api/src/routes/__tests__/appInvitations.test.ts',
  'packages/api/src/routes/__tests__/capabilitiesSettings.routes.test.ts',
  'packages/api/src/routes/__tests__/internalServiceAccountSwitch.test.ts',
  'packages/api/src/routes/__tests__/linkedAccounts.test.ts',
  'packages/api/src/routes/__tests__/productServiceGrants.test.ts',
  'packages/api/src/routes/capabilities.ts',
  'packages/api/src/routes/internal.ts',
  'packages/api/src/routes/supervision.ts',
  'packages/api/src/services/__tests__/agentRequesterCeilings.db.test.ts',
  'packages/api/src/services/__tests__/agentSelfBinding.db.test.ts',
  'packages/api/src/services/__tests__/capabilityAuthority.db.test.ts',
  'packages/api/src/services/__tests__/capabilityRequester.db.test.ts',
  'packages/api/src/services/__tests__/externalMcpMediaRequester.db.test.ts',
  'packages/api/src/services/__tests__/firstPartyTaskAuthority.db.test.ts',
  'packages/api/src/services/capabilityAuthority.service.ts',
  'packages/api/src/services/capabilityRequester.service.ts',
  'packages/api/src/services/externalMcpMediaRequester.service.ts',
  'packages/api/src/services/foregroundCapabilityRequester.service.ts',
  'packages/api/src/services/serviceRequester.service.ts',
  'packages/api/src/utils/__tests__/logger.redaction.test.ts',
  'packages/api/src/utils/logger.ts',
  'packages/contracts/src/__tests__/safety.test.ts',
  'packages/contracts/src/safety.ts',
  'packages/core/src/HttpService.ts',
  'packages/core/src/client/context.ts',
  'packages/core/src/server/OxyServer.ts',
  'packages/core/src/server/__tests__/actingFor.test.ts',
  'packages/core/src/server/__tests__/agencyAuthority.test.ts',
  'packages/core/src/server/__tests__/firstPartyAuthority.test.ts',
  'packages/core/src/server/__tests__/readerFirstProtocol.test.ts',
  'packages/core/src/server/__tests__/requesterAssetsHttp.test.ts',
  'packages/core/src/server/__tests__/serviceClient.test.ts',
  'packages/core/src/server/__tests__/serviceCredentialsHttp.test.ts',
  'packages/core/src/server/__tests__/serviceRequestBoundary.test.ts',
  'packages/core/src/server/__tests__/streamingUploadHttp.test.ts',
  'packages/core/src/server/__tests__/verifyActingAs.test.ts',
  'packages/core/src/server/auth.ts',
  'packages/core/src/server/externalMediaRequester.ts',
  'packages/core/src/server/index.ts',
  'packages/core/src/server/middleware.ts',
  'packages/core/src/server/namespaces.ts',
  'packages/core/src/server/requesterContext.ts',
  'packages/mcp/src/__tests__/serviceTransportHttp.test.ts',
]);

function matchingFiles() {
  try {
    return execFileSync(
      'git',
      ['grep', '-lE', RETIRED.join('|'), '--', 'packages/*/src/**', ':!*.md', ':!*.mdx'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

const found = matchingFiles();
const added = found.filter((file) => !ALLOWED.has(file));
const gone = [...ALLOWED].filter((file) => !found.includes(file));
if (added.length || gone.length) {
  if (added.length)
    console.error(
      `Retired first-party permission vocabulary (ADR 0066) in new files:\n${added.map((f) => `  ${f}`).join('\n')}\n` +
        'An Oxy service acts for a person with `actingFor` and its registry declaration, never a session, task or requester context.',
    );
  if (gone.length)
    console.error(
      `These files no longer use it; remove them from ALLOWED in scripts/check-first-party-permission-vocabulary.mjs:\n${gone.map((f) => `  ${f}`).join('\n')}`,
    );
  process.exit(1);
}
console.log(`First-party permission vocabulary gate passed (${found.length} retiring file(s)).`);
