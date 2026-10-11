/**
 * Power levels: the `auto` heuristic (pure), the seeded presets, and how the
 * catalogue lists a level's candidates — only servable models of the level's
 * reviewed class, never a model because of its name.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { inferenceModelPowerClasses, inferenceRoutingProfiles } from '../../db/schema';
import {
  clearPowerClassesForTest,
  insertCatalogueRoute,
  setPowerClass,
} from '../../db/testServableEvidence';
import {
  CATALOGUED,
  listCatalogueForViewer,
  listRoutingProfiles,
  resolveCatalogueViewer,
} from '../inferenceCatalogue.service';
import {
  AUTO_THRESHOLDS,
  autoLadder,
  classifyAutoPowerLevel,
  type AutoRoutingFeatures,
  powerLevelEfforts,
  resolvePowerLevelEffort,
} from '../inferencePowerLevels.service';

const INTERNAL_VIEWER = resolveCatalogueViewer({ type: 'internal', isInternal: true });

const PLAIN: AutoRoutingFeatures = {
  toolCount: 0,
  estimatedInputTokens: 200,
  nonTextInput: false,
  structuredOutput: false,
};

describe('classifyAutoPowerLevel', () => {
  it('chooses instant for a short plain request', () => {
    expect(classifyAutoPowerLevel(PLAIN)).toEqual({ level: 'instant', reasons: [] });
  });

  it.each([
    [{ toolCount: 1 }, 'medium'],
    [{ toolCount: AUTO_THRESHOLDS.highToolCount }, 'medium'],
    [{ toolCount: AUTO_THRESHOLDS.highToolCount + 1 }, 'high'],
    [{ structuredOutput: true }, 'medium'],
    [{ nonTextInput: true }, 'medium'],
    [{ estimatedInputTokens: AUTO_THRESHOLDS.mediumInputTokens + 1 }, 'medium'],
    [{ estimatedInputTokens: AUTO_THRESHOLDS.highInputTokens + 1 }, 'high'],
    [{ maxOutputTokens: AUTO_THRESHOLDS.mediumOutputTokens }, 'instant'],
    [{ maxOutputTokens: AUTO_THRESHOLDS.mediumOutputTokens + 1 }, 'medium'],
    [{ maxOutputTokens: AUTO_THRESHOLDS.highOutputTokens + 1 }, 'high'],
    [{ requestedEffort: 'low' as const }, 'medium'],
    [{ requestedEffort: 'medium' as const }, 'high'],
    [{ requestedEffort: 'high' as const }, 'xhigh'],
  ])('%j raises the floor to %s', (overrides, level) => {
    expect(classifyAutoPowerLevel({ ...PLAIN, ...overrides }).level).toBe(level);
  });

  it('takes the highest floor any rule sets, and names every rule', () => {
    const decision = classifyAutoPowerLevel({
      ...PLAIN,
      toolCount: 2,
      requestedEffort: 'high',
      estimatedInputTokens: AUTO_THRESHOLDS.highInputTokens + 1,
    });
    expect(decision.level).toBe('xhigh');
    expect(decision.reasons).toEqual([
      'reasoning_effort_high->xhigh',
      'tools->medium',
      'large_input->high',
    ]);
  });

  it('never chooses pro or ultra', () => {
    const everything = classifyAutoPowerLevel({
      toolCount: 100,
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 100_000,
      nonTextInput: true,
      requestedEffort: 'high',
      structuredOutput: true,
    });
    expect(everything.level).toBe('xhigh');
  });
});

describe('autoLadder', () => {
  const all = () => true;
  it('climbs from the decided level to xhigh', () => {
    expect(autoLadder('instant', all)).toEqual(['instant', 'medium', 'high', 'xhigh']);
    expect(autoLadder('high', all)).toEqual(['high', 'xhigh']);
    expect(autoLadder('xhigh', all)).toEqual(['xhigh']);
  });

  it('keeps only levels the application allows, and may leave nothing', () => {
    expect(autoLadder('instant', (level) => level === 'instant' || level === 'high')).toEqual([
      'instant',
      'high',
    ]);
    expect(autoLadder('medium', (level) => level === 'instant')).toEqual([]);
  });
});

describe('resolvePowerLevelEffort', () => {
  const ALL = ['low', 'medium', 'high'];

  it('asks a reasoning model for the least it accepts when the level wants none', () => {
    // The 2026-09-30 defect: `instant` sent nothing to gpt-oss, which then
    // reasoned at its default and spent the whole output budget.
    expect(resolvePowerLevelEffort('none', ALL)).toBe('low');
    expect(resolvePowerLevelEffort('minimal', ALL)).toBe('low');
    expect(resolvePowerLevelEffort('none', ['high', 'medium'])).toBe('medium');
  });

  it('sends the target itself when accepted', () => {
    expect(resolvePowerLevelEffort('low', ALL)).toBe('low');
    expect(resolvePowerLevelEffort('medium', ALL)).toBe('medium');
    expect(resolvePowerLevelEffort('high', ALL)).toBe('high');
  });

  it('clamps up to the lowest accepted effort above the target', () => {
    expect(resolvePowerLevelEffort('low', ['medium', 'high'])).toBe('medium');
    expect(resolvePowerLevelEffort('medium', ['low', 'high'])).toBe('high');
  });

  it('falls back to the highest accepted effort when none reaches the target', () => {
    expect(resolvePowerLevelEffort('high', ['low', 'medium'])).toBe('medium');
    expect(resolvePowerLevelEffort('medium', ['low'])).toBe('low');
  });

  it('sends nothing to a model without effort control, and ignores words outside the contract', () => {
    expect(resolvePowerLevelEffort('none', [])).toBeUndefined();
    expect(resolvePowerLevelEffort('high', [])).toBeUndefined();
    expect(resolvePowerLevelEffort('none', ['none', 'xhigh'])).toBeUndefined();
    expect(resolvePowerLevelEffort('none', ['xhigh', 'medium'])).toBe('medium');
  });
});

describe('the seeded power-level presets', () => {
  beforeAll(async () => {
    await connectPostgres();
  });

  afterAll(async () => {
    await closePostgres();
  });

  it('exist with fixed ids, one per level, with the documented efforts', async () => {
    const rows = await getDb()
      .select({
        id: inferenceRoutingProfiles.id,
        slug: inferenceRoutingProfiles.slug,
        powerLevel: inferenceRoutingProfiles.powerLevel,
        reasoningEffort: inferenceRoutingProfiles.reasoningEffort,
        isProductPreset: inferenceRoutingProfiles.isProductPreset,
        optimiseFor: inferenceRoutingProfiles.optimiseFor,
      })
      .from(inferenceRoutingProfiles);
    const presets = rows
      .filter((row) => row.powerLevel !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(presets).toEqual(
      [
        ['auto', null],
        ['high', 'medium'],
        ['instant', null],
        ['medium', 'low'],
        ['pro', 'high'],
        ['ultra', 'high'],
        ['xhigh', 'high'],
      ].map(([level, effort]) => ({
        id: `power-${level}`,
        slug: level,
        powerLevel: level,
        reasoningEffort: effort,
        isProductPreset: true,
        optimiseFor: 'price',
      })),
    );
  });

  it('targets no reasoning for instant and each row effort for the others', async () => {
    expect(Object.fromEntries(await powerLevelEfforts())).toEqual({
      instant: 'none',
      medium: 'low',
      high: 'medium',
      xhigh: 'high',
      pro: 'high',
      ultra: 'high',
    });
  });

  it('refuses a power level on a non-preset profile and a second profile for one level', async () => {
    await expect(
      getDb().insert(inferenceRoutingProfiles).values({
        slug: 'custom-instant',
        displayName: 'x',
        optimiseFor: 'price',
        isProductPreset: false,
        powerLevel: 'instant',
      }),
    ).rejects.toThrow();
    await expect(
      getDb().insert(inferenceRoutingProfiles).values({
        slug: 'second-instant',
        displayName: 'x',
        optimiseFor: 'price',
        isProductPreset: true,
        powerLevel: 'instant',
      }),
    ).rejects.toThrow();
  });

  it('refuses a power class with no https evidence', async () => {
    await expect(
      getDb().insert(inferenceModelPowerClasses).values({
        modelId: 'nobody/nothing',
        powerClass: 'pro',
        evidenceSource: 'x',
        evidenceUrl: 'http://example.test',
        evidenceSummary: 'x',
        reviewedAt: new Date(),
        reviewedBy: 'x',
      }),
    ).rejects.toThrow();
  });

  describe('listing a power level', () => {
    beforeEach(async () => {
      await clearPowerClassesForTest();
    });

    it('lists the servable models of the level class and nothing else', async () => {
      const instantA = await insertCatalogueRoute({ tag: 'ia' });
      const instantB = await insertCatalogueRoute({ tag: 'ib' });
      const unservable = await insertCatalogueRoute({ tag: 'iu', evidence: false });
      const medium = await insertCatalogueRoute({ tag: 'md' });
      const unclassed = await insertCatalogueRoute({ tag: 'nc' });
      await setPowerClass(instantA.modelId, 'instant');
      await setPowerClass(instantB.modelId, 'instant');
      await setPowerClass(unservable.modelId, 'instant');
      await setPowerClass(medium.modelId, 'medium');

      const profiles = await listRoutingProfiles(INTERNAL_VIEWER, {
        kind: 'servable',
        liveness: { status: 'not-configured' },
      });
      const instant = profiles.find((profile) => profile.slug === 'instant');
      expect(instant?.powerLevel).toBe('instant');
      expect(instant?.candidates.map((candidate) => candidate.modelReference).sort()).toEqual(
        [instantA.modelId, instantB.modelId].sort(),
      );

      // auto lists every level it may climb to, one priority per level.
      const auto = profiles.find((profile) => profile.slug === 'auto');
      expect(auto?.candidates).toEqual(
        expect.arrayContaining([
          { modelReference: instantA.modelId, priority: 0 },
          { modelReference: medium.modelId, priority: 1 },
        ]),
      );
      const everyCandidate = profiles.flatMap((profile) =>
        profile.candidates.map((candidate) => candidate.modelReference),
      );
      expect(everyCandidate).not.toContain(unservable.modelId);
      expect(everyCandidate).not.toContain(unclassed.modelId);

      // A level with no servable model is not listed at all.
      expect(profiles.find((profile) => profile.slug === 'ultra')).toBeUndefined();
    });

    it('lists nothing for a level when Kaana publishes none of its deployments', async () => {
      const model = await insertCatalogueRoute({ tag: 'pub' });
      await setPowerClass(model.modelId, 'instant');
      const profiles = await listRoutingProfiles(INTERNAL_VIEWER, {
        kind: 'servable',
        liveness: {
          status: 'observed',
          snapshotId: 'snap',
          deploymentIds: new Set(['someone-else']),
          observedAt: Date.now(),
        },
      });
      expect(profiles.find((profile) => profile.slug === 'instant')).toBeUndefined();
    });

    it('reports the reviewed class on the catalogue entry', async () => {
      const model = await insertCatalogueRoute({ tag: 'cls' });
      await setPowerClass(model.modelId, 'high');
      const entry = (await listCatalogueForViewer(INTERNAL_VIEWER, CATALOGUED)).find(
        (candidate) => candidate.modelId === model.modelId,
      );
      expect(entry?.powerClass).toBe('high');
      const rows = await getDb()
        .select()
        .from(inferenceModelPowerClasses)
        .where(eq(inferenceModelPowerClasses.modelId, model.modelId));
      expect(rows).toHaveLength(1);
    });
  });
});
