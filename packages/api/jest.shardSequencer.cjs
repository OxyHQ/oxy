/**
 * Jest's default sequencer, with ONE override: `shard()` balances the CI
 * shards by measured duration instead of by a hash of the file path.
 *
 * WHY
 *
 * Jest's sharder hashes each path and cuts the sorted list into equal COUNTS.
 * With six shards that already left one runner ~220s behind another on the same
 * commit (run 36499876274: "Run tests with coverage" 325s on shard 4, 575s on
 * shard 6), and the slowest shard is the critical path of `CI complete`. With
 * twelve shards a count split puts the same few 20-45s files wherever the hash
 * lands, so the skew is proportionally worse. Here each file carries its
 * measured time (test-durations.json) and files are dealt longest-first to the
 * least-loaded shard (the LPT rule), which is within 4/3 of optimal and in
 * practice within a few seconds for 500+ small jobs.
 *
 * WHAT IT MUST NEVER DO
 *
 * Drop or duplicate a test. Every shard runs this same pure function over the
 * same file list and the same durations file, so the N answers are one
 * partition of the list: each test lands on exactly one shard. `api-coverage`
 * proves it on every run anyway — it compares the union of the shards'
 * executed test files against `jest --listTests` and fails on a missing or a
 * doubled file (scripts/check-shard-partition.mjs) — and
 * scripts/shard-sequencer.test.mjs checks the partition property directly.
 *
 * A file with no measurement (added since the durations were recorded) is
 * weighted as the median file, so a stale durations file costs balance, never
 * coverage. Ordering WITHIN a shard is the default sequencer's, unchanged.
 */
const { dirname, posix } = require('node:path');
const { readFileSync } = require('node:fs');

// The default sequencer, resolved through the same chain Jest itself uses
// (jest -> @jest/core -> jest-config -> @jest/test-sequencer), so this never
// depends on an undeclared package happening to be hoisted.
function resolveDefaultSequencer() {
  const from = (request, dir) => require.resolve(request, { paths: [dir] });
  const jestDir = dirname(from('jest/package.json', __dirname));
  const coreDir = dirname(from('@jest/core/package.json', jestDir));
  const configDir = dirname(from('jest-config/package.json', coreDir));
  const loaded = require(from('@jest/test-sequencer', configDir));
  return loaded.default ?? loaded;
}

const DURATIONS_PATH = `${__dirname}/test-durations.json`;

function loadDurations() {
  const parsed = JSON.parse(readFileSync(DURATIONS_PATH, 'utf8'));
  const seconds = parsed?.seconds;
  if (!seconds || typeof seconds !== 'object') throw new Error(`${DURATIONS_PATH} has no "seconds" map`);
  return seconds;
}

function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The partition itself, pure so it can be tested without Jest:
 * `paths` relative to the package, returns shard number (1-based) per path.
 */
function assignShards(paths, shardCount, seconds) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error(`bad shard count ${shardCount}`);
  const known = paths.map((path) => seconds[path]).filter((value) => Number.isFinite(value) && value >= 0);
  const fallback = median(known);
  const weighted = [...new Set(paths)]
    .map((path) => ({ path, weight: Number.isFinite(seconds[path]) && seconds[path] >= 0 ? seconds[path] : fallback }))
    // Longest first; the path breaks ties so every shard computes the same order.
    .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const load = Array.from({ length: shardCount }, () => 0);
  const assignment = new Map();
  for (const { path, weight } of weighted) {
    let target = 0;
    for (let index = 1; index < shardCount; index += 1) if (load[index] < load[target]) target = index;
    load[target] += weight;
    assignment.set(path, target + 1);
  }
  return { assignment, load };
}

const DefaultSequencer = resolveDefaultSequencer();

class DurationBalancedSequencer extends DefaultSequencer {
  shard(tests, { shardIndex, shardCount }) {
    const seconds = loadDurations();
    const relativeOf = (test) =>
      posix.relative(test.context.config.rootDir.replace(/\\/g, '/'), test.path.replace(/\\/g, '/'));
    const { assignment } = assignShards(tests.map(relativeOf), shardCount, seconds);
    return tests.filter((test) => assignment.get(relativeOf(test)) === shardIndex);
  }
}

module.exports = DurationBalancedSequencer;
module.exports.assignShards = assignShards;
module.exports.loadDurations = loadDurations;
