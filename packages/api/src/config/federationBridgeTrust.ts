import { canonicalFederationHost } from '@oxy.so/federation';
import { FEDERATION_BRIDGE_POLICY } from './federationBridgePolicy';

/** Compatibility projection of the single Oxy-owned reviewed bridge policy. */
export interface FederationBridgeTrustEntry {
  readonly host: string;
  readonly networkDomain: string;
  readonly reason: string;
  readonly since: string;
}

export const FEDERATION_BRIDGE_TRUST: readonly FederationBridgeTrustEntry[] = FEDERATION_BRIDGE_POLICY.map(entry => ({
  host: entry.host, networkDomain: entry.network.domain, reason: entry.evidence, since: entry.since,
}));

/** Host authorization is never sufficient proof of a particular upstream account. */
export function bridgeVouchesForNetwork(actorHost: string, networkDomain: string): boolean {
  return FEDERATION_BRIDGE_TRUST.some(entry => canonicalFederationHost(entry.host) === canonicalFederationHost(actorHost)
    && canonicalFederationHost(entry.networkDomain) === canonicalFederationHost(networkDomain));
}
