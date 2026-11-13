import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICES_PERSISTED_DATA_VERSION } from '../../src/ui/utils/persistedDataVersion';

/** The SDK's own part of a declared-version buster moves with every release. */
it('matches the package version', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  expect(SERVICES_PERSISTED_DATA_VERSION).toBe(manifest.version);
});
