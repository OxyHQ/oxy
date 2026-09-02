/**
 * The decisions in `seedOxyApplicationsSpecs.ts` are AUTHORITY, not configuration
 * — this suite is what stops them being a comment.
 *
 * Two of them are load-bearing for issue #972 workstream 14 and neither fails
 * loudly if it regresses:
 *
 *  - Alia's application `type` decides whether it can see the `internal_alia`
 *    catalogue audience at all. Registered as `first_party` it is a PUBLIC
 *    viewer, and the symptom is a model quietly not being offered — no error,
 *    no log line, nothing a smoke test distinguishes from an empty catalogue.
 *  - Alia's scope set decides what it may do to the platform. A scope added
 *    "while we're here" is authority nobody re-examines, and two of the family
 *    are staff-gated precisely because holding them lets one tenant repoint
 *    traffic that is not its own.
 *
 * So the assertions below run the real chain — spec → `computeSeedApplicationPlan`
 * → `resolveCatalogueViewer` — rather than restating the constants. A test that
 * only read `SEED_APPS.find(...).type === 'internal'` would pass just as happily
 * if `resolveCatalogueViewer` stopped reading `type` tomorrow.
 */

import {
  resolveCatalogueViewer,
  type CatalogueApplicationPrincipal,
} from '../../services/inferenceCatalogue.service';
import { catalogApplicationCapability } from '../../utils/applicationCapabilities';
import {
  APPLICATION_SCOPES,
  isPrivilegedScope,
  isValidApplicationScope,
  type ApplicationScope,
} from '../../utils/applicationScopes';
import { INTERNAL_COST_CENTERS } from '../internalCostCenterSpecs';
import { computeSeedApplicationPlan } from '../seedOxyApplicationsPlan';
import {
  ALIA_APPLICATION_SCOPES,
  ALIA_OWNER_ACCOUNT_USERNAME,
  SEED_APPS,
  type SeedAppSpec,
} from '../seedOxyApplicationsSpecs';

const PLATFORM_OWNER_ID = 'platform-owner-account';

function specNamed(name: string): SeedAppSpec {
  const spec = SEED_APPS.find((candidate) => candidate.name === name);
  if (spec === undefined) {
    throw new Error(`No seed spec named "${name}" — the fixture, not the code, is wrong.`);
  }
  return spec;
}

/**
 * The application row a fresh seed of `spec` would insert, projected onto the
 * two fields the catalogue audience reads.
 *
 * Goes through the REAL planner, so `isInternal` is derived exactly as the seed
 * derives it rather than restated here — the seed declares `type` and nothing
 * else, and a planner that stopped deriving the flag would fail this suite.
 */
function seededPrincipal(spec: SeedAppSpec): CatalogueApplicationPrincipal {
  const { desired } = computeSeedApplicationPlan(null, {
    description: spec.description,
    websiteUrl: spec.websiteUrl,
    type: spec.type,
    ownerAccountId: PLATFORM_OWNER_ID,
    redirectUris: spec.redirectUris,
    scopes: spec.scopes ?? (['user:read'] as ApplicationScope[]),
    capabilities: spec.capabilities ?? [],
  });
  return { type: desired.type, isInternal: desired.isInternal };
}

describe('the canonical official-application registry', () => {
  describe('Alia sees the internal catalogue audience', () => {
    it('is registered as an application the catalogue treats as internal', () => {
      const viewer = resolveCatalogueViewer(seededPrincipal(specNamed('Alia')));
      expect(viewer.scopes).toContain('internal_alia');
      expect(viewer.label).toBe('internal');
    });

    it('gets there through `type` alone — the seed declares no `isInternal`', () => {
      // `isInternal` is derived by the planner. If the spec started declaring it
      // by hand the two could disagree, which is the shape that makes a trust
      // flag true in one place and false in another.
      const spec = specNamed('Alia');
      expect(spec.type).toBe('internal');
      expect(seededPrincipal(spec).isInternal).toBe(true);
    });

    it('does NOT hand the internal audience to a first-party app — the negative control', () => {
      // Without this, "Alia sees internal_alia" would pass just as well if
      // `resolveCatalogueViewer` returned the internal viewer for everybody, and
      // the test above would be measuring nothing.
      const console = resolveCatalogueViewer(seededPrincipal(specNamed('Oxy Console')));
      expect(console.scopes).not.toContain('internal_alia');
      expect(console.label).toBe('public');
    });

    it('the fixture contains both an internal and a first-party app', () => {
      // Vacuity floor for the pair above: if every spec were one type, one of
      // the two assertions would be unreachable.
      const types = new Set(SEED_APPS.map((spec) => spec.type));
      expect(types.has('internal')).toBe(true);
      expect(types.has('first_party')).toBe(true);
    });
  });

  describe('Alia holds exactly the inference and delegation scopes it needs', () => {
    const WITHHELD: readonly string[] = [
      'inference:routing:write',
      'inference:providers:write',
      'inference:providers:read',
    ];

    /**
     * The two staff-gated scopes Alia is authorised to hold, and the ONLY two.
     *
     * Named as a constant because three assertions below need the same list and
     * they ask different questions of it — that both are granted, that no THIRD
     * privileged scope has joined them, and that neither name is a typo. A
     * misspelling would be absent from `PRIVILEGED_APPLICATION_SCOPES`, absent
     * from the grant, and would read exactly like a deliberate decision.
     */
    const DELEGATION_SCOPES: readonly string[] = ['acting-as:offline', 'accounts:act-as-session'];

    it('declares the argued set and nothing else', () => {
      expect(specNamed('Alia').scopes).toEqual([...ALIA_APPLICATION_SCOPES]);
    });

    it('carries the four inference scopes the integration is built on', () => {
      expect(ALIA_APPLICATION_SCOPES).toEqual(
        expect.arrayContaining([
          'inference:invoke',
          'inference:models:read',
          'inference:usage:read',
          'inference:routing:read',
        ])
      );
    });

    it('carries `inference:usage:read`, which the entitlement interface requires', () => {
      // `routes/accountBilling.ts` authorises a SERVICE principal on
      // `GET /billing/accounts/:accountId/entitlements` with exactly this scope.
      // Without it Alia's product plans cannot read the interface #972 §14 asks
      // Oxy to provide, and the failure is a 403 at runtime.
      expect(ALIA_APPLICATION_SCOPES).toContain('inference:usage:read');
    });

    it('carries both delegation scopes the service lane is built on', () => {
      // `acting-as:offline` is what `GET /internal/service-acting-as/verify`
      // reads before it will answer `authorized: true`, and
      // `accounts:act-as-session` is what `POST /internal/accounts/:id/service-switch`
      // requires before it will mint a session for a managed account. Without
      // either, the corresponding capability is UNREACHABLE rather than merely
      // unauthorized — which is a silent absence, not an error.
      expect(ALIA_APPLICATION_SCOPES).toEqual(expect.arrayContaining([...DELEGATION_SCOPES]));
    });

    it('holds exactly those two staff-gated scopes and no others', () => {
      // This REPLACES "holds no staff-gated scope of any family", which was a
      // real gate rather than a formality: the seed is the one path where a
      // staff-only scope reaches an application without a person reviewing a
      // request for it. What changed is the DECISION — Alia is now argued to
      // need two of them — not whether anything is enforced. So the replacement
      // has to bite in the same place, and it does in both directions: a THIRD
      // privileged scope added here lengthens the array and fails, and either
      // named one going missing shortens it and fails.
      const privileged = ALIA_APPLICATION_SCOPES.filter((scope) => isPrivilegedScope(scope));
      expect(privileged).toEqual([...DELEGATION_SCOPES]);
    });

    it('both delegation names are REAL privileged scopes, so pinning them means something', () => {
      // Vacuity floor for the two assertions above, in their own currency: if
      // `accounts:act-as-session` were misspelled it would be a non-scope, the
      // privileged filter would return only one entry, and the pin would fail —
      // but it would fail looking like a policy regression rather than a typo.
      for (const scope of DELEGATION_SCOPES) {
        expect(isValidApplicationScope(scope)).toBe(true);
        expect(isPrivilegedScope(scope)).toBe(true);
      }
    });

    it.each(WITHHELD)('withholds %s', (scope) => {
      expect(ALIA_APPLICATION_SCOPES).not.toContain(scope);
    });

    it('every withheld name is a REAL scope, so its absence means something', () => {
      // The vacuity floor for the block above: a misspelled scope is absent from
      // every list, forever, and reads exactly like a deliberate withholding.
      for (const scope of WITHHELD) {
        expect(isValidApplicationScope(scope)).toBe(true);
      }
    });

    /**
     * The one filter both assertions below run, so the negative claim and its
     * positive control cannot drift apart. A control that re-implements the
     * predicate it is controlling measures the re-implementation.
     */
    const outsidersOf = (scopes: readonly string[]): string[] =>
      scopes.filter(
        (scope) =>
          scope !== 'user:read' &&
          !scope.startsWith('inference:') &&
          !DELEGATION_SCOPES.includes(scope)
      );

    it('grants nothing outside inference, `user:read` and the two delegation scopes', () => {
      // This REPLACES "grants nothing outside the inference family except the
      // `user:read` baseline". The exemption list grew by exactly the two scopes
      // argued for above and by nothing else, which is the point: the sentence
      // this test enforces is still "and nothing else".
      expect(outsidersOf(ALIA_APPLICATION_SCOPES)).toEqual([]);
    });

    it('that scan can see an outsider at all', () => {
      // Positive control the original assertion never had. An empty result and a
      // filter that matches nothing are the same observation, and the exemption
      // list just got longer — which is precisely when a widened predicate stops
      // catching what it was written for.
      expect(outsidersOf([...ALIA_APPLICATION_SCOPES, 'federation:write'])).toEqual([
        'federation:write',
      ]);
    });
  });

  describe('no application self-grants an inference WRITE scope', () => {
    // Both are in `PRIVILEGED_APPLICATION_SCOPES` because they mutate objects
    // the platform serves every tenant from. This seed runs as staff and CAN
    // grant them, which is exactly why the list needs a gate: the seed is the
    // one path where a staff-only scope can be added without a person reviewing
    // a request for it.
    const INFERENCE_WRITE_SCOPES = ['inference:routing:write', 'inference:providers:write'];

    it.each(INFERENCE_WRITE_SCOPES)('no seeded application carries %s', (scope) => {
      const holders = SEED_APPS.filter((spec) => (spec.scopes ?? []).includes(scope as ApplicationScope));
      expect(holders.map((spec) => spec.name)).toEqual([]);
    });

    it('the scan can see a granted scope at all', () => {
      // Positive control in the same currency: the same filter, over a scope
      // that IS deliberately granted, finds its holder. Without this, a
      // `spec.scopes` field renamed tomorrow would leave every assertion above
      // green while measuring an empty array.
      const holders = SEED_APPS.filter((spec) =>
        (spec.scopes ?? []).includes('federation:write')
      );
      expect(holders.map((spec) => spec.name)).toEqual(['Mention']);
    });
  });

  describe('Noted owns only its catalog service authority', () => {
    const NOTED_SERVICE_SCOPES = [
      'user:read',
      'catalogs:write',
      'capabilities:read',
      'capability-audit:write',
      'capability-events:publish',
    ];

    it('declares the scopes used by catalog registration, introspection, audit and events', () => {
      expect(specNamed('Noted').scopes).toEqual(NOTED_SERVICE_SCOPES);
    });

    it('is bound to the Noted catalog namespace and no other platform capability', () => {
      expect(specNamed('Noted').capabilities).toEqual([
        catalogApplicationCapability('noted'),
      ]);
    });

    it('refuses malformed catalog namespace identifiers', () => {
      expect(() => catalogApplicationCapability('Noted')).toThrow('Catalog app id');
      expect(() => catalogApplicationCapability('')).toThrow('Catalog app id');
    });
  });

  describe('the dedicated owner account is one this platform actually seeds', () => {
    it('Alia is owned by its own account, not by the platform owner', () => {
      expect(specNamed('Alia').ownerAccountUsername).toBe(ALIA_OWNER_ACCOUNT_USERNAME);
    });

    it('that account is a registered cost centre — the two files cannot drift', () => {
      // `seed-oxy-applications.ts` REFUSES when the named account is missing, so
      // a slug renamed in `internalCostCenterSpecs.ts` and not here fails the
      // production run rather than the build. This moves that failure forward.
      const slugs = INTERNAL_COST_CENTERS.map((center) => center.name);
      expect(slugs).toContain(ALIA_OWNER_ACCOUNT_USERNAME);
    });

    it('no other seeded application claims a dedicated owner account', () => {
      // Not a style rule: two applications sharing an owner account are
      // indistinguishable in the cost-centre report, so every additional one
      // here is a reporting decision somebody has to make on purpose.
      const dedicated = SEED_APPS.filter((spec) => spec.ownerAccountUsername !== undefined);
      expect(dedicated.map((spec) => spec.name)).toEqual(['Alia']);
    });
  });

  describe('registry hygiene', () => {
    it('every declared scope is a recognised application scope', () => {
      const declared = SEED_APPS.flatMap((spec) => spec.scopes ?? []);
      const unknown = declared.filter((scope) => !isValidApplicationScope(scope));
      expect(unknown).toEqual([]);
      // Floor: the scan read something.
      expect(declared.length).toBeGreaterThan(0);
    });

    it('application names are unique — `name` is the idempotency key', () => {
      const names = SEED_APPS.map((spec) => spec.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('the scope vocabulary the specs are checked against is non-empty', () => {
      expect(APPLICATION_SCOPES.length).toBeGreaterThan(0);
    });
  });
});
