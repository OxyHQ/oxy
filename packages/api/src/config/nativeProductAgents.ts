import {
  workloadAttestationHandle,
  type AttestationProvider,
} from '../services/workloadAttestation.service';

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
        /**
         * What Sindi may reach inside Alia, in ALIA's vocabulary
         * (`packages/api/src/domain/capability-grants.ts` there).
         *
         * Oxy does not define these names and does not enforce them; it
         * publishes them because a capability grant is an AUTHORITY, and this
         * manifest is the hashed, two-repository-reviewed channel every other
         * authority in the binding already travels through. The alternative —
         * Alia deciding it alone — makes widening a product agent's reach a
         * one-repository edit, which is exactly what the application binding
         * below is not allowed to be.
         *
         * Exactly three families, in this order: `web` (search, scraping,
         * browsing, deep research and the card tools), `artifacts` (canvas and
         * generated files) and `memory` (what the person has already said).
         * Nothing that acts in the world: no shell, browser, files, messaging,
         * automation, delegation, MCP or integration. Oxy app access is NOT
         * expressible here at all — Oxy's own DelegationGrant records are its
         * sole authority.
         */
        capabilityGrants: ['web', 'artifacts', 'memory'],
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
        /** Nothing granted. Empty DENIES in Alia; it is not "unset". */
        capabilityGrants: [],
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
 *
 * `capabilityGrants` is the one field written in ALIA's vocabulary rather than
 * Oxy's. It is here, and not in Alia's own seed file beside the tagline,
 * because it is the only field that decides what the agent may DO: a tagline
 * that drifts is cosmetic, and a grant that drifts is a product assistant that
 * quietly gained a tool nobody approved. Publishing it through the hash makes
 * widening it a change both repositories have to merge. An EMPTY array is a
 * decision — it denies everything — and never "unset".
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
    capabilityGrants: readonly string[];
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
        capabilityGrants: NATIVE_PRODUCT_AGENTS.products.homiio.aliaAgent.capabilityGrants,
      },
      {
        id: NATIVE_PRODUCT_AGENTS.products.clarity.aliaAgent.id,
        oxyAccountId: NATIVE_PRODUCT_AGENTS.products.clarity.bot.id,
        applicationId: NATIVE_PRODUCT_AGENTS.products.clarity.backendApplication.id,
        ownerOxyAccountId: NATIVE_PRODUCT_AGENTS.products.clarity.project.id,
        product: 'clarity',
        visibility: 'private',
        capabilityGrants: NATIVE_PRODUCT_AGENTS.products.clarity.aliaAgent.capabilityGrants,
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

/**
 * A workload an entry point also answers to — the ADR 0026 form of the same
 * identity.
 *
 * The ROLE is declared, never the handle. A role ARN is reviewable (anyone can
 * read the task definition that names it) and the handle is computed from it
 * with {@link workloadAttestationHandle}, the one definition the mint itself
 * uses. A hard-coded `wl_…` digest would be a magic constant no reviewer could
 * check and no operator could reproduce, and it would silently stop matching if
 * the derivation ever moved.
 */
export interface NativeProductAgentWorkload {
  readonly provider: AttestationProvider;
  /**
   * The CANONICAL subject, exactly as `application_workload_identities.subject`
   * stores it and `canonicalAwsSubject` produces it: a pathless IAM role ARN,
   * never the per-task `assumed-role/<role>/<session>` ARN STS reports.
   */
  readonly subject: string;
}

export interface NativeProductAgentEntryPoint {
  readonly product: 'homiio';
  readonly applicationId: string;
  readonly credentialId: string;
  readonly agentId: string;
  /**
   * The attested workload that is the SAME product backend, or `null` for an
   * entry point that may only ever call with a credential.
   *
   * Declaring one admits a second way to prove one identity, not a second
   * identity: the binding row still has to name this application, still has to
   * be live, and still has to name `inference:invoke` — see
   * `services/nativeRequesterAssertion.service.ts`. Adding one is as much a
   * reviewed authority change as adding a product, and for the same reason:
   * provisioning a workload must not silently hand it a product's entry.
   */
  readonly workload: NativeProductAgentWorkload | null;
}

/**
 * The exact entry points that may trade a present requester's live session for a
 * present-requester assertion (ADR 0025).
 *
 * Each names one application, one agent, and the service identities that may
 * call as it: a pinned credential id, and — since ADR 0026 — optionally the IAM
 * role whose attestation proves the same backend.
 *
 * Deliberately NOT derived from "every product in the manifest": being a
 * native product agent does not by itself mean the product's backend should be
 * able to enter Alia for a signed-in person. Adding a product here is a reviewed
 * authority change, not a side effect of provisioning its agent — and neither is
 * adding a `workload`, which is why the role ARN is written out here rather than
 * read from `application_workload_identities`. A binding row is created by the
 * platform when a service is deployed; if this list took its word for it, every
 * bind would be a grant of Homiio's entry point to whatever was just deployed.
 */
export const NATIVE_PRODUCT_AGENT_ENTRY_POINTS: readonly NativeProductAgentEntryPoint[] = [
  {
    product: 'homiio',
    applicationId: NATIVE_PRODUCT_AGENTS.products.homiio.applicationId,
    credentialId: NATIVE_PRODUCT_AGENTS.products.homiio.sindiServiceCredential.id,
    agentId: NATIVE_PRODUCT_AGENTS.products.homiio.aliaAgent.id,
    /**
     * Homiio's ECS task role. It is bound to this same application
     * (`bind-workload-identity.ts --app-id 6a2f851751b784a86fd0e922 --role-arn
     * …/oxy-homiio-task`) and its binding names `inference:invoke` and
     * `acting-as:offline`, which is what an attested Sindi token was measured
     * carrying. Without this line an attested Homiio backend matches nothing,
     * and every Sindi chat turn tells a signed-in person to sign in.
     */
    workload: { provider: 'aws-iam', subject: 'arn:aws:iam::237343248947:role/oxy-homiio-task' },
  },
];

/**
 * WHICH of an entry point's two proofs a caller presented.
 *
 * The distinction is not cosmetic: the two are checked against different rows.
 * A credential-minted caller is re-read as an `ApplicationCredential`; an
 * attested caller has no credential row at all and is re-read as its binding.
 * Losing the distinction here would mean checking one caller's liveness against
 * the other's row.
 */
export type NativeProductAgentPrincipal =
  | { readonly kind: 'credential'; readonly credentialId: string }
  | {
      readonly kind: 'workload';
      readonly provider: AttestationProvider;
      readonly subject: string;
      /** `wl_…`, derived from `subject`; equal to the `credentialId` presented. */
      readonly handle: string;
    };

export interface NativeProductAgentEntryPointMatch {
  readonly entry: NativeProductAgentEntryPoint;
  readonly principal: NativeProductAgentPrincipal;
}

/**
 * The entry point this caller is, with the proof it presented, or `null`.
 *
 * `applicationId` and `agentId` match exactly, as they always have.
 * `credentialId` is the value off the VERIFIED service token — an
 * `ApplicationCredential` id on the credential path and an attestation handle
 * on the workload path (`services/serviceTokenMint.service.ts`) — and it must
 * equal, byte for byte, either the pinned credential or the handle DERIVED from
 * the declared role. Nothing is inferred from the `wl_` prefix: a `wl_`-shaped
 * value that is not this role's handle matches nothing, and neither does
 * another service's real, valid handle.
 */
export function nativeProductAgentEntryPoint(
  applicationId: string,
  credentialId: string,
  agentId: string,
): NativeProductAgentEntryPointMatch | null {
  for (const entry of NATIVE_PRODUCT_AGENT_ENTRY_POINTS) {
    if (entry.applicationId !== applicationId || entry.agentId !== agentId) continue;
    if (credentialId === entry.credentialId) {
      return { entry, principal: { kind: 'credential', credentialId: entry.credentialId } };
    }
    const workload = entry.workload;
    if (workload !== null && credentialId === workloadAttestationHandle(workload.subject)) {
      return {
        entry,
        principal: {
          kind: 'workload',
          provider: workload.provider,
          subject: workload.subject,
          handle: credentialId,
        },
      };
    }
  }
  return null;
}
