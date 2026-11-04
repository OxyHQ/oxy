#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const usage = 'Usage: oxy-emulator-preflight --serial emulator-<port>';
const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(usage);
  process.exit(0);
}

function fail(message) {
  console.error(`Emulator preflight failed: ${message}`);
  process.exit(1);
}

if (args.length !== 2 || args[0] !== '--serial' || !/^emulator-\d{4,5}$/.test(args[1] ?? '')) {
  fail(`an explicit emulator serial is required. ${usage}`);
}
const serial = args[1];

function adb(...arguments_) {
  const result = spawnSync('adb', arguments_, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1_000_000,
  });
  if (result.error || result.status !== 0) {
    fail(`adb ${arguments_[0]} failed or timed out`);
  }
  return result.stdout;
}

const lines = adb('devices', '-l').split(/\r?\n/);
if (!lines.some((line) => line.trim() === 'List of devices attached')) {
  fail('unrecognized adb devices output');
}
const matches = lines
  .map((line) => line.trim().split(/\s+/))
  .filter(([candidate]) => candidate === serial);
if (matches.length !== 1 || matches[0][1] !== 'device') {
  fail('the selected emulator must appear exactly once and be online');
}

// A serial-shaped name alone is not proof that adb is talking to an emulator.
// The console command is read-only and must return one AVD name followed by OK.
const reply = adb('-s', serial, 'emu', 'avd', 'name').trim().split(/\r?\n/);
if (reply.length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(reply[0]) || reply[1] !== 'OK') {
  fail('the selected device did not identify itself as an Android AVD');
}
console.log(serial);
