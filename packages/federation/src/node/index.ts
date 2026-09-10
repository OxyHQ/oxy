/**
 * `@oxy.so/federation/node` — the runnable Node/Express federation engine.
 *
 * A SEPARATE subpath from the package root so this Node-only code never enters
 * isomorphic bundles that import `@oxy.so/federation`.
 *
 * Phase 2 (HTTP signatures): the signed-fetch transport — a signed ActivityPub
 * GET with per-hop HTTP-signature re-signing, built over an app-injected
 * SSRF-safe single-hop transport. The pure sign/verify crypto it drives lives in
 * the isomorphic `.` entry.
 *
 * Phase 3 (actor model + resolution): the identity bridge + remote-actor resolver.
 *
 * Phase 4 (delivery + follow lifecycle + routers + inbound dispatch): the outbound
 * delivery transport + follow protocol, the inbound dispatcher (Follow/Accept/
 * Undo(Follow)/Reject, delegating content verbs to the app), and the webfinger +
 * actor + inbox + follow-graph Express routers.
 */

export {
  createSignedFetch,
  type SignedFetch,
  type CreateSignedFetchConfig,
  type SingleHopFetch,
  type SingleHopFetchInit,
  type SignedFetchLogger,
} from './signedFetch';

/**
 * The actor↔Oxy-user identity bridge — the default implementation of the
 * `PUT /users/resolve` + actor-gone archive/delete seam over an injected
 * service-request transport.
 */
export {
  createIdentityBridge,
  type IdentityBridge,
  type IdentityBridgeConfig,
  type IdentityBridgeLogger,
  type ServiceRequest,
  type ServiceRequestMethod,
  type ReportActorGoneOutcome,
  type DeleteActorIdentityOutcome,
} from './identityBridge';

/**
 * Remote-actor resolution/caching/refresh (webfinger, signed actor fetch,
 * 410-Gone tombstone) over a bring-your-own-store adapter, the identity bridge,
 * and injected transports + text normalization.
 */
export {
  createActorResolver,
  ActorResolver,
  type ActorResolverConfig,
  type ActorResolverIdentity,
  type ActorResolverLogger,
  type ActorTextAdapter,
  type FederatedActorStore,
  type FederatedActorRecordBase,
  type FederatedActorUpsert,
  type FederatedActorField,
  type WebFingerFetch,
  type WebFingerJrd,
} from './actorResolver';

/**
 * Outbound activity delivery + the follow lifecycle (Follow / Undo(Follow) /
 * Accept(Follow)) + the `Update(Person)` actor rebroadcast, over injected key
 * custody, an SSRF-safe delivery transport, and bring-your-own-store adapters.
 */
export {
  createDeliveryService,
  type DeliveryService,
  type DeliveryServiceConfig,
  type DeliveryLogger,
  type DeliveryKeys,
  type DeliverSingleHop,
  type DeliverSingleHopInit,
  type DeliverSingleHopResult,
  type DeliveryResponseStream,
  type DeliveryTransport,
  type DeliveryQueueJob,
  type DeliveryFallbackQueue,
  type DeliveryActorFields,
  type DeliveryActorStore,
  type DeliveryFollowStore,
  type DeliveryActorRefresh,
  type DeliveryConsent,
  type DeliveryActorProfile,
  type DeliveryIdentity,
  type DeliveryProfile,
  type SafeUrlVerdict,
} from './delivery';

/**
 * Inbound ActivityPub dispatch — the untrusted-activity validator + switch, the
 * follow-protocol handlers (Follow / Accept / Undo(Follow) / Reject) over the
 * identity + store adapters, and the `onContentActivity` seam every content verb
 * (Create / Announce / Like / Delete / Update, non-follow Undo) is handed to.
 */
export {
  createInboundDispatcher,
  ActorResolutionPendingError,
  type InboundDispatcher,
  type InboundDispatcherConfig,
  type InboundDispatcherLogger,
  type InboundActivityValidation,
  type InboundLocalUser,
  type InboundIdentity,
  type InboundConsent,
  type InboundActorResolver,
  type InboundFollowStore,
  type InboundDelivery,
} from './inboundDispatch';

/** The WebFinger + host-meta discovery router (domain-parameterized, consent-gated). */
export {
  createWebfingerRouter,
  type WebfingerRouterConfig,
  type WebfingerSharingState,
  type WebfingerUser,
  type WebfingerJrd,
  type WebfingerLogger,
} from './webfingerRouter';

/**
 * The ActivityPub actor + inbox + follow-graph router (actor GET incl. the
 * `instance` actor, inbox POST with HTTP-sig verify, followers/following pages).
 */
export {
  createActorRouter,
  type ActorRouterConfig,
  type ActorRouteUser,
  type ActorSharingState,
  type ActorRouterLogger,
  type FollowPage,
} from './actorRouter';
