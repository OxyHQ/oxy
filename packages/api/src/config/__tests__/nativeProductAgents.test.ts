import { createHash } from 'node:crypto';
import {
  NATIVE_PRODUCT_AGENTS,
  aliaNativeAgentBootstrapManifest,
} from '../nativeProductAgents';

describe('native product agent identities', () => {
  it('pins the approved Oxy, app, credential, bot and Alia primary keys', () => {
    expect(NATIVE_PRODUCT_AGENTS).toMatchObject({
      oxyOrganizationId: '69b2d3df5d12f58c9800d651',
      products: {
        homiio: {
          project: { id: '01a0646a-078f-72ea-8759-86326484a7e0' },
          bot: { id: '01a0646a-078f-7974-9645-a5e8be237f47' },
          applicationId: '6a2f851751b784a86fd0e922',
          sindiServiceCredential: {
            id: '01a0648e-ad3f-7608-aa8b-c07bfef6cf73',
            clientId: 'oxy_dk_bed4f8941795512ddce5b0662879dccae52d8bd30308d240',
          },
          aliaAgent: { id: '01a0646a-078f-7514-9800-9f43ceed7df8' },
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
          aliaAgent: { id: '01a0646a-078f-7642-95ef-439952f4f3f9' },
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
        ownerOxyAccountId: '01a0646a-078f-72ea-8759-86326484a7e0',
        product: 'homiio',
        visibility: 'private',
      },
      {
        id: '01a0646a-078f-7642-95ef-439952f4f3f9',
        oxyAccountId: '01a0646a-078f-7120-a993-a03c180c81b0',
        applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
        ownerOxyAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
        product: 'clarity',
        visibility: 'private',
      },
    ]);
    expect(new Set(handoff.agents.map((agent) => agent.oxyAccountId)).size).toBe(2);
    expect(createHash('sha256').update(JSON.stringify(handoff)).digest('hex')).toHaveLength(64);
  });

  it('grants Clarity only user:read and exact official web/native redirects', () => {
    const app = NATIVE_PRODUCT_AGENTS.products.clarity.application;
    expect(app.scopes).toEqual(['user:read']);
    expect(app.redirectUris).toEqual(['https://clarity.oxy.so', 'clarity://']);
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
