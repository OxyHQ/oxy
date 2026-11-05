/**
 * `@oxy.so/federation/network` — the network vocabulary and the network-identity
 * rules, with nothing that needs Node.
 *
 * The package root also exports HTTP signatures, which import `node:crypto`, so a
 * web or React Native bundle cannot import the root. A client that has to
 * recognise an upstream profile URL the same way the server does (a composer
 * deciding which links become mentions) imports this entry instead, and reads
 * the same declaration rather than a copy of it. Everything here is also exported
 * from the root.
 */
/*
 * Network identity: the MECHANISM for re-labelling an account republished by a
 * bridge onto the network it actually came from, plus the network vocabulary and
 * the bidirectional upstream-profile-URL rule.
 *
 * The mechanism is here; the ENTRIES are not, and must not be. Which operators
 * may be trusted to re-attribute somebody's account is a moderation judgement an
 * app commits and answers for — `createBridgeRelabeller` takes them as a
 * parameter so no app inherits another's.
 */
export {
  FEDERATION_NETWORKS,
  BSKY_NETWORK_DOMAIN,
  blueskyUsernameFromHandle,
  blueskyHandleFromUsername,
  UNRESOLVED_ATPROTO_HANDLE,
  isUnresolvedAtprotoHandle,
  atprotoIdentityHandle,
  createBridgeRelabeller,
  stripBridgeBoilerplate,
  upstreamProfileUrl,
  parseUpstreamProfileUrl,
  federatedUsernameFromUpstreamUrl,
  upstreamHandleFromProfileField,
  upstreamHandleFromAlsoKnownAs,
  upstreamHandleFromAutomatedActor,
  upstreamHandleFromPreferredUsername,
  upstreamHandleFromProxyOf,
  readProxyDeclarations,
  type FederationNetwork,
  type FederationBridgeEntry,
  type BridgeRelabeller,
  type BridgeConsentModel,
  type BridgeDerivation,
  type BridgedActorField,
  type DeriveNetworkIdentity,
  type NetworkIdentity,
  type NetworkIdentityCandidate,
  type ProxyDeclaration,
} from './networkIdentity';
