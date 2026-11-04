import sharp from 'sharp';
import { avatarSeedColor } from '../avatarColor';

const solid = (background: string) =>
  sharp({ create: { width: 32, height: 32, channels: 3, background } })
    .png()
    .toBuffer();

describe('avatarSeedColor', () => {
  it("returns a coloured picture's seed as #rrggbb, and null for one with no colour", async () => {
    expect(await avatarSeedColor(await solid('#d32f2f'))).toMatch(/^#[0-9a-f]{6}$/);
    expect(await avatarSeedColor(await solid('#808080'))).toBeNull();
    expect(await avatarSeedColor(Buffer.from('not an image'))).toBeNull();
  });
});
