#!/usr/bin/env node
import { resolve } from 'node:path';
import { DEFAULT_SOURCE_LOCALE, inspectTranslations } from './i18n.mjs';

const usage = 'oxy-doctor-i18n [--root=PATH] [--source=LOCALE] [--ci] [--json]';
const SHOWN_PER_RULE = 10;

/** `Map.groupBy`, which Node 20 (the engines floor) lacks. */
function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

let root = process.cwd();
let source = DEFAULT_SOURCE_LOCALE;
let ci = false;
let json = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    console.log(
      `${usage}\n\nCheck every translation catalog (locales/<lang>.json or locales/<lang>/*.json)\nagainst the Oxy key convention. --ci exits 1 on errors; warnings never fail.`,
    );
    process.exit(0);
  } else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
  else if (arg.startsWith('--source=')) source = arg.slice('--source='.length);
  else if (arg === '--ci') ci = true;
  else if (arg === '--json') json = true;
  else {
    console.error(`invalid argument: ${arg}\n${usage}`);
    process.exit(2);
  }
}

let catalogs;
try {
  catalogs = await inspectTranslations(resolve(root), source);
} catch (error) {
  console.error(`oxy-doctor-i18n: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const errorCount = catalogs.reduce((sum, catalog) => sum + catalog.errors.length, 0);
if (json) {
  console.log(JSON.stringify({ catalogs, errorCount }, null, 2));
} else if (catalogs.length === 0) {
  console.log(`No translation catalogs with a ${source} source found.`);
} else {
  for (const catalog of catalogs) {
    console.log(
      `${catalog.directory} (${catalog.layout}, ${catalog.locales.length} locales): ${catalog.errors.length} errors, ${catalog.warnings.length} warnings`,
    );
    const byRule = groupBy(catalog.errors, (issue) => issue.rule);
    for (const [rule, issues] of byRule) {
      console.log(`  error ${rule} (${issues.length})`);
      for (const issue of issues.slice(0, SHOWN_PER_RULE)) {
        console.log(`    ${issue.locale}: ${JSON.stringify(issue.key)} — ${issue.message}`);
      }
      if (issues.length > SHOWN_PER_RULE) {
        console.log(`    … ${issues.length - SHOWN_PER_RULE} more`);
      }
    }
    const warnings = groupBy(catalog.warnings, (issue) => issue.rule);
    for (const [rule, issues] of warnings) {
      const perLocale = groupBy(issues, (issue) => issue.locale);
      console.log(
        `  warning ${rule}: ${[...perLocale].map(([locale, list]) => `${locale} ${list.length}`).join(', ')}`,
      );
    }
  }
}
process.exit(ci && errorCount > 0 ? 1 : 0);
