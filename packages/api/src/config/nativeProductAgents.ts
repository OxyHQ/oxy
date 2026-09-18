/**
 * Canonical identities for Oxy-native product agents.
 *
 * These values are database authorities, not display labels. Bootstrap and
 * downstream deploy gates must compare the exact bytes below; names and slugs
 * exist only so collisions can be detected and explained.
 */
export const NATIVE_PRODUCT_AGENTS = {
  manifestVersion: 2,
  oxyOrganizationId: '69b2d3df5d12f58c9800d651',
  products: {
    homiio: {
      project: {
        id: '6a50444ce8026582b949089d',
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
        websiteUrl: 'https://clarity.surf',
        redirectUris: ['https://clarity.surf', 'https://clarity.oxy.so', 'clarity://'],
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

/**
 * Stable hand-off consumed by Alia's separate, exact-PK bootstrap.
 *
 * The consumer is `packages/api/src/config/native-product-agents.ts` in
 * OxyHQ/Alia, which pins these exact bytes, and
 * `scripts/bootstrap-native-product-agents.ts` beside it, which writes the
 * `agents` rows they describe. Alia owns that table; this function is the only
 * thing that tells it what to write.
 *
 * **Both repositories pin the SHA-256 of `JSON.stringify` of this value**, and
 * `__tests__/nativeProductAgents.test.ts` asserts it here. Editing the shape or
 * any value below therefore fails this suite with the Alia file named in it,
 * rather than shipping a manifest whose only consumer still believes the old
 * one. `JSON.stringify` preserves insertion order, so the key order below is
 * part of what is pinned.
 */
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

/**
 * Alia's Oxy application — the only audience a present-requester assertion is
 * minted for, and the only application allowed to introspect (and consume) one.
 * Pinned beside the seed spec's `ALIA_APPLICATION_ID`; a test compares them.
 */
export const ALIA_RESOURCE_SERVER_APPLICATION_ID = '6a2f851751b784a86fd0e934';

/** The `aud` of a present-requester assertion. */
export const REQUESTER_ASSERTION_AUDIENCE = 'alia';

export interface NativeProductAgentEntryPoint {
  readonly product: 'homiio';
  readonly applicationId: string;
  readonly credentialId: string;
  readonly agentId: string;
}

/**
 * The exact (application, credential, agent) triples that may trade a present
 * requester's live session for a present-requester assertion (ADR 0025).
 *
 * Deliberately NOT derived from "every product in the manifest": being a
 * native product agent does not by itself mean the product's backend should be
 * able to enter Alia for a signed-in person. Adding a product here is a reviewed
 * authority change, not a side effect of provisioning its agent.
 */
export const NATIVE_PRODUCT_AGENT_ENTRY_POINTS: readonly NativeProductAgentEntryPoint[] = [
  {
    product: 'homiio',
    applicationId: NATIVE_PRODUCT_AGENTS.products.homiio.applicationId,
    credentialId: NATIVE_PRODUCT_AGENTS.products.homiio.sindiServiceCredential.id,
    agentId: NATIVE_PRODUCT_AGENTS.products.homiio.aliaAgent.id,
  },
];

/** The entry point matching all three identifiers exactly, or `null`. */
export function nativeProductAgentEntryPoint(
  applicationId: string,
  credentialId: string,
  agentId: string,
): NativeProductAgentEntryPoint | null {
  return NATIVE_PRODUCT_AGENT_ENTRY_POINTS.find((entry) => (
    entry.applicationId === applicationId
    && entry.credentialId === credentialId
    && entry.agentId === agentId
  )) ?? null;
}
