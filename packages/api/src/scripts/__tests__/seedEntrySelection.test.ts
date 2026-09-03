/**
 * THE INVARIANT of a bounded seed run: it touches exactly the entries named, or
 * it refuses to run at all. It never silently reconciles nothing, and it never
 * silently reconciles everything.
 *
 * Why this suite exists: `scripts/seed-oxy-applications.ts` reconciles EVERY
 * official application on every run, and some of what it reconciles is an
 * authoritative replacement. Registering one new application therefore carried
 * the blast radius of all the others, and the script's `DRY_RUN` cannot warn
 * about it (its whole reconcile block lives inside `if (!dryRun)`, so a dry run
 * reports `appsUpdated: 0` for every existing app no matter what the real run
 * would change — the same bug `registerCommonsClientsPlan.test.ts` pins for the
 * sibling script). `ONLY_APPS` removes the blast radius instead of improving the
 * warning about it, so the guard rails on it are the safety property.
 * `scripts/seed-internal-cost-centers.ts` inherits both the mechanism and these
 * guard rails, and its entries are ACCOUNTS a run may mint.
 *
 * The failure this pins hardest is the QUIET one: every rejection below could
 * instead have been "select nothing and report success", which is the exact
 * shape of a decorative safety net.
 */

import {
  selectSeedEntries,
  selectSeedEntriesByExactIds,
  selectSeedEntriesByLegacyNames,
  type IdentifiedSeedEntry,
  type SeedEntryVocabulary,
} from '../seedEntrySelection';

/** Stands in for the real SEED_APPS: only `name` is load-bearing here. */
const ENTRIES = [
  { name: 'Oxy Accounts', type: 'first_party' },
  { name: 'Commons by Oxy', type: 'first_party' },
  { name: 'CrowdSource', type: 'first_party' },
] as const;

const APPS: SeedEntryVocabulary = {
  envVar: 'ONLY_APPS',
  singular: 'application',
  plural: 'applications',
};

const KAANA_APPLICATION_ID = '68b7c4e19f2a6d0e3c8b5174';
const IDENTIFIED_ENTRIES: readonly (IdentifiedSeedEntry & {
  type: 'first_party' | 'internal';
})[] = [
  { id: '6a2f851751b784a86fd0e934', name: 'Alia', type: 'internal' },
  { name: 'Oxy Accounts', type: 'first_party' },
  { id: KAANA_APPLICATION_ID, name: 'Kaana', type: 'internal' },
] as const;

describe('selectSeedEntries', () => {
  describe('unset — the long-standing behaviour is unchanged', () => {
    it('returns the whole canonical list', () => {
      expect(selectSeedEntries(ENTRIES, undefined, APPS)).toEqual([...ENTRIES]);
    });

    it('returns a copy, so a caller cannot mutate the canonical list', () => {
      const selected = selectSeedEntries(ENTRIES, undefined, APPS);
      expect(selected).not.toBe(ENTRIES);
    });
  });

  describe('bounding a run', () => {
    it('selects exactly the one application named', () => {
      expect(selectSeedEntries(ENTRIES, 'CrowdSource', APPS)).toEqual([
        { name: 'CrowdSource', type: 'first_party' },
      ]);
    });

    it('does NOT select the applications it was not given — the whole point', () => {
      const selected = selectSeedEntries(ENTRIES, 'CrowdSource', APPS).map((e) => e.name);
      expect(selected).not.toContain('Commons by Oxy');
      expect(selected).not.toContain('Oxy Accounts');
    });

    it('selects several, and tolerates whitespace around the separators', () => {
      expect(
        selectSeedEntries(ENTRIES, ' CrowdSource , Oxy Accounts ', APPS).map((e) => e.name)
      ).toEqual(['Oxy Accounts', 'CrowdSource']);
    });

    it('returns canonical order, never the order the operator typed', () => {
      expect(
        selectSeedEntries(ENTRIES, 'CrowdSource,Oxy Accounts', APPS).map((e) => e.name)
      ).toEqual(['Oxy Accounts', 'CrowdSource']);
    });

    it('de-duplicates a repeated name instead of seeding it twice', () => {
      expect(
        selectSeedEntries(ENTRIES, 'CrowdSource,CrowdSource', APPS).map((e) => e.name)
      ).toEqual(['CrowdSource']);
    });

    it('preserves an internal space in a name (the separator is a comma)', () => {
      expect(selectSeedEntries(ENTRIES, 'Commons by Oxy', APPS).map((e) => e.name)).toEqual([
        'Commons by Oxy',
      ]);
    });
  });

  describe('fails closed — a rejection is never a silent no-op', () => {
    it('throws when set but empty, rather than seeding everything', () => {
      expect(() => selectSeedEntries(ENTRIES, '', APPS)).toThrow(/names no application/);
    });

    it('throws on whitespace only', () => {
      expect(() => selectSeedEntries(ENTRIES, '   ', APPS)).toThrow(/names no application/);
    });

    it('throws on separators only', () => {
      expect(() => selectSeedEntries(ENTRIES, ' , , ', APPS)).toThrow(/names no application/);
    });

    it('throws on an unknown name instead of selecting nothing', () => {
      expect(() => selectSeedEntries(ENTRIES, 'Crowdsource', APPS)).toThrow(
        /unknown application\(s\): \[Crowdsource\]/
      );
    });

    it('names the valid options, so a typo is self-correcting', () => {
      expect(() => selectSeedEntries(ENTRIES, 'Nope', APPS)).toThrow(/CrowdSource/);
    });

    it('rejects the WHOLE run when one of several names is unknown', () => {
      // Partial success is the dangerous outcome: the operator reads "done" and
      // the application they cared about was never touched.
      expect(() => selectSeedEntries(ENTRIES, 'CrowdSource,Nope', APPS)).toThrow(
        /unknown application\(s\): \[Nope\]/
      );
    });

    it('is case-sensitive, because `name` is the idempotency key', () => {
      // A near-miss identifies a DIFFERENT application (or none): matching it
      // loosely would reconcile the wrong record under the right-looking name.
      expect(() => selectSeedEntries(ENTRIES, 'crowdsource', APPS)).toThrow(/unknown/);
    });

    it('does not substring-match a longer name', () => {
      expect(() => selectSeedEntries(ENTRIES, 'Crowd', APPS)).toThrow(/unknown/);
    });
  });

  describe('the refusal names the caller’s own vocabulary', () => {
    // A message that says "application" while an operator is seeding cost
    // centres sends them to the wrong script, and a message naming the wrong
    // env var sends them to the wrong variable. Both are how a fail-closed
    // guard becomes a fail-confused one.
    const CENTERS: SeedEntryVocabulary = {
      envVar: 'ONLY_COST_CENTERS',
      singular: 'cost centre',
      plural: 'cost centres',
    };

    it('names the caller’s env var and noun when nothing was selected', () => {
      expect(() => selectSeedEntries(ENTRIES, '', CENTERS)).toThrow(
        /ONLY_COST_CENTERS was set but names no cost centre/
      );
    });

    it('names the caller’s env var and plural noun on an unknown entry', () => {
      expect(() => selectSeedEntries(ENTRIES, 'Nope', CENTERS)).toThrow(
        /ONLY_COST_CENTERS names unknown cost centre\(s\): \[Nope\]\. Known cost centres:/
      );
    });

    it('does not leak the other caller’s vocabulary into this one', () => {
      expect(() => selectSeedEntries(ENTRIES, 'Nope', CENTERS)).not.toThrow(/ONLY_APPS/);
      expect(() => selectSeedEntries(ENTRIES, 'Nope', APPS)).not.toThrow(/ONLY_COST_CENTERS/);
    });
  });

  describe('vacuity floor', () => {
    it('the fixture actually distinguishes selected from unselected', () => {
      // If ENTRIES ever collapsed to one entry, every "does not select" test
      // above would pass for the wrong reason.
      expect(ENTRIES.length).toBeGreaterThan(1);
      expect(selectSeedEntries(ENTRIES, 'CrowdSource', APPS).length).toBeLessThan(ENTRIES.length);
    });
  });
});

describe('selectSeedEntriesByExactIds', () => {
  it('selects Kaana by its exact opaque id and nothing else', () => {
    expect(selectSeedEntriesByExactIds(IDENTIFIED_ENTRIES, KAANA_APPLICATION_ID, APPS)).toEqual([
      { id: KAANA_APPLICATION_ID, name: 'Kaana', type: 'internal' },
    ]);
  });

  it('does not depend on the canonical registry order', () => {
    const reordered = [...IDENTIFIED_ENTRIES].reverse();

    expect(selectSeedEntriesByExactIds(reordered, KAANA_APPLICATION_ID, APPS)).toEqual([
      { id: KAANA_APPLICATION_ID, name: 'Kaana', type: 'internal' },
    ]);
  });

  it('uses each requested exact id instead of canonical or request order as a fallback', () => {
    const selected = selectSeedEntriesByExactIds(
      IDENTIFIED_ENTRIES,
      `${KAANA_APPLICATION_ID},6a2f851751b784a86fd0e934`,
      APPS
    );

    expect(selected.map((entry) => entry.id)).toEqual([
      KAANA_APPLICATION_ID,
      '6a2f851751b784a86fd0e934',
    ]);
  });

  it('rejects the Kaana display name on the exact-id path', () => {
    expect(() => selectSeedEntriesByExactIds(IDENTIFIED_ENTRIES, 'Kaana', APPS)).toThrow(
      /unknown application id\(s\): \[Kaana\]/
    );
  });

  it('rejects an unknown opaque id instead of selecting the first entry', () => {
    expect(() =>
      selectSeedEntriesByExactIds(IDENTIFIED_ENTRIES, '000000000000000000000001', APPS)
    ).toThrow(/unknown application id\(s\): \[000000000000000000000001\]/);
  });

  it('rejects an empty exact-id boundary', () => {
    expect(() => selectSeedEntriesByExactIds(IDENTIFIED_ENTRIES, '', APPS)).toThrow(
      /names no application id/
    );
  });

  it.each([
    `${KAANA_APPLICATION_ID},`,
    `,${KAANA_APPLICATION_ID}`,
    `${KAANA_APPLICATION_ID},,6a2f851751b784a86fd0e934`,
  ])('rejects an empty id inside a comma-separated boundary: %p', (raw) => {
    expect(() => selectSeedEntriesByExactIds(IDENTIFIED_ENTRIES, raw, APPS)).toThrow(
      /contains an empty application id/
    );
  });

  it.each([
    ` ${KAANA_APPLICATION_ID}`,
    `${KAANA_APPLICATION_ID} `,
    `${KAANA_APPLICATION_ID}, 6a2f851751b784a86fd0e934`,
    `\t${KAANA_APPLICATION_ID}`,
    `${KAANA_APPLICATION_ID}\n`,
    '   ',
  ])('rejects leading or trailing whitespace instead of normalizing the id: %p', (raw) => {
    expect(() => selectSeedEntriesByExactIds(IDENTIFIED_ENTRIES, raw, APPS)).toThrow(
      /Every id must byte-match the declared immutable id; values are never normalized/
    );
  });

  it('rejects a duplicate requested id instead of silently de-duplicating it', () => {
    expect(() =>
      selectSeedEntriesByExactIds(
        IDENTIFIED_ENTRIES,
        `${KAANA_APPLICATION_ID},${KAANA_APPLICATION_ID}`,
        APPS
      )
    ).toThrow(new RegExp(`repeats application id\\(s\\): \\[${KAANA_APPLICATION_ID}\\]`));
  });

  it('rejects duplicate ids in the canonical registry instead of selecting by first match', () => {
    expect(() =>
      selectSeedEntriesByExactIds(
        [
          ...IDENTIFIED_ENTRIES,
          { id: KAANA_APPLICATION_ID, name: 'Not Kaana', type: 'internal' },
        ],
        KAANA_APPLICATION_ID,
        APPS
      )
    ).toThrow(`Canonical application registry declares duplicate exact id ${KAANA_APPLICATION_ID}`);
  });

  it('cannot reach a spec without an id through its display name', () => {
    expect(() => selectSeedEntriesByExactIds(IDENTIFIED_ENTRIES, 'Oxy Accounts', APPS)).toThrow(
      /unknown application id\(s\): \[Oxy Accounts\]/
    );
  });

  it('the fixture has unselected and id-less entries, so the negative assertions can fail', () => {
    expect(IDENTIFIED_ENTRIES.length).toBeGreaterThan(1);
    expect(IDENTIFIED_ENTRIES.some((entry) => !('id' in entry))).toBe(true);
  });
});

describe('selectSeedEntriesByLegacyNames', () => {
  it('retains explicit name selection for a spec without a declared id', () => {
    expect(
      selectSeedEntriesByLegacyNames(IDENTIFIED_ENTRIES, 'Oxy Accounts', APPS, 'ONLY_APP_IDS')
    ).toEqual([{ name: 'Oxy Accounts', type: 'first_party' }]);
  });

  it('rejects selecting Kaana by display name because it has an exact id', () => {
    expect(() =>
      selectSeedEntriesByLegacyNames(IDENTIFIED_ENTRIES, 'Kaana', APPS, 'ONLY_APP_IDS')
    ).toThrow(/cannot select application\(s\) with declared exact ids: \[Kaana\]/);
  });

  it('still rejects an unknown display name before considering exact ids', () => {
    expect(() =>
      selectSeedEntriesByLegacyNames(IDENTIFIED_ENTRIES, 'kaana', APPS, 'ONLY_APP_IDS')
    ).toThrow(/unknown application\(s\): \[kaana\]/);
  });

  it('preserves the unbounded local reconciliation when neither filter is set', () => {
    expect(
      selectSeedEntriesByLegacyNames(IDENTIFIED_ENTRIES, undefined, APPS, 'ONLY_APP_IDS')
    ).toEqual([...IDENTIFIED_ENTRIES]);
  });
});
