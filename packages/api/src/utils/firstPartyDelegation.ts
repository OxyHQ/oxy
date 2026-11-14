/**
 * What Oxy's own services do for a person without asking them (ADR 0066).
 *
 * An Oxy service acts for a person on the strength of what its entry in the
 * first-party registry (`scripts/seedOxyApplicationsSpecs.ts`, `actsForPeople`)
 * declares: on which receiver, to read or to write, and why. There is no grant,
 * consent, task or session behind it, and nothing to renew. Permissions (OAuth
 * scopes, consent, grants) are for third parties only.
 *
 * Data only: no database, no env access. The registry is code, so what a
 * service may do is reviewed in the diff that changes it.
 */

/**
 * Oxy's own API areas a service may act on for a person. Each route that acts
 * for a person names its area; a declaration covers that area only.
 */
export const OXY_PLATFORM_RECEIVERS = [
  /** Oxy Files: a person's files (`/assets/service/user-media*`, linked reads). */
  'files',
  /** A person's linked identities (`/linked-accounts/by-user/:userId`). */
  'linked-accounts',
  /** Mint a session of a managed account the person operates (`/internal/accounts/:id/service-switch`). */
  'account-switch',
  /** A person's records in an application's chain namespace (`/chains/records`). */
  'chains',
  /** A person's privacy relationships (blocks, restrictions: `/privacy`). */
  'privacy',
  /** Safety evaluation on a person's behalf (`/safety`). */
  'safety',
  /** A person's product access snapshot (`/v1/products/:id/access/:subject/service-grants`). */
  'product-access',
  /** Invitation emails a person sends from a product (`/app-invitations/email`). */
  'app-invitations',
  /** Any internal tool of a live first-party capability catalogue (execution authorizations). */
  'tools',
] as const;

export type OxyPlatformReceiver = (typeof OXY_PLATFORM_RECEIVERS)[number];

/** `oxy:<area>` for Oxy's own API, or the exact id of another Oxy application's API. */
export type DelegationReceiver = `oxy:${OxyPlatformReceiver}` | (string & {});

export type DelegationEffect = 'read' | 'write';

/** One thing an Oxy service does for a person. */
export interface FirstPartyDelegation {
  /** Where: `oxy:<area>`, or the receiving Oxy application's exact id. */
  readonly on: DelegationReceiver;
  /** `write` includes `read`. */
  readonly effect: DelegationEffect;
  /** Why, in a sentence the person reads in their activity ("Reads your mail to warn you of important email."). */
  readonly purpose: string;
}

export const DELEGATION_PURPOSE_MAX_LENGTH = 160;

/** The registry entry fields this module reads; kept structural so it never imports the registry. */
export interface DelegatingApplication {
  readonly id?: string;
  readonly name: string;
  readonly actsForPeople?: readonly FirstPartyDelegation[];
}

export function platformReceiver(area: OxyPlatformReceiver): DelegationReceiver {
  return `oxy:${area}`;
}

export function isPlatformReceiver(on: string): boolean {
  return (
    on.startsWith('oxy:') && (OXY_PLATFORM_RECEIVERS as readonly string[]).includes(on.slice(4))
  );
}

/**
 * The declaration that lets `applicationId` act for a person on `on` with
 * `effect`, or `undefined`. Only an entry with its exact `id` can declare:
 * a name is a label, never an authority.
 */
export function declaredDelegation(
  applications: readonly DelegatingApplication[],
  applicationId: string,
  on: DelegationReceiver,
  effect: DelegationEffect,
): FirstPartyDelegation | undefined {
  const app = applications.find((entry) => entry.id !== undefined && entry.id === applicationId);
  return app?.actsForPeople?.find(
    (entry) => entry.on === on && (entry.effect === 'write' || effect === 'read'),
  );
}
