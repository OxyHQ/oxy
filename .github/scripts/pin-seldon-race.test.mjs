import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { pin, WORKFLOWS } from './pin-seldon-race.mjs';

const A = 'a'.repeat(40);
const B = '0123456789abcdef0123456789abcdef01234567';

test('pins an @main ref with a # main comment', () => {
  assert.equal(
    pin('        uses: OxyHQ/oxy/.github/actions/seldon-race@main\n', A),
    `        uses: OxyHQ/oxy/.github/actions/seldon-race@${A} # main\n`,
  );
});

test('moves an existing pin and keeps one comment', () => {
  assert.equal(
    pin(`      - uses: OxyHQ/oxy/.github/actions/seldon-race@${A} # main\n        with:\n`, B),
    `      - uses: OxyHQ/oxy/.github/actions/seldon-race@${B} # main\n        with:\n`,
  );
});

test('leaves every other action alone', () => {
  const text =
    'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\nuses: OxyHQ/oxy/.github/actions/reviewed-image@main\n';
  assert.equal(pin(text, A), text);
});

test('is idempotent', () => {
  const once = pin('uses: OxyHQ/oxy/.github/actions/seldon-race@main\n', A);
  assert.equal(pin(once, A), once);
});

test('refuses anything but a full commit SHA', () => {
  assert.throws(() => pin('', 'main'));
  assert.throws(() => pin('', A.slice(1)));
});

test('every reusable workflow pins the action to one full SHA', () => {
  const shas = new Set();
  for (const file of WORKFLOWS) {
    const refs = [
      ...readFileSync(file, 'utf8').matchAll(
        /OxyHQ\/oxy\/\.github\/actions\/seldon-race@(\S+)( # main)?/g,
      ),
    ];
    assert.ok(refs.length > 0, `${file} calls the action`);
    for (const [, ref, comment] of refs) {
      assert.match(ref, /^[0-9a-f]{40}$/, `${file} pins by full SHA, not ${ref}`);
      assert.ok(comment, `${file} marks the pin # main`);
      shas.add(ref);
    }
  }
  assert.equal(shas.size, 1, `one commit across the three workflows, not ${[...shas].join(', ')}`);
});
