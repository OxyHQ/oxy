import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
/** Real catalogue, approval, ticket and receiver HTTP. No injected authority. */
export async function capabilities(require, http, f, ordinaryToken, agentToken, observations) {
  const current = 17975,
    old = 17974;
  const service = await http(current, '/auth/service-token', {
    apiKey: f.service.publicKey,
    apiSecret: f.service.secret,
  });
  assert.equal(service.status, 200);
  const presenter = service.data.data.token;
  const catalog =
    require('./src/capabilities/oxy-profile.catalog.ts').oxyProfileCapabilityCatalog();
  const registered = await http(current, '/capabilities/catalogs/register', { catalog }, presenter);
  assert.equal(registered.status, 201);
  const r = registered.data.registration;
  const expectedCatalog = { registrationId: r.id, version: r.version, digest: r.digest };
  const foreground = await http(
    current,
    '/capabilities/foreground-execution-authorizations',
    {
      subjectToken: ordinaryToken,
      tool: 'readViewerGraph',
      expectedCatalog,
      runId: randomUUID(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    presenter,
  );
  assert.equal(foreground.status, 201);
  const input = { executionAuthorizationId: foreground.data.authorization.id, expectedCatalog };
  const issued = await http(current, '/capabilities/tickets', input, presenter);
  assert.equal(issued.status, 201);
  const absent = await http(
    current,
    '/capabilities/tickets',
    { executionAuthorizationId: input.executionAuthorizationId },
    presenter,
  );
  assert.equal(absent.status, 201);
  const noPinApproval = await http(
    current,
    '/capabilities/foreground-execution-authorizations',
    {
      subjectToken: ordinaryToken,
      tool: 'readViewerGraph',
      runId: randomUUID(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    presenter,
  );
  assert.equal(noPinApproval.status, 400);
  const absentClaims = JSON.parse(
    Buffer.from(absent.data.ticket.split('.')[1], 'base64url').toString(),
  );
  assert.deepEqual(absentClaims.catalog, expectedCatalog);
  const onOld = await http(old, '/capabilities/tickets', input, presenter);
  const claims = JSON.parse(Buffer.from(issued.data.ticket.split('.')[1], 'base64url').toString());
  assert.equal(claims.actor.type, 'requester');
  async function read(port, ticket) {
    const result = await fetch(`http://127.0.0.1:${port}/_oxy/capabilities/users/me/graph`, {
      headers: { authorization: `Capability ${ticket}` },
    });
    return result.status;
  }
  assert.equal(await read(current, issued.data.ticket), 200);
  observations.push({
    case: 'foreground requester with exact catalogue',
    finalIssue: issued.status,
    finalOmittedCallerPinUsesStoredPin: absent.status,
    finalMissingApprovalPin: noPinApproval.status,
    oldIssue: onOld.status,
    oldReceiver: await read(old, issued.data.ticket),
  });
  const serviceClaims = JSON.parse(Buffer.from(presenter.split('.')[1], 'base64url').toString());
  const self = await http(
    current,
    '/capabilities/execution-authorizations',
    {
      kind: 'direct_request',
      ownerAccountId: f.bot.id,
      coordinatorApplicationId: f.app.id,
      coordinatorCredentialId: serviceClaims.credentialId,
      actor: { type: 'agent', accountId: f.bot.id },
      resource: {
        appId: 'oxy',
        effectiveAccountId: f.bot.id,
        resourceType: 'account',
        resourceId: f.bot.id,
      },
      tool: 'readViewerGraph',
      runId: randomUUID(),
      maximumAutonomy: 'read_only',
      limits: [],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    agentToken,
  );
  assert.equal(self.status, 201);
  const selfInput = { executionAuthorizationId: self.data.authorization.id, expectedCatalog };
  const selfTicket = await http(current, '/capabilities/tickets', selfInput, presenter);
  assert.equal(selfTicket.status, 201);
  const selfOld = await http(old, '/capabilities/tickets', selfInput, presenter);
  observations.push({
    case: 'agent self authority without delegation grant',
    finalIssue: selfTicket.status,
    oldIssue: selfOld.status,
  });
  return async () => {
    const denied = await http(current, '/capabilities/tickets', selfInput, presenter);
    assert(denied.status >= 400);
    const live = await http(
      current,
      '/capabilities/tickets/introspect',
      { ticket: selfTicket.data.ticket },
      presenter,
    );
    assert.equal(live.status, 200);
    assert.equal(live.data.active, false);
    observations.push({
      case: 'revoked key denies signed self capability',
      issue: denied.status,
      introspectionActive: false,
    });
  };
}
