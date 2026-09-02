import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');

export const EXPECTED_SHARD_COUNT = 3;
export const METRICS = ['statements', 'branches', 'functions', 'lines'];

function readNonEmptyJson(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} is missing: ${filePath}`);
  }

  if (!statSync(filePath).isFile() || statSync(filePath).size === 0) {
    throw new Error(`${label} is empty: ${filePath}`);
  }

  let value;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${filePath}`, { cause: error });
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object: ${filePath}`);
  }

  return value;
}

function validateFloors(config, configPath) {
  if (config.schemaVersion !== 1 || !config.floors || typeof config.floors !== 'object') {
    throw new Error(`Coverage floor config has an unsupported shape: ${configPath}`);
  }

  const keys = Object.keys(config.floors).sort();
  const expectedKeys = [...METRICS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Coverage floors must define exactly: ${METRICS.join(', ')}`);
  }

  for (const metric of METRICS) {
    const value = config.floors[metric];
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`Coverage floor for ${metric} must be a number from 0 through 100`);
    }
  }

  return config.floors;
}

function assertSameFileUniverse(coverageMaps, inputFiles) {
  const expected = coverageMaps[0].files().sort();
  if (expected.length === 0) {
    throw new Error(`Coverage report contains no instrumented files: ${inputFiles[0]}`);
  }

  for (let index = 1; index < coverageMaps.length; index += 1) {
    const actual = coverageMaps[index].files().sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Coverage shard file universe differs between ${inputFiles[0]} and ${inputFiles[index]}`,
      );
    }
  }
}

function summaryToJson(summary) {
  const json = summary.toJSON();
  return Object.fromEntries(METRICS.map((metric) => [metric, json[metric]]));
}

function assertReportsAreNonEmpty(outputDir) {
  for (const relativePath of [
    'coverage-final.json',
    'coverage-summary.json',
    'coverage-summary.txt',
    'lcov.info',
    'index.html',
  ]) {
    const filePath = resolve(outputDir, relativePath);
    if (!existsSync(filePath) || !statSync(filePath).isFile() || statSync(filePath).size === 0) {
      throw new Error(`Merged coverage report is missing or empty: ${filePath}`);
    }
  }
}

export function mergeCoverage({ inputFiles, outputDir, floorConfigPath }) {
  if (!Array.isArray(inputFiles) || inputFiles.length !== EXPECTED_SHARD_COUNT) {
    throw new Error(`Expected exactly ${EXPECTED_SHARD_COUNT} shard coverage reports`);
  }

  const normalizedInputs = inputFiles.map((filePath) => resolve(filePath));
  const normalizedOutput = resolve(outputDir);
  const normalizedFloorConfig = resolve(floorConfigPath);

  const coverageMaps = normalizedInputs.map((filePath, index) => {
    const rawCoverage = readNonEmptyJson(filePath, `Coverage shard ${index + 1}`);
    const coverageMap = createCoverageMap(rawCoverage);
    if (coverageMap.files().length === 0) {
      throw new Error(`Coverage shard ${index + 1} contains no instrumented files: ${filePath}`);
    }
    return coverageMap;
  });
  assertSameFileUniverse(coverageMaps, normalizedInputs);

  const floorConfig = readNonEmptyJson(normalizedFloorConfig, 'Coverage floor config');
  const floors = validateFloors(floorConfig, normalizedFloorConfig);
  const mergedMap = createCoverageMap({});
  for (const coverageMap of coverageMaps) {
    mergedMap.merge(coverageMap);
  }

  rmSync(normalizedOutput, { recursive: true, force: true });
  mkdirSync(normalizedOutput, { recursive: true });

  const context = createContext({ dir: normalizedOutput, coverageMap: mergedMap });
  reports.create('json', { file: 'coverage-final.json' }).execute(context);
  reports.create('json-summary', { file: 'coverage-summary.json' }).execute(context);
  reports.create('lcovonly', { file: 'lcov.info' }).execute(context);
  reports.create('html').execute(context);
  reports.create('text-summary', { file: 'coverage-summary.txt' }).execute(context);
  assertReportsAreNonEmpty(normalizedOutput);

  const summary = summaryToJson(mergedMap.getCoverageSummary());
  const regressions = METRICS.filter((metric) => summary[metric].pct < floors[metric]);

  console.log(`Merged ${normalizedInputs.length} API coverage shards:`);
  for (const metric of METRICS) {
    const actual = summary[metric];
    console.log(
      `  ${metric}: ${actual.pct}% (${actual.covered}/${actual.total}), floor ${floors[metric]}%`,
    );
  }

  if (regressions.length > 0) {
    const details = regressions
      .map((metric) => `${metric} ${summary[metric].pct}% < ${floors[metric]}%`)
      .join(', ');
    throw new Error(`Merged API coverage regressed: ${details}`);
  }

  return { summary, floors };
}

function defaultOptions() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return {
    inputFiles: Array.from({ length: EXPECTED_SHARD_COUNT }, (_, index) =>
      resolve(packageRoot, `coverage/shard-${index + 1}/coverage-final.json`),
    ),
    outputDir: resolve(packageRoot, 'coverage/merged'),
    floorConfigPath: resolve(packageRoot, 'coverage-floors.json'),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    mergeCoverage(defaultOptions());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
