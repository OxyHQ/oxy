import { createHash } from 'node:crypto';
import {
  NATIVE_PRODUCT_AGENTS,
  aliaNativeAgentBootstrapManifest,
} from '../nativeProductAgents';

describe('native product agent identities', () => {
  it('pins the approved Oxy, app, credential, bot and Alia primary keys', () => {
    expect(NATIVE_PRODUCT_AGENTS).toMatchObject({
      manifestVersion: 2,
      oxyOrganizationId: '69b2d3df5d12f58c9800d651',
      products: {
        homiio: {
          project: { id: '6a50444ce8026582b949089d' },
          bot: { id: '01a0646a-078f-7974-9645-a5e8be237f47' },
          applicationId: '6a2f851751b784a86fd0e922',
          sindiServiceCredential: {
            id: '01a0648e-ad3f-7608-aa8b-c07bfef6cf73',
            clientId: 'oxy_dk_bed4f8941795512ddce5b0662879dccae52d8bd30308d240',
          },
          aliaAgent: {
            id: '01a0646a-078f-7514-9800-9f43ceed7df8',
            capabilityGrants: ['web', 'artifacts', 'memory'],
          },
        },
        clarity: {
          project: { id: '01a0646a-078f-7f53-848d-a0f82d9f7fa6' },
          bot: { id: '01a0646a-078f-7120-a993-a03c180c81b0' },
          application: { id: '01a0646a-2382-74a3-a795-788924d55722' },
          publicCredential: {
            id: '01a0646e-2508-7048-8c08-b1f7b3af634f',
            clientId: 'oxy_dk_75cdd9996d19362e15ddedcc5ab0f4fb310de8d7b5e8523a',
          },
          backendApplication: { id: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e' },
          backendServiceCredential: {
            id: '01a0648b-8d74-7240-adba-80707fdfdf9c',
            clientId: 'oxy_dk_8c84c74a2656b8f5147d4d0b65fcd0e88c192ce64f465f78',
          },
          aliaAgent: {
            id: '01a0646a-078f-7642-95ef-439952f4f3f9',
            capabilityGrants: [],
          },
        },
      },
    });
  });

  it('hands Alia a private one-to-one bot mapping without names as authority', () => {
    const handoff = aliaNativeAgentBootstrapManifest();
    expect(handoff.agents).toEqual([
      {
        id: '01a0646a-078f-7514-9800-9f43ceed7df8',
        oxyAccountId: '01a0646a-078f-7974-9645-a5e8be237f47',
        applicationId: '6a2f851751b784a86fd0e922',
        ownerOxyAccountId: '6a50444ce8026582b949089d',
        product: 'homiio',
        visibility: 'private',
        capabilityGrants: ['web', 'artifacts', 'memory'],
      },
      {
        id: '01a0646a-078f-7642-95ef-439952f4f3f9',
        oxyAccountId: '01a0646a-078f-7120-a993-a03c180c81b0',
        applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
        ownerOxyAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
        product: 'clarity',
        visibility: 'private',
        capabilityGrants: [],
      },
    ]);
    expect(new Set(handoff.agents.map((agent) => agent.oxyAccountId)).size).toBe(2);
    expect(createHash('sha256').update(JSON.stringify(handoff)).digest('hex')).toHaveLength(64);
  });

  /**
   * The grant is stated as an exclusion as well as an inclusion.
   *
   * `toEqual` on the three names already fixes the list, but it fails the same
   * way whether a fourth family was added or a typo crept in — so the families
   * that must NEVER appear are named, because those are the ones that let an
   * agent act in the world rather than read and answer. `oxy_service` is named
   * too: Oxy app access is not expressible in this vocabulary at all, and a
   * grant string here would be dropped by Alia's reader rather than honoured,
   * which is a silent no-op nobody would notice.
   */
  it('publishes exactly the three reading families for Sindi, and nothing that acts', () => {
    const [sindi, clarity] = aliaNativeAgentBootstrapManifest().agents;
    expect(sindi.capabilityGrants).toEqual(['web', 'artifacts', 'memory']);
    for (const denied of [
      'shell',
      'browser',
      'files',
      'messaging',
      'automation',
      'delegation',
      'mcp',
      'integration',
      'agent',
      'oxy_service',
    ]) {
      expect(sindi.capabilityGrants.some((grant) => grant.split(':')[0] === denied)).toBe(false);
    }
    // Empty is a DECISION in Alia — it denies everything — and not "unset".
    expect(clarity.capabilityGrants).toEqual([]);
  });

  /**
   * The CONSUMER's half of the contract, and the only thing that makes this a
   * contract rather than a publication.
   *
   * Alia owns the `agents` rows this hand-off describes, and for as long as it
   * had no consumer the values above were true and inert: Homiio authenticated,
   * Alia found no row for the Sindi agent id, and the turn was refused with
   * `agent_unavailable`. Alia now pins a copy of this hand-off
   * (`packages/api/src/config/native-product-agents.ts`) and applies it with a
   * reviewed one-shot, and a copy with no gate is a copy that diverges.
   *
   * So both repositories assert the SAME hex over the SAME bytes. Changing this
   * manifest here turns THIS suite red, naming the file in Alia that has to
   * change with it — which is the cheap way to make a two-repository contract
   * fail on the side that broke it, rather than in production in a third
   * product weeks later.
   *
   * `JSON.stringify` preserves insertion order, so the key ORDER in
   * `aliaNativeAgentBootstrapManifest()` is part of what is pinned. Reordering
   * the fields is a manifest change even when every value is identical.
   */
  it('hashes to the exact hex Alia pins for the same bytes', () => {
    const handoff = aliaNativeAgentBootstrapManifest();
    expect(createHash('sha256').update(JSON.stringify(handoff)).digest('hex')).toBe(
      'a7c1c787c24159ce70e1664ce60749c6a9d3b06a23ff461559b5c97ca2104547',
    );
  });

  it('grants Clarity only user:read and exact official web/native redirects', () => {
    const app = NATIVE_PRODUCT_AGENTS.products.clarity.application;
    expect(app.scopes).toEqual(['user:read']);
    expect(app.redirectUris).toEqual([
      'https://clarity.surf',
      'https://clarity.oxy.so',
      'clarity://',
    ]);
    expect(NATIVE_PRODUCT_AGENTS.products.clarity.backendApplication.scopes).toEqual([
      'user:read',
      'inference:invoke',
    ]);
    expect(NATIVE_PRODUCT_AGENTS.products.clarity.backendServiceCredential.scopes).toEqual([
      'user:read',
      'inference:invoke',
    ]);
  });
});

describe('present-requester entry points (ADR 0025)', () => {
  it('admits exactly the Homiio Sindi credential for the Sindi agent and nothing else', () => {
    const {
      NATIVE_PRODUCT_AGENT_ENTRY_POINTS,
      nativeProductAgentEntryPoint,
    } = jest.requireActual('../nativeProductAgents') as typeof import('../nativeProductAgents');
    expect(NATIVE_PRODUCT_AGENT_ENTRY_POINTS).toEqual([{
      product: 'homiio',
      applicationId: '6a2f851751b784a86fd0e922',
      credentialId: '01a0648e-ad3f-7608-aa8b-c07bfef6cf73',
      agentId: '01a0646a-078f-7514-9800-9f43ceed7df8',
    }]);
    expect(nativeProductAgentEntryPoint(
      '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
      '01a0648b-8d74-7240-adba-80707fdfdf9c',
      '01a0646a-078f-7642-95ef-439952f4f3f9',
    )).toBeNull();
  });

  it('pins Alia as the audience application, matching the seeded Alia application', () => {
    const { ALIA_RESOURCE_SERVER_APPLICATION_ID } = jest.requireActual('../nativeProductAgents') as typeof import('../nativeProductAgents');
    const { ALIA_APPLICATION_ID } = jest.requireActual('../../scripts/seedOxyApplicationsSpecs') as typeof import('../../scripts/seedOxyApplicationsSpecs');
    expect(ALIA_RESOURCE_SERVER_APPLICATION_ID).toBe(ALIA_APPLICATION_ID);
  });
});
