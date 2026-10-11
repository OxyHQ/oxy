#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { buildRenderContext } from './context';
import { renderTree } from './render';
import { resolveConfig, type CliArgs } from './prompts';
import { initGit } from './steps/git';
import { installDeps } from './steps/install';
import { registerOxyClient } from './steps/register';
import { printNextSteps } from './steps/nextSteps';

const HELP = `
${pc.bold('create-oxy-app')} — scaffold a new Oxy ecosystem app.

${pc.bold('Usage:')}
  bun create oxy-app [dir] [options]
  bunx create-oxy-app [dir] [options]

${pc.bold('Options:')}
  --name <name>        App display name
  --slug <slug>        Package/workspace slug (kebab-case)
  --scheme <scheme>    Expo URL scheme
  --bundle-id <id>     iOS/Android bundle identifier
  --domain <domain>    Backend API domain
  --no-backend         Skip the Express + Socket.IO backend
  --no-deploy          Skip the AWS deploy workflow
  --minimal            Skip the example authenticated screen
  --no-install         Do not run \`bun install\`
  --no-git             Do not initialize a git repository
  --no-register        Do not register an Oxy client
  -y, --yes            Accept all defaults (non-interactive)
  -h, --help           Show this help
`;

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      slug: { type: 'string' },
      scheme: { type: 'string' },
      'bundle-id': { type: 'string' },
      domain: { type: 'string' },
      'no-backend': { type: 'boolean' },
      'no-deploy': { type: 'boolean' },
      minimal: { type: 'boolean' },
      'no-install': { type: 'boolean' },
      'no-git': { type: 'boolean' },
      'no-register': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const args: CliArgs = {
    dir: positionals[0],
    name: values.name,
    slug: values.slug,
    scheme: values.scheme,
    bundleId: values['bundle-id'],
    domain: values.domain,
    backend: !values['no-backend'],
    deploy: !values['no-deploy'],
    minimal: Boolean(values.minimal),
    install: !values['no-install'],
    git: !values['no-git'],
    register: !values['no-register'],
    yes: Boolean(values.yes),
  };

  p.intro(pc.bgCyan(pc.black(' create-oxy-app ')));

  const config = await resolveConfig(args);

  if (await isNonEmptyDir(config.targetDir)) {
    p.cancel(`Target directory ${pc.cyan(config.targetDir)} already exists and is not empty.`);
    process.exit(1);
  }

  await fs.mkdir(config.targetDir, { recursive: true });

  const ctx = buildRenderContext(config);
  const templatesRoot = path.resolve(__dirname, '..', 'templates');

  await renderTree(path.join(templatesRoot, 'base'), config.targetDir, ctx);
  if (config.backend) {
    await renderTree(path.join(templatesRoot, 'backend'), config.targetDir, ctx);
  }
  if (config.deploy) {
    await renderTree(path.join(templatesRoot, 'deploy'), config.targetDir, ctx);
  }
  if (config.demo) {
    await renderTree(path.join(templatesRoot, 'demo'), config.targetDir, ctx);
  }

  p.log.success(`Created ${pc.bold(config.name)} in ${pc.cyan(config.targetDir)}`);

  initGit(config);
  const installed = installDeps(config);
  await registerOxyClient(config);
  printNextSteps(config, installed);
}

main().catch((error: unknown) => {
  p.log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
