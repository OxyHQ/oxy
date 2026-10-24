/**
 * The hologram engraves the Commons emblem in the card's bottom-right corner
 * and does not flip with the card, so on the BACK faces it shows bottom-LEFT.
 * The back face's footer note wrapped under it on a Pixel 8a. Every back face
 * insets its footer by the emblem's clearance, from one shared geometry.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMBLEM_CLEARANCE, EMBLEM_PAD, EMBLEM_SIZE } from '@/components/OxyID/emblem';

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('the card emblem', () => {
  it('clears the mark with air to spare', () => {
    expect(EMBLEM_CLEARANCE).toBeGreaterThan(EMBLEM_PAD + EMBLEM_SIZE);
  });

  it('is drawn from the shared geometry', () => {
    expect(read('components/holographic-card.tsx')).toContain("from './OxyID/emblem'");
  });

  it.each(['components/OxyID/back-side.tsx', 'components/civic/IdQrBack.tsx'])(
    '%s insets its footer by the clearance',
    (path) => {
      expect(read(path)).toMatch(/paddingLeft: EMBLEM_CLEARANCE - /);
    },
  );
});
