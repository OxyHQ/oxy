import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_FOLDER } from '../../migrationsFolder';

const migration = readFileSync(join(MIGRATIONS_FOLDER, '0076_loud_strong_guy.sql'), 'utf8');

describe('0076 retired link-preview cache normalization', () => {
  it('moves only the measured legacy owner/purpose pair into the surviving remote cache class', () => {
    expect(migration).toContain(`UPDATE "files"
SET "purpose" = 'federation-media-cache',
\t"system_owner" = '__federation_media_cache__'
WHERE "purpose" = 'link-preview'
\tAND "system_owner" = '__link_preview_cache__'`);
  });

  it('normalizes before narrowing both constraints', () => {
    const update = migration.indexOf('UPDATE "files"');
    const purposeConstraint = migration.indexOf('ADD CONSTRAINT "files_purpose_check"');
    const ownerConstraint = migration.indexOf('ADD CONSTRAINT "files_system_owner_check"');

    expect(update).toBeGreaterThan(-1);
    expect(purposeConstraint).toBeGreaterThan(update);
    expect(ownerConstraint).toBeGreaterThan(update);
  });
});
