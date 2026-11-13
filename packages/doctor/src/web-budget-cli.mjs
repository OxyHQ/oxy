#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { measureWebExport, overBudget } from './web-export-budget.mjs';

const usage = 'oxy-doctor-web-budget [--dist=PATH] [--budgets=PATH]';

let dist = 'packages/frontend/dist';
let budgets = 'performance-budgets.json';
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    console.log(
      `${usage}\n\nCheck an Expo web export against the "frontendWeb" budgets in a budgets file\n(defaults: ${dist}, ${budgets}). Bloom's agent-avatar catalogue (its payloads and the\ncatalog/<kind>-<id> wrappers, all on demand) is measured on its own avatarCatalog* line and\nmust never be loaded by the first page. Exits 1 on any failure.`,
    );
    process.exit(0);
  } else if (arg.startsWith('--dist=')) dist = arg.slice('--dist='.length);
  else if (arg.startsWith('--budgets=')) budgets = arg.slice('--budgets='.length);
  else {
    console.error(`Unknown argument ${arg}\n${usage}`);
    process.exit(2);
  }
}

const { frontendWeb: budget } = JSON.parse(readFileSync(resolve(budgets), 'utf8'));
if (!budget) {
  console.error(`${budgets} has no "frontendWeb" budget.`);
  process.exit(1);
}
const { metrics, avatarChunksOnFirstPage } = measureWebExport(resolve(dist));
const failures = overBudget(metrics, budget);

// gzip sizes depend on the runtime's zlib (Bun's run ~0.7% above Node's): say which one measured.
const runtime = process.versions.bun
  ? `bun ${process.versions.bun}`
  : `node ${process.versions.node}`;
console.log(JSON.stringify({ runtime, metrics, budget }, null, 2));
for (const chunk of avatarChunksOnFirstPage) {
  console.error(`${chunk} is an avatar catalogue chunk loaded by the first page.`);
}
for (const [metric, limit] of failures) {
  console.error(`${metric} is ${metrics[metric]} bytes; budget ${limit} is ${budget[limit]}.`);
}
if (failures.length > 0 || avatarChunksOnFirstPage.length > 0) process.exit(1);
console.log('Web export is within its size budgets.');
