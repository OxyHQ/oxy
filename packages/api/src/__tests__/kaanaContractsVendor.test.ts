/**
 * `@kaana.ai/contracts` is vendored from an exact Kaana commit until it is
 * published (Kaana ADR 0002). The copy is the contract Oxy signs grants
 * against, so an edit to it would be a shape Kaana does not parse: the copy
 * must match `vendor/kaana-contracts/provenance.json` byte for byte.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');

describe('vendored @kaana.ai/contracts', () => {
  it('matches the pinned Kaana commit byte for byte', () => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'vendor-kaana-contracts.mjs'), '--check'],
      { encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
