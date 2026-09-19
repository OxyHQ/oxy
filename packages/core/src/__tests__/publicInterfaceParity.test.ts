/**
 * The middleware options a CONSUMER can pass must be the ones the middleware
 * actually takes.
 *
 * `src/OxyServices.ts` re-declares `auth()` and `serviceAuth()` by hand, with
 * their option objects written out inline, because declaration emit for the
 * mixin pipeline does not carry them. That hand-written interface is what
 * downstream packages see — `OxyAuthMiddlewareOptions` in `server/auth.ts` is
 * literally `Parameters<OxyServices['auth']>[0]` — so an option that exists on
 * the mixin and not there exists for this package and for nobody else.
 *
 * `onRefusal` shipped in 1.5.0 exactly that way: implemented, tested, exported,
 * and rejected by the first host that tried to pass it
 * (`TS2345 … has no properties in common with`). Nothing in this package could
 * see it, because everything in this package resolves the mixin's own
 * declaration, where the option is present. Only the published `.d.ts` loses it.
 *
 * So the check is on the SOURCE TEXT of the two declarations, which is the
 * thing that diverges. It is not a type test: a type test here reads the merged
 * interface and passes either way — measured, by deleting the option and
 * watching `tsc --noEmit` stay green.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

/** Every `name?:` key declared directly inside one brace-balanced block. */
function optionKeys(source: string, startPattern: RegExp): string[] {
  const match = startPattern.exec(source);
  if (!match) throw new Error(`declaration not found: ${String(startPattern)}`);
  let depth = 0;
  let index = source.indexOf('{', match.index);
  const open = index;
  do {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    index += 1;
  } while (depth > 0 && index < source.length);
  const body = source.slice(open + 1, index - 1);
  // Only keys at THIS level: a nested object literal would otherwise contribute
  // its own keys. None exist today; the guard keeps that from becoming silent.
  const withoutNested = body.replace(/\{[^{}]*\}/g, '');
  return [...withoutNested.matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1] as string).sort();
}

describe('the public OxyServices interface declares the options the mixin takes', () => {
  const mixin = readFileSync(join(SRC, 'mixins/OxyServices.utility.ts'), 'utf8');
  const publicInterface = readFileSync(join(SRC, 'OxyServices.ts'), 'utf8');

  it('auth() — same option names on both declarations', () => {
    const declared = optionKeys(mixin, /interface AuthMiddlewareOptions/);
    const published = optionKeys(publicInterface, /^ {2}auth\(options\?: \{/m);

    expect(declared).toContain('onRefusal');
    expect(published).toEqual(declared);
  });

  it('serviceAuth() — same option names on both declarations', () => {
    const declared = optionKeys(mixin, /^ {4}serviceAuth\(options: \{/m);
    const published = optionKeys(publicInterface, /^ {2}serviceAuth\(options\?: \{/m);

    expect(declared).toContain('onRefusal');
    expect(published).toEqual(declared);
  });

  it('reads real declarations rather than matching nothing', () => {
    // The floor. A regex that stopped matching would make both cases above
    // compare two empty lists and pass.
    expect(optionKeys(mixin, /interface AuthMiddlewareOptions/).length).toBeGreaterThan(5);
    expect(optionKeys(publicInterface, /^ {2}auth\(options\?: \{/m).length).toBeGreaterThan(5);
  });
});
