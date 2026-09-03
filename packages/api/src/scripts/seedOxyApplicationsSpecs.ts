/**
 * The canonical registry of official Oxy applications — the declarative half of
 * `scripts/seed-oxy-applications.ts`.
 *
 * It lives here, in `src/`, rather than inside the script, for one reason: a
 * scope grant that nothing gates is a comment. `__tests__/seedOxyApplicationsSpecs.test.ts`
 * holds the decisions in this file — which applications carry privileged scopes,
 * which inference scopes Alia holds, and that a first-party application is never
 * silently handed the internal audience — and it cannot import a module whose
 * top level connects to a database and calls `main()`.
 *
 * Data only. No database, no env access, no side effects.
 */

import type { ApplicationCapability } from '../utils/applicationCapabilities';
import {
  catalogApplicationCapability,
  IDENTITY_APPROVAL_CAPABILITY,
  KAANA_PROVIDER_CREDENTIAL_VALIDATOR_CAPABILITY,
} from '../utils/applicationCapabilities';
import type { ApplicationScope } from '../utils/applicationScopes';
import { INBOX_APPLICATION_ID } from '../config/inboxInference';
export { INBOX_APPLICATION_ID } from '../config/inboxInference';

export type SeedAppType = 'first_party' | 'internal';

export interface SeedAppSpec {
  /**
   * Exact immutable application id for machine principals whose authority must
   * never depend on a display name or query order. Existing legacy specs omit
   * it to preserve their deployed ids; every new machine-only app should set it.
   */
  id?: string;
  name: string;
  /**
   * Previous official seed names that should be migrated in-place when present.
   *
   * The seed remains keyed by name for ordinary idempotency, but official app
   * renames must not leave the old active app/credential trusted forever. If a
   * legacy row exists and the new row does not, it is renamed/reconciled in
   * place so the existing client id is preserved. If both rows already exist,
   * the legacy row is suspended and its credentials are revoked.
   */
  legacyNames?: string[];
  description: string;
  websiteUrl?: string;
  type: SeedAppType;
  redirectUris: string[];
  /**
   * App-level scopes. Defaults to `['user:read']`. A PRIVILEGED scope (e.g.
   * `federation:write`) is staff-only and is never self-grantable via the API —
   * granting it here (in this canonical seed, run by staff) is the supported way
   * to elevate an official app. The service-token mint intersects a credential's
   * scopes with the app's scopes, so a credential's `federation:write` only
   * survives if the app ALSO carries it. Mention's federation feature therefore
   * requires `federation:write` here.
   */
  scopes?: ApplicationScope[];
  /**
   * Staff-only platform capabilities. UNIONed into an existing record, never
   * stripped. Commons carries `identity:approval` so push delivery of sign-in
   * requests can target its installs without a separate register-commons run.
   */
  capabilities?: ApplicationCapability[];
  /**
   * Username of the account this application is owned by, when it is NOT the
   * platform owner itself.
   *
   * Every official application is owned by the root `oxy` account by default,
   * and that is right for almost all of them: they are the platform, and their
   * spend is the platform's. It is wrong for an application whose spend has to
   * be REPORTED separately, because cost-centre attribution walks
   * `applications.owner_account_id` up to the nearest registered centre
   * (`entitlement.service.ts`). Two applications sharing an owner account can
   * never be told apart in that report, so an application that needs its own
   * line in it needs its own owner account.
   *
   * The named account must already exist and be a `project` account under the
   * platform owner — `scripts/seed-internal-cost-centers.ts` mints it. The seed
   * REFUSES rather than falling back to the platform owner if it is missing:
   * silently seeding an application onto the root account is exactly the
   * misattribution this field exists to prevent, and it would be invisible until
   * a month-end report showed one number where five were expected.
   */
  ownerAccountUsername?: string;
}

export type SeedApplicationLookupIdentity =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'legacy-name'; readonly name: string; readonly createdByUserId: string };

/**
 * Select the immutable identity the production seed query must use.
 *
 * Keeping this decision pure and shared with its tests prevents a pinned
 * machine application from quietly falling back to display-name lookup when
 * the query is refactored.
 */
export function seedApplicationLookupIdentity(
  spec: SeedAppSpec,
  createdByUserId: string
): SeedApplicationLookupIdentity {
  return spec.id === undefined
    ? { kind: 'legacy-name', name: spec.name, createdByUserId }
    : { kind: 'id', id: spec.id };
}

/**
 * The scopes the Alia application holds, and the argument for each — issue #972
 * workstream 14, "grant only the inference scopes Alia requires", widened by the
 * service lane that lets Alia act FOR a user and AS a managed account.
 *
 * Alia is a CONSUMER of the inference platform, not an operator of it. That
 * sentence still decides the whole inference half of the list: Alia may spend its
 * owner account's balance, see what it can spend it on, and read back what it
 * spent. It may not change where anyone's traffic goes.
 *
 * The delegation half answers a DIFFERENT question, and running the two together
 * is how a consumer's scope list quietly becomes an operator's. Delegation is not
 * an inference capability spelled differently: it decides WHOSE VOICE a request
 * carries, and it reaches the account graph, which nothing in the `inference:*`
 * family touches. So it is argued on its own terms, separately, below.
 *
 * GRANTED — inference:
 *
 *  - `user:read` — the baseline every official application holds; Alia signs
 *    users in with Oxy.
 *  - `inference:invoke` — Alia serves chat. This is the scope that spends the
 *    OWNING ACCOUNT's balance on a request, which is the point of the
 *    integration. Non-privileged: an application can only ever spend the balance
 *    of the account that owns it, and a delegated end-user id is never the
 *    billing principal (ADR 0007).
 *  - `inference:models:read` — Alia renders a model picker and resolves a model
 *    reference before it invokes one. Reading the catalogue is bounded to what
 *    the caller's audience may see; Alia's own audience comes from its
 *    application `type`, not from this scope.
 *  - `inference:usage:read` — two surfaces need it, and both are Alia's own
 *    records: `GET /billing/accounts/:accountId/entitlements`, which is the
 *    entitlement interface Alia's product plans query and which requires exactly
 *    this scope for a service principal, and the per-application usage reports.
 *    A service credential reaches only its own owner account through it.
 *  - `inference:routing:read` — Alia has to be able to say WHICH routing profile
 *    served a request when a user reports a slow or wrong answer. Describing
 *    where a request would go is not deciding it, and an app that cannot see the
 *    catalogue cannot debug its own latency.
 *
 * GRANTED — delegation. BOTH ARE STAFF-GATED
 * ({@link PRIVILEGED_APPLICATION_SCOPES}), so neither is self-grantable by the
 * application's owner and this canonical seed — run by staff — is the supported
 * way to hold them:
 *
 *  - `acting-as:offline` — Alia's backend does work for a user OUTSIDE a request
 *    that user made: an agent run, a scheduled job, an inbound message to a bot
 *    its owner registered. Without this scope a service token can act only as
 *    Alia ITSELF, so that work is indistinguishable from work Alia did for its
 *    own account. `GET /internal/service-acting-as/verify` is what reads it, and
 *    it answers `authorized: false` for any application that does not hold it —
 *    the capability is unreachable rather than merely unauthorized.
 *
 *    Also CONSENT-REQUIRED ({@link USER_CONSENT_REQUIRED_SCOPES}), and that is
 *    the half that matters to the person on the other end: the user is asked, a
 *    revocable `app_grants` row is written, and Alia lands in "Connected apps"
 *    where they can take it back. Being first-party buys no exemption — a
 *    trusted application records no grant row otherwise, which would leave the
 *    verify endpoint with nothing to read.
 *  - `accounts:act-as-session` — Alia runs agents that ARE accounts rather than
 *    labels. An agent bound to a `bot` account has to speak with that account's
 *    voice everywhere in the ecosystem, and `POST /internal/accounts/:id/service-switch`
 *    mints the session that lets it. Deliberately NOT consent-required, for the
 *    reason recorded on {@link USER_CONSENT_REQUIRED_SCOPES}: that lane never
 *    reads an `app_grants` row for this scope, so a screen would name the wrong
 *    person and authorise nothing.
 *
 *    Holding it authorises NOTHING on its own, which is what makes it safe at
 *    the ceiling: the mint additionally requires a human who holds
 *    `account:act_as` over the target account. Alia can become a managed account
 *    somebody delegated to it, and no other account in the ecosystem.
 *
 * WITHHELD, each for its own reason rather than by omission:
 *
 *  - `inference:routing:write` — STAFF-GATED (`PRIVILEGED_APPLICATION_SCOPES`).
 *    Routing profiles are catalogue objects the platform serves every tenant
 *    from, so holding this would let Alia repoint traffic that is not its own.
 *    Being first-party is not an argument for it: the whole reason the scope is
 *    privileged is that the object is shared, and Alia is one tenant of it.
 *    Routing policy for Alia's traffic is set BY Oxy, on Alia's behalf, through
 *    the staff surface — which is the same answer for every other consumer.
 *  - `inference:providers:write` — STAFF-GATED, and the most consequential scope
 *    in the family: it manages provider connections, BYOK credentials included.
 *    Alia neither holds nor rotates provider secrets under this integration;
 *    that is precisely the responsibility workstream 14 moves OFF Alia ("deprecate
 *    Alia-owned developer keys and provider billing"). Granting it back would
 *    re-create the thing being removed.
 *  - `inference:providers:read` — NOT privileged, and withheld anyway, because
 *    Alia has no use for it. It describes provider and deployment connections;
 *    the one provider fact Alia surfaces is which provider served a given
 *    request, and the edge already returns that on every response as
 *    `X-Oxy-Provider`. A scope granted "in case" is authority nobody re-examines,
 *    and this one is self-grantable — it can be added the day a surface needs it,
 *    by the application's own owner, with no staff round trip.
 *
 * Nothing outside the `inference:*` family, `user:read` and those two delegation
 * scopes is granted. Alia is not a federation peer, does not move reputation,
 * writes no signals, sends no notifications and touches no follow graph.
 *
 * These two privileged entries are why `__tests__/seedOxyApplicationsSpecs.test.ts`
 * now pins the privileged subset BY NAME instead of asserting it is empty. "Alia
 * holds no staff-gated scope of any family" was a real gate, not a formality, so
 * the replacement has to bite in the same place: a THIRD privileged scope
 * appearing here must fail the suite, and a named one going missing must fail it
 * too. What changed is the decision, not whether one is enforced.
 */
export const ALIA_APPLICATION_SCOPES: readonly ApplicationScope[] = [
  'user:read',
  'inference:invoke',
  'inference:models:read',
  'inference:usage:read',
  'inference:routing:read',
  'acting-as:offline',
  'accounts:act-as-session',
];

/**
 * The username of the project account Alia's application is owned by, and
 * therefore the cost centre its spend books to.
 *
 * Equal to the cost centre's slug by construction — `seed-internal-cost-centers.ts`
 * uses the slug as the account's username, so the two identifiers cannot drift.
 */
export const ALIA_OWNER_ACCOUNT_USERNAME = 'alia-production-chat';

/** Exact opaque identity of the Kaana control/data-plane application. */
export const KAANA_APPLICATION_ID = '68b7c4e19f2a6d0e3c8b5174';

/** Exact opaque identity verified against the active production Alia row. */
export const ALIA_APPLICATION_ID = '6a2f851751b784a86fd0e934';

/** Exact opaque identity already assigned to Homiio in production. */
export const HOMIIO_APPLICATION_ID = '6a2f851751b784a86fd0e922';

/** Exact opaque identity read back from the active production Mention row. */
export const MENTION_APPLICATION_ID = '6a2f851751b784a86fd0e916';

/**
 * The official Oxy ecosystem apps that integrate Oxy auth.
 * `name` is the idempotency key (with createdByUserId=oxyId) — DO NOT rename
 * casually, a rename creates a new Application rather than updating one.
 *
 * `redirectUris` are OAuth redirect URIs. Trust derivation
 * (`dynamicOriginRegistry`, FedCM approved clients) keys on the ORIGIN of each
 * URI, so web apps register their apex origin as the redirect surface; native
 * apps register their deep-link schemes.
 */
export const SEED_APPS: SeedAppSpec[] = [
  {
    id: KAANA_APPLICATION_ID,
    name: 'Kaana',
    description: 'Official Kaana inference data plane and BYOK credential validator.',
    websiteUrl: 'https://kaana.ai',
    type: 'internal',
    redirectUris: [],
    scopes: ['inference:byok:validate'],
    capabilities: [KAANA_PROVIDER_CREDENTIAL_VALIDATOR_CAPABILITY],
  },
  // ── OxyHQServices first-party web apps (CF Pages) ──
  {
    name: 'Oxy Accounts',
    description: 'Official Oxy account management app (My Account).',
    websiteUrl: 'https://accounts.oxy.so',
    type: 'first_party',
    redirectUris: ['https://accounts.oxy.so'],
  },
  {
    name: 'Oxy Console',
    description: 'Official Oxy developer console (Cloud).',
    websiteUrl: 'https://console.oxy.so',
    type: 'first_party',
    redirectUris: ['https://console.oxy.so'],
  },
  {
    id: INBOX_APPLICATION_ID,
    name: 'Oxy Inbox',
    description: 'Official Oxy email/inbox app.',
    websiteUrl: 'https://inbox.oxy.so',
    type: 'first_party',
    redirectUris: ['https://inbox.oxy.so'],
    scopes: [
      'user:read',
      'inference:invoke',
      'catalogs:write',
      'capability-events:publish',
    ],
    capabilities: [catalogApplicationCapability('inbox')],
  },
  {
    name: 'Oxy Auth',
    description: 'Official Oxy authentication app and third-party OAuth Identity Provider.',
    websiteUrl: 'https://auth.oxy.so',
    type: 'first_party',
    // The auth app is the third-party OAuth IdP, but it now ALSO consumes
    // Sign-in-with-Oxy as its own Relying Party, so it registers its own
    // origin as the redirect surface.
    redirectUris: ['https://auth.oxy.so'],
  },
  // ── Ecosystem first-party apps ──
  {
    id: MENTION_APPLICATION_ID,
    name: 'Mention',
    description: 'Official Oxy social media app with fediverse support.',
    websiteUrl: 'https://mention.earth',
    type: 'first_party',
    redirectUris: ['https://mention.earth'],
    // Mention federates: its service credential signs HTTP-Signatures and
    // resolves federated users. The mint intersects credential scopes with these
    // app scopes, so the app MUST carry federation:write for the credential's
    // federation:write to survive. files:write is needed for federated-media S3
    // caching (POST /assets/service/cache); files:read for reading cached assets
    // back (GET /assets/service/*). signals:write lets Mention push cross-app
    // recommendation signals (interest + interaction-affinity edges) — the
    // credential already carries it, so the app MUST declare it or the mint's
    // intersection drops it.
    scopes: [
      'user:read',
      'files:read',
      'files:write',
      'federation:write',
      'signals:write',
      'catalogs:write',
      'capabilities:read',
      'capability-audit:write',
    ],
    capabilities: [catalogApplicationCapability('mention')],
  },
  {
    id: HOMIIO_APPLICATION_ID,
    name: 'Homiio',
    description: 'Official Oxy real estate platform.',
    websiteUrl: 'https://homiio.com',
    type: 'first_party',
    // Web and native explicit re-consent callbacks. The custom scheme is
    // intentionally exact: PKCE + state bind the native return, and neither the
    // seed nor the SDK accepts a wildcard, whitespace-normalized or substitute
    // scheme.
    redirectUris: ['https://homiio.com', 'homiio://oauth/consent'],
    // Homiio awards Oxy Trust on lease lifecycle events via its service credential.
    // `reputation:write` is staff-gated — the seed script grants it to official apps.
    // Interactive Sindi uses Homiio's service token plus X-Oxy-User-Id. The
    // delegation verifier requires this app/credential ceiling explicitly.
    scopes: ['user:read', 'reputation:write', 'inference:invoke', 'acting-as:offline'],
  },
  {
    name: 'Allo',
    description: 'Official Oxy encrypted messaging app.',
    websiteUrl: 'https://allo.you',
    type: 'first_party',
    redirectUris: ['https://allo.you', 'https://allo.oxy.so'],
  },
  {
    id: ALIA_APPLICATION_ID,
    name: 'Alia',
    description: 'Official Oxy AI platform (chat app, console, canvas, gateway).',
    websiteUrl: 'https://alia.onl',
    // `internal`, not `first_party`, and this is the load-bearing field of the
    // whole workstream-14 registration rather than a label.
    //
    // `resolveCatalogueViewer` (`services/inferenceCatalogue.service.ts`) grants
    // the `internal_alia` availability scope to `internal`/`system` applications
    // ONLY, and it excludes `first_party` on purpose: Console and Accounts are
    // first-party and customer-facing, so handing that type the internal
    // audience would put internal-only routes in front of customers. Alia
    // registered as `first_party` is therefore a PUBLIC catalogue viewer — it
    // cannot be routed to the very deployments whose availability scope is named
    // after it, and the symptom is a model that silently is not offered rather
    // than an error.
    //
    // Nothing else narrows: `isTrustedApplication()` already accepts `internal`
    // exactly as it accepts `first_party`, so the credentialed CORS lane, OAuth
    // consent auto-approval, service-credential creation and the sign-in dialog
    // are all unchanged. `computeSeedApplicationPlan` derives `isInternal` from
    // this field, so the flag follows without a second declaration.
    type: 'internal',
    redirectUris: ['https://alia.onl'],
    // See ALIA_APPLICATION_SCOPES for the grant and, more importantly, for the
    // argument against each scope NOT granted.
    scopes: [...ALIA_APPLICATION_SCOPES],
    // Alia's spend has to appear on its own line in the cost-centre report, so
    // it is owned by its own project account rather than by the platform owner
    // every other official app shares. See `ownerAccountUsername`.
    ownerAccountUsername: ALIA_OWNER_ACCOUNT_USERNAME,
  },
  {
    name: 'Syra',
    description: 'Official Oxy app.',
    websiteUrl: 'https://syra.fm',
    type: 'first_party',
    redirectUris: ['https://syra.fm'],
  },
  {
    name: 'TNP',
    description: 'Official Oxy alternative DNS/namespace system.',
    websiteUrl: 'https://tnp.network',
    type: 'first_party',
    redirectUris: ['https://tnp.network'],
  },
  {
    name: 'Oxy Website',
    description: 'Official Oxy / FairCoin marketing website.',
    websiteUrl: 'https://oxy.so',
    type: 'first_party',
    redirectUris: ['https://oxy.so', 'https://fairco.in'],
  },
  {
    name: 'Oxy Pay',
    description: 'Official Oxy payments app.',
    websiteUrl: 'https://pay.oxy.so',
    type: 'first_party',
    redirectUris: ['https://pay.oxy.so'],
    scopes: ['user:read', 'payments:read', 'payments:write'],
  },
  {
    name: 'Noted',
    description: 'Official Oxy notes app.',
    websiteUrl: 'https://noted.oxy.so',
    type: 'first_party',
    redirectUris: ['https://noted.oxy.so'],
    scopes: [
      'user:read',
      'catalogs:write',
      'capabilities:read',
      'capability-audit:write',
      'capability-events:publish',
    ],
    capabilities: [catalogApplicationCapability('noted')],
  },
  {
    name: 'Commons by Oxy',
    description:
      'Official Oxy Commons app — self-sovereign identity wallet and Sign-in-with-Oxy approvals (native).',
    type: 'first_party',
    // Commons is native-only (no web). Its public client id (the credential
    // publicKey) wires into OxyProvider; the redirect surface is the app's two
    // deep-link schemes from packages/commons/app.json, so both are listed.
    redirectUris: ['commons://', 'oxycommons://'],
    capabilities: [IDENTITY_APPROVAL_CAPABILITY],
  },
  {
    name: 'Mercaria',
    legacyNames: ['Marketplace'],
    description: 'Official Oxy marketplace app — buy and sell new and secondhand items.',
    websiteUrl: 'https://mercaria.co',
    type: 'first_party',
    // Storefront (mercaria.co) + the two first-party admin surfaces that share
    // this client: the store/merchant dashboard and the point-of-sale app.
    // Trust derivation matches the RP by the origin of an approved redirect
    // URI, so each subdomain's origin is listed here.
    redirectUris: [
      'https://mercaria.co',
      'https://dashboard.mercaria.co',
      'https://pos.mercaria.co',
    ],
    // Mercaria owns one canonical capability catalog. Its service credential
    // registers that catalog, validates live capability tickets and records
    // their execution audit; it receives no coordinator or ticket-mint scope.
    scopes: [
      'user:read',
      'catalogs:write',
      'capabilities:read',
      'capability-audit:write',
    ],
    capabilities: [catalogApplicationCapability('mercaria')],
  },
  {
    name: 'Moovo',
    description: 'Official Oxy courier/transport app — send packages, food, and moves.',
    websiteUrl: 'https://moovo.now',
    type: 'first_party',
    redirectUris: [
      'https://moovo.now',
      'https://go.moovo.now',
      'https://hub.moovo.now',
    ],
  },
  {
    name: 'Atlas',
    description:
      'The Oxy App Store — the storefront people browse before they choose an app, and where they review one afterwards.',
    websiteUrl: 'https://atlas.oxy.so',
    type: 'first_party',
    // The storefront is readable signed out, so this client exists for exactly
    // one thing: signing somebody in to write a review. Only the app's own
    // origin is listed; there is no second surface.
    redirectUris: ['https://atlas.oxy.so'],
  },
  {
    name: 'CrowdSource',
    description:
      'Official Oxy participatory moderation platform — reviewers are assigned cases by the server and review them blind.',
    websiteUrl: 'https://crowdsource.oxy.so',
    type: 'first_party',
    // Two web surfaces share this client, so each origin is listed: the
    // reviewer app, and the Trust & Safety / developer console. Trust
    // derivation (`dynamicOriginRegistry`) keys on the ORIGIN of each redirect
    // URI, and the console is a distinct origin — without its own entry it
    // gets neither the credentialed CORS lane nor an exact-match redirect,
    // however official the parent application is.
    //
    // The console origin is registered ahead of its first deploy on purpose:
    // it is already built and merged, and a redirect surface that only exists
    // after a second round trip blocks the deploy rather than the reverse.
    //
    // Both frontends ship to the web only today. The Expo `crowdsource://`
    // deep-link scheme is registered here when a native build actually ships —
    // an unused redirect surface is authority nobody asked for.
    redirectUris: ['https://crowdsource.oxy.so', 'https://console.crowdsource.oxy.so'],
    // Sign-in ONLY, so the default `['user:read']`. CrowdSource must never
    // carry `reputation:write`: it never moves an Oxy Trust figure itself, it
    // emits a decision and Oxy Trust's own consequence engine decides the
    // effect. Granting it here would also widen every device sign-in grant,
    // because a device sign-in's granted scopes ARE the application's scopes
    // (`routes/auth.ts` — `scopes = appScopes` when there is no OAuth request).
  },
];
