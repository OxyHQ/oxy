/**
 * The legacy `file_links.app` table names real, official applications.
 *
 * Its twin inside migration 0169 is held equal to it by
 * `db/schema/__tests__/fileReferencesMigration.test.ts`; this pins it to the
 * seed, so a renamed or re-identified official application cannot leave an
 * alias resolving to nothing.
 */

import { SEED_APPS } from '../../scripts/seedOxyApplicationsSpecs';
import {
  LEGACY_FILE_LINK_APPLICATIONS,
  legacyFileLinkApplication,
} from '../legacyFileLinkApplications';

describe('LEGACY_FILE_LINK_APPLICATIONS', () => {
  it('covers every app string found in use across the Oxy repositories', () => {
    expect(LEGACY_FILE_LINK_APPLICATIONS.map((entry) => entry.app).sort()).toEqual([
      'goway',
      'mercaria',
      'nilo',
      'oxy-mail',
      'profiles',
    ]);
  });

  it.each(LEGACY_FILE_LINK_APPLICATIONS.map((entry) => [entry.app, entry] as const))(
    '%s names one official seeded application, by its fixed id and its seed names',
    (_app, entry) => {
      const [current, ...legacy] = entry.names;
      const spec = SEED_APPS.find((candidate) => candidate.name === current);
      expect(spec).toBeDefined();
      expect(spec?.type).not.toBe('third_party');
      expect(entry.applicationId).toBe(spec?.id ?? null);
      expect(legacy).toEqual(spec?.legacyNames ?? []);
    },
  );

  it('finds an entry by its app string and nothing else', () => {
    expect(legacyFileLinkApplication('goway')?.names).toEqual(['GoWay']);
    expect(legacyFileLinkApplication('GoWay')).toBeUndefined();
    expect(legacyFileLinkApplication('73176d04c3654667138c23ec')).toBeUndefined();
  });
});
