/**
 * `computeCostCenterPlan` decides whether a seed run MINTS A REAL ACCOUNT, so
 * every branch here is a write to production that cannot be undone by re-running
 * the script — `internal_cost_centers` has no delete, and an account is never
 * removed from the graph either.
 *
 * Two failure shapes are pinned hardest:
 *
 *  - The QUIET workaround. `AccountService.resolveUniqueUsername` allocates
 *    `codea1` when `codea` is taken, and nothing downstream would complain: the
 *    slug stays unique, the report still balances, and only a human later
 *    looking the account up by handle finds somebody else's. Every collision
 *    below must REFUSE, not adapt.
 *  - The under-reporting dry run. `registerCostCenter` revives a retired centre
 *    on conflict, so a re-run can undo a deliberate retirement. The plan has to
 *    say so BEFORE the write, or the operator's only warning arrives after it.
 *
 * The spec-list assertions at the bottom are not tidiness: `internal_cost_centers`
 * carries CHECK constraints on the slug's grammar and the label's length, and
 * the slug IS the account's username. A spec that violates any of them fails
 * inside the ECS one-shot, against production, with the account for earlier
 * entries in the run already minted.
 */

import { isValidUsername } from '@oxyhq/contracts';
import { isValidDisplayName } from '@oxyhq/core';
import { MAX_ACCOUNT_DEPTH } from '../../db/schema/userAncestors';
import {
  ABSENT,
  computeCostCenterPlan,
  INTERNAL_COST_CENTERS,
  PENDING_ACCOUNT,
  type CostCenterObservation,
  type InternalCostCenterSpec,
} from '../internalCostCenterSpecs';

const OWNER = 'platform-owner-account';

const SPEC: InternalCostCenterSpec = {
  name: 'codea',
  label: 'Codea',
  displayName: 'Codea',
  description: 'Codea — Alia’s coding workload.',
};

const EMPTY: CostCenterObservation = { costCenter: null, usernameHolder: null };

function holder(overrides: Partial<NonNullable<CostCenterObservation['usernameHolder']>> = {}) {
  return {
    costCenter: null,
    usernameHolder: {
      id: 'existing-account',
      kind: 'project',
      parentAccountId: OWNER,
      accountStatus: 'active',
      ...overrides,
    },
  } satisfies CostCenterObservation;
}

describe('computeCostCenterPlan', () => {
  describe('a centre that is already registered', () => {
    const registered = (
      overrides: Partial<NonNullable<CostCenterObservation['costCenter']>> = {}
    ): CostCenterObservation => ({
      costCenter: { accountId: 'labelled-account', label: 'Codea', status: 'active', ...overrides },
      usernameHolder: null,
    });

    it('reuses its account and writes nothing when it already matches', () => {
      const plan = computeCostCenterPlan(SPEC, registered(), OWNER);
      expect(plan.action).toEqual({ kind: 'registered', accountId: 'labelled-account' });
      expect(plan.changes).toEqual([]);
    });

    it('reports a label change rather than silently rewriting it', () => {
      const plan = computeCostCenterPlan(SPEC, registered({ label: 'Codea (old)' }), OWNER);
      expect(plan.changes).toEqual([{ field: 'label', from: 'Codea (old)', to: 'Codea' }]);
    });

    it('reports that a RETIRED centre would be revived — the surprise write', () => {
      // `registerCostCenter` sets status back to `active` on conflict. An
      // operator who retired this centre on purpose has to see that coming.
      const plan = computeCostCenterPlan(SPEC, registered({ status: 'retired' }), OWNER);
      expect(plan.changes).toContainEqual({ field: 'status', from: 'retired', to: 'active' });
    });

    it('never mints an account for a centre that already has one', () => {
      for (const status of ['active', 'retired'] as const) {
        expect(computeCostCenterPlan(SPEC, registered({ status }), OWNER).action.kind).toBe(
          'registered'
        );
      }
    });
  });

  describe('a centre with no account yet', () => {
    it('mints one', () => {
      const plan = computeCostCenterPlan(SPEC, EMPTY, OWNER);
      expect(plan.action).toEqual({ kind: 'create' });
    });

    it('reports the account as pending rather than inventing an id', () => {
      // A dry run cannot know the id the real run will allocate. Reporting a
      // made-up one would be a second lie on top of a plan an operator acts on.
      const plan = computeCostCenterPlan(SPEC, EMPTY, OWNER);
      expect(plan.changes).toContainEqual({
        field: 'account',
        from: ABSENT,
        to: PENDING_ACCOUNT,
      });
    });

    it('reports the label and the active status it would write', () => {
      const plan = computeCostCenterPlan(SPEC, EMPTY, OWNER);
      expect(plan.changes).toContainEqual({ field: 'label', from: ABSENT, to: 'Codea' });
      expect(plan.changes).toContainEqual({ field: 'status', from: ABSENT, to: 'active' });
    });
  });

  describe('a project account under the platform owner already holds the handle', () => {
    it('adopts it instead of minting a second one', () => {
      const plan = computeCostCenterPlan(SPEC, holder(), OWNER);
      expect(plan.action).toEqual({ kind: 'adopt', accountId: 'existing-account' });
    });

    it('reports the account it would adopt, by id', () => {
      const plan = computeCostCenterPlan(SPEC, holder(), OWNER);
      expect(plan.changes).toContainEqual({
        field: 'account',
        from: ABSENT,
        to: 'existing-account',
      });
    });
  });

  describe('refuses every other holder of the handle', () => {
    it('refuses a personal account', () => {
      const plan = computeCostCenterPlan(SPEC, holder({ kind: 'personal' }), OWNER);
      expect(plan.action.kind).toBe('refuse');
      expect(plan.changes).toEqual([]);
    });

    it('refuses an organization account', () => {
      expect(computeCostCenterPlan(SPEC, holder({ kind: 'organization' }), OWNER).action.kind).toBe(
        'refuse'
      );
    });

    it('refuses a project account in somebody else’s subtree', () => {
      const plan = computeCostCenterPlan(SPEC, holder({ parentAccountId: 'other-org' }), OWNER);
      expect(plan.action.kind).toBe('refuse');
    });

    it('refuses a project account with no parent at all', () => {
      const plan = computeCostCenterPlan(SPEC, holder({ parentAccountId: null }), OWNER);
      expect(plan.action.kind).toBe('refuse');
    });

    it('refuses an archived project account', () => {
      const plan = computeCostCenterPlan(SPEC, holder({ accountStatus: 'archived' }), OWNER);
      expect(plan.action.kind).toBe('refuse');
    });

    it('never falls back to minting a suffixed handle', () => {
      // The whole point: `resolveUniqueUsername` would happily produce `codea1`,
      // and the slug would still be unique. A refusal costs one rename by
      // somebody who can see both accounts; a silent suffix costs the next
      // person a day.
      for (const observation of [
        holder({ kind: 'personal' }),
        holder({ parentAccountId: 'other-org' }),
        holder({ accountStatus: 'archived' }),
      ]) {
        expect(computeCostCenterPlan(SPEC, observation, OWNER).action.kind).not.toBe('create');
      }
    });

    it('names the slug in the refusal, so the operator knows which one to rename', () => {
      const plan = computeCostCenterPlan(SPEC, holder({ kind: 'personal' }), OWNER);
      if (plan.action.kind !== 'refuse') throw new Error('expected a refusal');
      expect(plan.action.reason).toContain('codea');
    });

    it('the fixture is otherwise acceptable — the positive control', () => {
      // Every refusal above changes ONE field of a holder that is otherwise
      // adoptable. Without this, they would all pass against a predicate that
      // refused unconditionally.
      expect(computeCostCenterPlan(SPEC, holder(), OWNER).action.kind).toBe('adopt');
    });
  });

  describe('the registered cost centres', () => {
    it('covers the five workloads #972 workstream 14 names', () => {
      expect(INTERNAL_COST_CENTERS.map((center) => center.name)).toEqual([
        'alia-production-chat',
        'codea',
        'alia-research',
        'alia-voice',
        'alia-evaluations',
      ]);
    });

    it('slugs are unique — a slug is how a historical report addresses a centre', () => {
      const slugs = INTERNAL_COST_CENTERS.map((center) => center.name);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it.each(INTERNAL_COST_CENTERS)(
      '$name satisfies the internal_cost_centers slug CHECK',
      (center) => {
        // `internal_cost_centers_slug_check`, byte for byte. A slug that fails it
        // fails INSIDE the ECS one-shot, after earlier entries in the run have
        // already minted accounts.
        expect(center.name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
      }
    );

    it.each(INTERNAL_COST_CENTERS)('$name is a usable account username', (center) => {
      // The ONE policy, asked directly rather than restated. The slug IS the
      // username, so a slug the account layer rejects is a centre that can never
      // be created — and the slug CHECK is LOOSER on length (63 vs 30), so this
      // is the assertion that catches an over-long slug, in CI, instead of
      // halfway through a production run.
      expect(isValidUsername(center.name)).toBe(true);
      expect(center.name).toBe(center.name.toLowerCase());
    });

    it.each(INTERNAL_COST_CENTERS)('$name satisfies the label length CHECK', (center) => {
      expect(center.label.length).toBeGreaterThanOrEqual(1);
      expect(center.label.length).toBeLessThanOrEqual(120);
    });

    it.each(INTERNAL_COST_CENTERS)('$name has a display name and a description', (center) => {
      expect(center.displayName.trim().length).toBeGreaterThan(0);
      expect(center.description.trim().length).toBeGreaterThan(0);
    });

    it.each(INTERNAL_COST_CENTERS)(
      '$name has a display name the account-name policy accepts',
      (center) => {
        // The REAL validator `assertValidAccountName` runs on
        // `createChildAccount`, not a copy of its regex: a re-implementation here
        // would stay green while the shipped policy tightened underneath it, and
        // the mint would 400 in production against a passing test.
        expect(isValidDisplayName(center.displayName)).toBe(true);
      }
    );

    it('that validator rejects something — the positive control', () => {
      // A display name is only checked when it is a string the policy could
      // fail. If `isValidDisplayName` ever degraded to a constant `true`, every
      // assertion above would pass while validating nothing.
      expect(isValidDisplayName('Codea 2')).toBe(false);
    });

    it('every centre is a direct child of the platform owner — one level, no nesting', () => {
      // Flat by design: a centre that is an ANCESTOR of another absorbs the spend
      // of anything owned directly by it, because the nearest-ancestor walk
      // cannot tell "owned by the parent" from "owned by a child with no centre".
      // The seed only ever creates children of the platform owner, so this is a
      // property of the plan rather than of the list — asserted through the plan
      // to keep it that way.
      for (const center of INTERNAL_COST_CENTERS) {
        const plan = computeCostCenterPlan(center, EMPTY, OWNER);
        expect(plan.action.kind).toBe('create');
      }
      // One level under the owner is nowhere near the ceiling; this exists so a
      // future nesting decision has to confront the limit rather than discover it.
      expect(MAX_ACCOUNT_DEPTH).toBeGreaterThan(1);
    });
  });
});
