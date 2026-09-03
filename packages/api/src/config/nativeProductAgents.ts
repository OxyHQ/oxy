/**
 * Canonical identities for Oxy-native product agents.
 *
 * These values are database authorities, not display labels. Bootstrap and
 * downstream deploy gates must compare the exact bytes below; names and slugs
 * exist only so collisions can be detected and explained.
 */
export const NATIVE_PRODUCT_AGENTS = {
  manifestVersion: 1,
  oxyOrganizationId: '69b2d3df5d12f58c9800d651',
  products: {
    homiio: {
      project: {
        id: '01a0646a-078f-72ea-8759-86326484a7e0',
        username: 'homiio',
        displayName: 'Homiio',
        costCenterSlug: 'homiio',
      },
      bot: {
        id: '01a0646a-078f-7974-9645-a5e8be237f47',
        username: 'sindibot',
        displayName: 'Sindi',
      },
      applicationId: '6a2f851751b784a86fd0e922',
      sindiServiceCredential: {
        id: '01a0648e-ad3f-7608-aa8b-c07bfef6cf73',
        clientId: 'oxy_dk_bed4f8941795512ddce5b0662879dccae52d8bd30308d240',
        scopes: ['inference:invoke', 'acting-as:offline'],
      },
      aliaAgent: {
        id: '01a0646a-078f-7514-9800-9f43ceed7df8',
        oxyAccountId: '01a0646a-078f-7974-9645-a5e8be237f47',
        visibility: 'private',
      },
    },
    clarity: {
      project: {
        id: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
        username: 'clarity',
        displayName: 'Clarity',
        costCenterSlug: 'clarity',
      },
      bot: {
        id: '01a0646a-078f-7120-a993-a03c180c81b0',
        username: 'claritybot',
        displayName: 'Clarity',
      },
      application: {
        id: '01a0646a-2382-74a3-a795-788924d55722',
        name: 'Clarity',
        websiteUrl: 'https://clarity.oxy.so',
        redirectUris: ['https://clarity.oxy.so', 'clarity://'],
        scopes: ['user:read'],
      },
      backendApplication: {
        id: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
        name: 'Clarity Backend',
        type: 'internal',
        scopes: ['user:read', 'inference:invoke'],
      },
      backendServiceCredential: {
        id: '01a0648b-8d74-7240-adba-80707fdfdf9c',
        clientId: 'oxy_dk_8c84c74a2656b8f5147d4d0b65fcd0e88c192ce64f465f78',
        scopes: ['user:read', 'inference:invoke'],
      },
      publicCredential: {
        id: '01a0646e-2508-7048-8c08-b1f7b3af634f',
        clientId: 'oxy_dk_75cdd9996d19362e15ddedcc5ab0f4fb310de8d7b5e8523a',
      },
      aliaAgent: {
        id: '01a0646a-078f-7642-95ef-439952f4f3f9',
        oxyAccountId: '01a0646a-078f-7120-a993-a03c180c81b0',
        visibility: 'private',
      },
    },
  },
} as const;

export type NativeProductAgentManifest = typeof NATIVE_PRODUCT_AGENTS;

/** Stable hand-off consumed by Alia's separate, exact-PK bootstrap. */
export function aliaNativeAgentBootstrapManifest(): Readonly<{
  schemaVersion: 1;
  agents: readonly Readonly<{
    id: string;
    oxyAccountId: string;
    applicationId: string;
    ownerOxyAccountId: string;
    product: 'homiio' | 'clarity';
    visibility: 'private';
  }>[];
}> {
  return {
    schemaVersion: 1,
    agents: [
      {
        id: NATIVE_PRODUCT_AGENTS.products.homiio.aliaAgent.id,
        oxyAccountId: NATIVE_PRODUCT_AGENTS.products.homiio.bot.id,
        applicationId: NATIVE_PRODUCT_AGENTS.products.homiio.applicationId,
        ownerOxyAccountId: NATIVE_PRODUCT_AGENTS.products.homiio.project.id,
        product: 'homiio',
        visibility: 'private',
      },
      {
        id: NATIVE_PRODUCT_AGENTS.products.clarity.aliaAgent.id,
        oxyAccountId: NATIVE_PRODUCT_AGENTS.products.clarity.bot.id,
        applicationId: NATIVE_PRODUCT_AGENTS.products.clarity.backendApplication.id,
        ownerOxyAccountId: NATIVE_PRODUCT_AGENTS.products.clarity.project.id,
        product: 'clarity',
        visibility: 'private',
      },
    ],
  };
}
