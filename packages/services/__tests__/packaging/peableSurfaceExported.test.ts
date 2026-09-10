import { readFileSync } from 'node:fs';
import path from 'node:path';

const rootBarrel = readFileSync(path.resolve(__dirname, '../../src/index.ts'), 'utf8');
const uiBarrel = readFileSync(path.resolve(__dirname, '../../src/ui/index.ts'), 'utf8');
const clientBarrel = readFileSync(path.resolve(__dirname, '../../src/ui/client.ts'), 'utf8');
const serverBarrel = readFileSync(path.resolve(__dirname, '../../src/ui/server.ts'), 'utf8');
const compatibilityModule = readFileSync(
  path.resolve(__dirname, '../../src/ui/components/OxyPayButton.tsx'),
  'utf8'
);

describe('Peable payment button public surface', () => {
  it.each([rootBarrel, uiBarrel, clientBarrel])(
    'exports PeableButton as the canonical client component',
    (barrel) => {
      expect(barrel).toMatch(/export \{ default as PeableButton \}/);
      expect(barrel).toMatch(/export type \{ PeableButtonProps \}/);
    }
  );

  it('provides a server-safe PeableButton', () => {
    expect(serverBarrel).toContain('export const PeableButton = noopComponent');
  });

  it('keeps the former public name only as a documented compatibility alias', () => {
    expect(compatibilityModule).toContain('@deprecated Use `PeableButton`');
    expect(compatibilityModule).toContain("export { default } from './PeableButton'");
    expect(rootBarrel).toContain('default as OxyPayButton');
    expect(uiBarrel).toContain('default as OxyPayButton');
    expect(clientBarrel).toContain('default as OxyPayButton');
    expect(serverBarrel).toContain('export const OxyPayButton = PeableButton');
  });
});
