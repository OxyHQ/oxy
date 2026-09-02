import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../../scripts/generate-openapi';

/**
 * The base document is parsed by a hand-rolled YAML reader, deliberately, to
 * keep the generator dependency-free. That trade is only safe if the reader
 * REFUSES what it cannot represent — its previous failure mode was to read an
 * unrecognised block-scalar header as a plain string and then treat the
 * indented body as further keys, silently dropping every sibling that followed.
 *
 * Measured when `>-` was introduced: `components.schemas` came back with 4 of
 * its 7 entries and `User.id.description` was the literal string ">-", and
 * nothing failed. The published contract was written from that.
 */
describe('openapi.base.yaml parses completely', () => {
  const base = parseYaml(
    readFileSync(path.resolve(__dirname, '../../openapi.base.yaml'), 'utf8'),
  );

  it('reads every component schema, not a prefix of them', () => {
    // A floor, not an exact count: the point is that a mis-parse truncates the
    // map, and a truncation deep enough to matter drops below this.
    expect(Object.keys(base.components.schemas ?? {}).length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(base.components.schemas ?? {})).toEqual(
      expect.arrayContaining(['User', 'Session', 'Device', 'AuthSuccess']),
    );
  });

  it('declares the short-lived capability ticket security scheme', () => {
    expect(base.components.securitySchemes?.capabilityTicketAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'Capability <signed-ticket>',
    });
  });

  it('folds a `>-` block scalar into text rather than the header string', () => {
    const id = (base.components.schemas?.User as Record<string, Record<string, Record<string, unknown>>>)
      ?.properties?.id;
    expect(id?.description).not.toBe('>-');
    expect(String(id?.description)).toContain('Stable Oxy user ID');
    // The sibling keys that a mis-parse swallows.
    expect(id?.pattern).toEqual(expect.any(String));
    expect(id?.examples).toEqual(expect.any(Array));
  });

  it('THROWS on a block-scalar header it cannot represent, rather than guessing', () => {
    expect(() => parseYaml('components:\n  description: >2\n    indented\n')).toThrow(
      /unsupported block scalar header/,
    );
  });

  // `|` CLIPS — it keeps exactly one trailing newline — while `|-` STRIPS it.
  // That difference is the whole reason the chomping indicator has to be read
  // rather than ignored, and asserting it here is what stops a future
  // "simplification" from collapsing the two back into one branch.
  it.each([
    ['>', 'one two'],
    ['>-', 'one two'],
    ['|', 'one\ntwo\n'],
    ['|-', 'one\ntwo'],
  ])('supports the %s header', (header, expected) => {
    const parsed = parseYaml(`root:\n  text: ${header}\n    one\n    two\n`) as unknown as {
      root: { text: string };
    };
    expect(parsed.root.text).toBe(expected);
  });
});
