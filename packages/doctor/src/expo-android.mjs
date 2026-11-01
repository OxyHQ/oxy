#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const usage = 'oxy-doctor-expo-android [--project-root=PATH] [--require-source=NAME.kt ...]';
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(
    `${usage}\n\nCheck Expo Android autolinking for the installed Oxy device-session module.`,
  );
  process.exit(0);
}
try {
  let root;
  const requiredSources = new Set(['OxyDeviceSessionModule.kt']);
  for (const arg of args) {
    if (arg.startsWith('--project-root=') && root === undefined) {
      root = arg.slice('--project-root='.length);
      if (!root) throw new Error('project root must not be empty');
    } else if (arg.startsWith('--require-source=')) {
      const source = arg.slice('--require-source='.length);
      if (!/^[A-Za-z][A-Za-z0-9_]*\.kt$/.test(source)) {
        throw new Error('required source must be a Kotlin filename');
      }
      requiredSources.add(source);
    } else {
      throw new Error(`invalid argument: ${arg}`);
    }
  }
  const projectRoot = resolve(root ?? process.cwd());
  const projectRequire = createRequire(join(projectRoot, 'package.json'));
  const manifestPath = projectRequire.resolve('@oxy.so/services/package.json');
  const services = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    services.name !== '@oxy.so/services' ||
    typeof services.version !== 'string' ||
    !services.version
  ) {
    throw new Error('installed Oxy Services manifest is invalid');
  }
  const autolinking = projectRequire.resolve('expo-modules-autolinking/package.json');
  const cli = join(dirname(autolinking), 'bin/expo-modules-autolinking.js');
  let output;
  try {
    output = execFileSync(
      process.execPath,
      [cli, 'resolve', '--platform', 'android', '--project-root', projectRoot, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    throw new Error('Expo Android autolinking failed');
  }
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error('invalid Expo autolinking result');
  }
  if (!Array.isArray(result?.modules)) throw new Error('invalid Expo autolinking result');
  const matches = result.modules.filter((entry) => entry?.packageName === '@oxy.so/services');
  if (matches.length !== 1 || matches[0].packageVersion !== services.version) {
    throw new Error('Android autolinking must resolve exactly the installed Oxy Services version');
  }
  if (!Array.isArray(matches[0].projects)) throw new Error('invalid Oxy Services project list');
  const projects = matches[0].projects.filter(
    (project) =>
      Array.isArray(project?.modules) &&
      project.modules.some(
        (module) => module?.classifier === 'so.oxy.devicesession.OxyDeviceSessionModule',
      ),
  );
  if (
    projects.length !== 1 ||
    projects[0].modules.filter(
      (module) => module?.classifier === 'so.oxy.devicesession.OxyDeviceSessionModule',
    ).length !== 1
  )
    throw new Error('Android autolinking must include exactly one OxyDeviceSessionModule');
  const nativeDir = join(dirname(manifestPath), 'android');
  if (realpathSync(projects[0].sourceDir) !== realpathSync(nativeDir)) {
    throw new Error('OxyDeviceSessionModule must come from the installed Oxy Services package');
  }
  for (const source of requiredSources) {
    if (!existsSync(join(nativeDir, 'src/main/java/so/oxy/devicesession', source))) {
      throw new Error(`installed Oxy Services is missing Android source ${source}`);
    }
  }
  console.log(
    `Android autolinking includes OxyDeviceSessionModule from Oxy Services ${services.version}.`,
  );
} catch (error) {
  console.error(
    `Oxy Android check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
