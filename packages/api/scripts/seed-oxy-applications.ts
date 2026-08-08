#!/usr/bin/env bun
/**
 * Idempotent seed: register a first-party / internal `Application` record for
 * every official Oxy app in the ecosystem, owned by the platform user `oxy`.
 *
 * For each app this UPSERTS (never duplicates on re-run):
 *   - Application      keyed by (name + createdByUserId = oxyId), owned by the
 *                      root `oxy` account itself (ownerAccountId = oxyId) — app
 *                      access derives from it, with no per-app member row and no
 *                      intermediate organization account
 *   - ApplicationCredential  type:'public', environment:'production',
 *                            publicKey minted EXACTLY like the real create route
 *                            (`oxy_dk_` + 24 random bytes hex). A `public`
 *                            credential carries NO secret (secretHash absent),
 *                            mirroring `routes/applications.ts`. Existing public
 *                            prod credentials are REUSED — never re-minted.
 *
 * Safety:
 *   - No deletes, no drops, no modification of unrelated documents.
 *   - Re-running performs 0 inserts once seeded (verified by the summary).
 *   - DRY_RUN=true reports the plan without writing.
 *
 * Run (inside the oxy-api image, working dir /app):
 *   bun run packages/api/scripts/seed-oxy-applications.ts
 *
 * Register/reconcile ONE application, leaving every other record untouched:
 *   ONLY_APPS='CrowdSource' bun run packages/api/scripts/seed-oxy-applications.ts
 *
 * Env:
 *   DATABASE_URL  required (injected by ECS from SSM)
 *   OXY_USERNAME  owner username to resolve (default 'oxy')
 *   DRY_RUN=1|true  plan only, no writes
 *   ONLY_APPS     comma-separated application names this run may touch. Unset
 *                 seeds the whole list. Set-but-empty, or naming an application
 *                 that is not in SEED_APPS, ABORTS before any write — see
 *                 `src/scripts/seedApplicationSelection.ts`.
 */

import crypto from 'crypto';
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { applicationCredentials } from '../src/db/schema/applicationCredentials';
import { applications } from '../src/db/schema/applications';
import { users } from '../src/db/schema/users';
import { selectSeedApplications } from '../src/scripts/seedApplicationSelection';
import {
  applySeedApplicationPlan,
  computeSeedApplicationPlan,
  readSeedApplicationState,
} from '../src/scripts/seedOxyApplicationsPlan';
import type { ApplicationCapability } from '../src/utils/applicationCapabilities';
import { IDENTITY_APPROVAL_CAPABILITY } from '../src/utils/applicationCapabilities';
import {
  type ApplicationScope,
} from '../src/utils/applicationScopes';
import { logger } from '../src/utils/logger';

// ── Mirror routes/applications.ts credential generation EXACTLY ──────────────
const CREDENTIAL_PUBLIC_KEY_PREFIX = 'oxy_dk_';
const PUBLIC_KEY_RANDOM_BYTES = 24;

function generatePublicKey(): string {
  return CREDENTIAL_PUBLIC_KEY_PREFIX + crypto.randomBytes(PUBLIC_KEY_RANDOM_BYTES).toString('hex');
}

type AppType = 'first_party' | 'internal';

interface SeedAppSpec {
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
  type: AppType;
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
}

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
const SEED_APPS: SeedAppSpec[] = [
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
    name: 'Oxy Inbox',
    description: 'Official Oxy email/inbox app.',
    websiteUrl: 'https://inbox.oxy.so',
    type: 'first_party',
    redirectUris: ['https://inbox.oxy.so'],
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
    scopes: ['user:read', 'files:read', 'files:write', 'federation:write', 'signals:write'],
  },
  {
    name: 'Homiio',
    description: 'Official Oxy real estate platform.',
    websiteUrl: 'https://homiio.com',
    type: 'first_party',
    redirectUris: ['https://homiio.com'],
    // Homiio awards Oxy Trust on lease lifecycle events via its service credential.
    // `reputation:write` is staff-gated — the seed script grants it to official apps.
    scopes: ['user:read', 'reputation:write'],
  },
  {
    name: 'Allo',
    description: 'Official Oxy encrypted messaging app.',
    websiteUrl: 'https://allo.you',
    type: 'first_party',
    redirectUris: ['https://allo.you', 'https://allo.oxy.so'],
  },
  {
    name: 'Alia',
    description: 'Official Oxy AI platform (chat app, console, canvas, gateway).',
    websiteUrl: 'https://alia.onl',
    type: 'first_party',
    redirectUris: ['https://alia.onl'],
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
    websiteUrl: 'https://apps.oxy.so',
    type: 'first_party',
    // The storefront is readable signed out, so this client exists for exactly
    // one thing: signing somebody in to write a review. Only the app's own
    // origin is listed; there is no second surface.
    redirectUris: ['https://apps.oxy.so'],
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

type ApplicationRow = typeof applications.$inferSelect;

interface MappingRow {
  app: string;
  type: AppType;
  applicationId: string;
  clientId: string;
  redirectUris: string[];
  websiteUrl?: string;
  createdApplication: boolean;
  createdCredential: boolean;
}

const DRY_RUN_PLACEHOLDER_ID = '000000000000000000000000';

async function findUserByUsername(username: string): Promise<{ id: string } | null> {
  const [owner] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
    .limit(1);
  return owner ?? null;
}


async function retireLegacyApplication(
  application: ApplicationRow,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    return 0;
  }

  await getDb()
    .update(applications)
    .set({ status: 'suspended', redirectUris: [] })
    .where(eq(applications.id, application.id));

  const revoked = await getDb()
    .update(applicationCredentials)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(applicationCredentials.applicationId, application.id),
        ne(applicationCredentials.status, 'revoked'),
      ),
    )
    .returning({ id: applicationCredentials.id });

  return revoked.length;
}

async function seed(seedApps: readonly SeedAppSpec[]): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const ownerUsername = process.env.OXY_USERNAME || 'oxy';

  if (dryRun) {
    logger.info('DRY RUN — no writes will be performed');
  }

  logger.info('Seeding applications', {
    selected: seedApps.map((spec) => spec.name),
    of: SEED_APPS.length,
    filtered: seedApps.length !== SEED_APPS.length,
  });

  const owner = await findUserByUsername(ownerUsername);
  if (!owner) {
    throw new Error(
      `Owner user "${ownerUsername}" not found — refusing to seed. ` +
        `Set OXY_USERNAME to the correct platform owner username.`,
    );
  }
  const oxyId = owner.id;
  logger.info('Resolved owner user', { username: ownerUsername, oxyId });

  // Official apps are owned by the ROOT `oxy` account itself. This used to mint a
  // child `oxy-org` organization under it, which put every official app on an
  // account the operator never sees when signed in as `oxy` — so the apps looked
  // missing in the Console and got re-registered by hand as self-service
  // `third_party` duplicates. One account, one place to find them.
  const oxyOrgId = oxyId;
  logger.info('Oxy owner account', { username: ownerUsername, ownerAccountId: oxyOrgId });

  const mapping: MappingRow[] = [];

  let appsCreated = 0;
  let appsUpdated = 0;
  let legacyAppsRetired = 0;
  let credentialsCreated = 0;
  let legacyCredentialsRevoked = 0;
  let credentialsReused = 0;

  for (const spec of seedApps) {
    let createdApplication = false;
    let createdCredential = false;

    let application =
      (
        await getDb()
          .select()
          .from(applications)
          .where(
            and(eq(applications.name, spec.name), eq(applications.createdByUserId, oxyId)),
          )
          .limit(1)
      )[0] ?? null;

    const legacyApplications =
      spec.legacyNames && spec.legacyNames.length > 0
        ? await getDb()
            .select()
            .from(applications)
            .where(
              and(
                inArray(applications.name, spec.legacyNames),
                eq(applications.createdByUserId, oxyId),
              ),
            )
        : [];

    if (!application && legacyApplications.length > 0) {
      application = legacyApplications[0];
      if (!dryRun) {
        await getDb()
          .update(applications)
          .set({ name: spec.name })
          .where(eq(applications.id, application.id));
        application = { ...application, name: spec.name };
      }
    }

    const desiredScopes = spec.scopes ?? (['user:read'] as ApplicationScope[]);
    const desiredCapabilities = spec.capabilities ?? [];
    const plan = computeSeedApplicationPlan(
      application ? readSeedApplicationState(application) : null,
      {
        description: spec.description,
        websiteUrl: spec.websiteUrl,
        type: spec.type,
        ownerAccountId: oxyOrgId,
        redirectUris: spec.redirectUris,
        scopes: desiredScopes,
        capabilities: desiredCapabilities,
      },
    );

    if (plan.creates) {
      createdApplication = true;
      appsCreated += 1;
      if (!dryRun) {
        const [created] = await getDb()
          .insert(applications)
          .values({
            name: spec.name,
            createdByUserId: oxyId,
            ...plan.desired,
          })
          .returning();
        application = created;
      }
    } else if (plan.changes.length > 0) {
      appsUpdated += 1;
      if (!dryRun && application) {
        const mutable = { ...readSeedApplicationState(application) };
        applySeedApplicationPlan(mutable, plan);
        const [updated] = await getDb()
          .update(applications)
          .set(mutable)
          .where(eq(applications.id, application.id))
          .returning();
        application = updated;
      }
    }

    for (const legacyApplication of legacyApplications) {
      if (application && legacyApplication.id === application.id) {
        continue;
      }

      legacyCredentialsRevoked += await retireLegacyApplication(legacyApplication, dryRun);
      legacyAppsRetired += 1;
    }

    const applicationId = application?.id ?? DRY_RUN_PLACEHOLDER_ID;

    let credential: typeof applicationCredentials.$inferSelect | null = null;
    if (application && application.id !== DRY_RUN_PLACEHOLDER_ID) {
      credential =
        (
          await getDb()
            .select()
            .from(applicationCredentials)
            .where(
              and(
                eq(applicationCredentials.applicationId, application.id),
                eq(applicationCredentials.type, 'public'),
                eq(applicationCredentials.environment, 'production'),
                eq(applicationCredentials.status, 'active'),
              ),
            )
            .limit(1)
        )[0] ?? null;
    }

    if (!credential) {
      createdCredential = true;
      if (!dryRun && application) {
        const [created] = await getDb()
          .insert(applicationCredentials)
          .values({
            applicationId: application.id,
            name: 'Production',
            publicKey: generatePublicKey(),
            secretHash: null,
            type: 'public',
            environment: 'production',
            scopes: ['user:read'],
            status: 'active',
            createdByUserId: oxyId,
          })
          .returning();
        credential = created;
        credentialsCreated += 1;
      }
    } else {
      credentialsReused += 1;
    }

    mapping.push({
      app: spec.name,
      type: spec.type,
      applicationId,
      clientId: credential?.publicKey ?? (dryRun ? '(dry-run-not-minted)' : 'ERROR'),
      redirectUris: spec.redirectUris,
      websiteUrl: spec.websiteUrl,
      createdApplication,
      createdCredential,
    });
  }

  logger.info('Seed summary', {
    dryRun,
    apps: seedApps.length,
    appsCreated,
    appsUpdated,
    credentialsCreated,
    legacyAppsRetired,
    legacyCredentialsRevoked,
    credentialsReused,
  });

  const [{ value: ownedAppCount }] = await getDb()
    .select({ value: count() })
    .from(applications)
    .where(eq(applications.createdByUserId, oxyId));
  logger.info('Read-back: applications owned by oxy', { count: ownedAppCount });

  // eslint-disable-next-line no-console
  console.log('OXY_APP_MAPPING_JSON=' + JSON.stringify(mapping));
}

async function main(): Promise<void> {
  const seedApps = selectSeedApplications(SEED_APPS, process.env.ONLY_APPS);

  await connectPostgres();
  logger.info('Connected to Postgres');

  try {
    await seed(seedApps);
  } finally {
    await closePostgres();
    logger.info('Postgres connection closed');
  }
}

main().catch((error) => {
  logger.error(
    'Seed failed',
    error instanceof Error ? error : new Error(String(error)),
    { component: 'seed-oxy-applications', method: 'main' },
  );
  process.exit(1);
});
