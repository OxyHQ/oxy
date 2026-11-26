#!/usr/bin/env node
// Pins the seldon-race action in the race's reusable workflows to one commit
// (docs/engineering/build-and-deploy.md#ci-on-seldon). A repository whose
// Actions policy requires full-SHA pins (`sha_pinning_required`) refuses
// `@main` inside a workflow it calls, so the three reusable workflows call the
// action at a commit SHA with a `# main` comment. `seldon-race-pin.yml` runs
// this on every push to main that changes the action, and opens the PR.
//
//   node .github/scripts/pin-seldon-race.mjs <40-hex commit sha>
//
// Prints the files it rewrote, one per line; prints nothing when every pin
// was already at that commit.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const WORKFLOWS = [
  '.github/workflows/seldon-race-start.yml',
  '.github/workflows/seldon-race-finish.yml',
  '.github/workflows/seldon-race-retry.yml',
];

const REF = /(OxyHQ\/oxy\/\.github\/actions\/seldon-race)@[^\s#]+(?:[ \t]*#[^\n]*)?/g;

/** `text` with every seldon-race action ref at `sha`, each with a `# main` comment. */
export function pin(text, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a full commit SHA: ${sha}`);
  return text.replace(REF, `$1@${sha} # main`);
}

function main([sha]) {
  for (const file of WORKFLOWS) {
    const before = readFileSync(file, 'utf8');
    if (!before.match(REF)) throw new Error(`${file} calls no seldon-race action`);
    const after = pin(before, sha);
    if (after !== before) {
      writeFileSync(file, after);
      console.log(file);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
