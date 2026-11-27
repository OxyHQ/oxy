// The verdict for CI complete under Seldon-first routing
// (docs/engineering/build-and-deploy.md#seldon-first-routing).
//
// A heavy job `X` runs on the seldon-ci pool while the org variable
// SELDON_CI_ROUTE reads `seldon-ci` (first attempt of a same-repository pull
// request only), and hosted otherwise. Nothing races and there are no twins.
// When X fails on Seldon, whatever the reason (the house network drops
// connections), its rescue `X-rescue` (hosted, the same display name, strategy
// and steps) runs it again, and fails again on a genuine failure. A matrix
// rescue reruns every shard, so a passing rescue is the whole job proven on
// hosted.
//
// So per family:
//   X success                          passed
//   X failure, X-rescue success        rescued (passed)
//   X-rescue skipped                   X's own result: success passed, skipped
//                                      "skipped" (the gate decides whether that
//                                      skip is allowed), anything else failed
//   anything else                      failed (a failed or cancelled rescue,
//                                      or a rescue that ran over a job that
//                                      did not fail)
//
// It reads only the gate's `needs`: no token and no API call.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RESCUE_SUFFIX = '-rescue';

/** { X: 'passed' | 'rescued' | 'skipped' | 'failed' } for every X that has an X-rescue. */
export function families(needs) {
  const out = {};
  for (const id of Object.keys(needs)) {
    if (!id.endsWith(RESCUE_SUFFIX)) continue;
    const base = id.slice(0, -RESCUE_SUFFIX.length);
    if (!(base in needs)) continue;
    const own = needs[base]?.result;
    const rescue = needs[id]?.result;
    if (rescue === 'skipped') {
      out[base] = own === 'success' ? 'passed' : own === 'skipped' ? 'skipped' : 'failed';
    } else if (rescue === 'success' && own === 'failure') {
      out[base] = 'rescued';
    } else {
      out[base] = 'failed';
    }
  }
  return out;
}

export function outcome(verdicts) {
  return Object.values(verdicts).includes('failed') ? 'failure' : 'success';
}

function output(env, name, value) {
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

export function main(env) {
  let needs;
  try {
    needs = JSON.parse(env.INPUT_NEEDS ?? '');
  } catch {
    throw new Error('the needs input is not JSON: pass toJSON(needs) from the gate');
  }
  if (!needs || typeof needs !== 'object') throw new Error('the needs input is not an object');
  const verdicts = families(needs);
  for (const [base, v] of Object.entries(verdicts)) {
    const line = `${base}: ${v}`;
    console.log(
      v === 'failed'
        ? `::error::${line} (${base}=${needs[base]?.result}, ${base}${RESCUE_SUFFIX}=${needs[`${base}${RESCUE_SUFFIX}`]?.result})`
        : line,
    );
  }
  output(env, 'outcome', outcome(verdicts));
  output(env, 'families', JSON.stringify(verdicts));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.env);
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
