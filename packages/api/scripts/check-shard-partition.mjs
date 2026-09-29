/**
 * Proves the API shards ran the WHOLE suite exactly once, and records how long
 * each file took so the next balance is measured rather than guessed.
 *
 * The shards are dealt by jest.shardSequencer.cjs, a duration-balanced
 * replacement for Jest's own hash split. That function is pure and every shard
 * computes the same partition, but "every test ran on exactly one runner" is
 * the property the whole sharded design rests on, so it is checked on the
 * evidence, every run, rather than trusted: each shard writes Jest's `--json`
 * results, and this compares the union of the test files they EXECUTED with
 * `jest --listTests` for the same tree. A file missing from every shard, a file
 * run twice, a shard whose results are absent, or a shard that reports a
 * failure all fail the job. The coverage merge already refuses a missing or
 * extra coverage report; this closes the other half — a shard that produced
 * coverage while silently running fewer files.
 *
 * It also writes `test-durations.json` in the committed format: the committed
 * values overlaid with this run's per-file times, minus each shard's FIRST file
 * (that one absorbs the ~70s cold ts-jest transform every runner pays, and would
 * otherwise be recorded as a 70s test). Copy it over packages/api/
 * test-durations.json to refresh the balance.
 *
 * Usage (from packages/api, after the shard results are in coverage/shard-<i>/):
 *   node scripts/check-shard-partition.mjs --shards=<N> --list=<file of jest --listTests> [--durations-out=<file>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const PACKAGE_MARKER = '/packages/api/';

/** An absolute runner path -> the package-relative path the sequencer keys on. */
export function packageRelative(path) {
  const normalised = path.replace(/\\/g, '/');
  const index = normalised.lastIndexOf(PACKAGE_MARKER);
  if (index === -1) throw new Error(`${path} is not inside ${PACKAGE_MARKER}`);
  return normalised.slice(index + PACKAGE_MARKER.length);
}

/**
 * @param {{ shardResults: Array<object|null>, listed: string[], committedSeconds: Record<string, number> }} input
 * @returns {{ problems: string[], seconds: Record<string, number>, executed: number }}
 */
export function checkPartition({ shardResults, listed, committedSeconds }) {
  const problems = [];
  const seen = new Map();
  const seconds = { ...committedSeconds };

  shardResults.forEach((result, index) => {
    const shard = index + 1;
    if (!result || !Array.isArray(result.testResults)) {
      problems.push(`shard ${shard}: no Jest results (jest-results.json missing or malformed)`);
      return;
    }
    if (result.success !== true || result.numFailedTestSuites > 0 || result.numRuntimeErrorTestSuites > 0) {
      problems.push(`shard ${shard}: Jest reported failure (success=${result.success}, failed suites=${result.numFailedTestSuites})`);
    }
    if (result.testResults.length === 0) problems.push(`shard ${shard}: executed zero test files`);
    if (result.wasInterrupted === true) problems.push(`shard ${shard}: Jest reports the run was interrupted`);
    if (Number.isInteger(result.numTotalTestSuites) && result.numTotalTestSuites !== result.testResults.length) {
      problems.push(`shard ${shard}: Jest counted ${result.numTotalTestSuites} suites but reported ${result.testResults.length}`);
    }
    // Jest's `--json` gives each file `startTime`/`endTime` (ms); `perfStats` is
    // the in-process shape, accepted too so either form measures.
    const startOf = (file) => file.startTime ?? file.perfStats?.start;
    const endOf = (file) => file.endTime ?? file.perfStats?.end;
    const ordered = [...result.testResults].sort((a, b) => (startOf(a) ?? 0) - (startOf(b) ?? 0));
    ordered.forEach((file, position) => {
      const path = packageRelative(file.name);
      if (seen.has(path)) problems.push(`${path} ran on shard ${seen.get(path)} AND shard ${shard}`);
      else seen.set(path, shard);
      const start = startOf(file);
      const end = endOf(file);
      if (position > 0 && Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        seconds[path] = Math.round((end - start) / 100) / 10;
      }
    });
  });

  const expected = new Set(listed.map(packageRelative));
  if (expected.size === 0) problems.push('`jest --listTests` listed no files; the comparison would be vacuous');
  for (const path of expected) if (!seen.has(path)) problems.push(`${path} is in the suite but ran on no shard`);
  for (const path of seen.keys()) if (!expected.has(path)) problems.push(`${path} ran but is not in \`jest --listTests\``);

  // Only files that still exist, so the committed file does not accrete ghosts.
  const current = Object.fromEntries(
    Object.keys(seconds)
      .filter((path) => expected.has(path))
      .sort()
      .map((path) => [path, seconds[path]])
  );
  return { problems, seconds: current, executed: seen.size };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { shards: { type: 'string' }, list: { type: 'string' }, 'durations-out': { type: 'string' } },
  });
  if (!/^[1-9]\d*$/.test(values.shards ?? '')) throw new Error('--shards=<N> is required');
  if (!values.list) throw new Error('--list=<file> is required');
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const shardCount = Number(values.shards);
  const shardResults = Array.from({ length: shardCount }, (_, index) => {
    const path = resolve(packageRoot, `coverage/shard-${index + 1}/jest-results.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  });
  const listed = readFileSync(values.list, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const committedPath = resolve(packageRoot, 'test-durations.json');
  const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
  const { problems, seconds, executed } = checkPartition({ shardResults, listed, committedSeconds: committed.seconds ?? {} });
  if (values['durations-out']) {
    writeFileSync(
      values['durations-out'],
      `${JSON.stringify({ ...committed, measuredFrom: `${process.env.GITHUB_RUN_ID ? `CI run ${process.env.GITHUB_RUN_ID}` : 'a local run'}, ${shardCount} shards: Jest's per-file startTime/endTime, each shard's first file keeping its previous value (it absorbs the cold transform).`, seconds }, null, 2)}\n`
    );
  }
  if (problems.length > 0) {
    console.error(`The API shards did NOT run the suite exactly once (${problems.length} problem(s)):`);
    for (const problem of problems.slice(0, 50)) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Partition verified: ${executed} test files across ${shardCount} shards, each exactly once, matching jest --listTests.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
