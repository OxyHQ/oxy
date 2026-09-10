#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const gate = join(repo, 'scripts/check-inbox-daily-brief.mjs');
const files = [
  'packages/api/src/routes/inboxInference.ts',
  'packages/api/src/services/inboxDailyBrief.service.ts',
  'packages/contracts/src/inference/inbox.ts',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oxy-inbox-daily-brief-gate-'));
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repo, file), target);
  }
  return root;
}

function mutate(root, file, from, to) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf8');
  assert.ok(source.includes(from), `${file}: mutation anchor is present`);
  writeFileSync(path, source.replace(from, to));
}

function verdict(root, expected) {
  const result = spawnSync(process.execPath, [gate], {
    cwd: repo,
    env: { ...process.env, INBOX_DAILY_BRIEF_GATE_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(result.status, expected, result.stderr || result.stdout);
}

const roots = [];
try {
  const clean = fixture();
  roots.push(clean);
  verdict(clean, 0);

  const sampled = fixture();
  roots.push(sampled);
  mutate(
    sampled,
    'packages/api/src/services/inboxDailyBrief.service.ts',
    '    .from(messages)\n    .where(and(',
    '    .from(messages)\n    .limit(100)\n    .where(and(',
  );
  verdict(sampled, 1);

  const privateProjection = fixture();
  roots.push(privateProjection);
  mutate(
    privateProjection,
    'packages/api/src/services/inboxDailyBrief.service.ts',
    '    .select({\n      total:',
    '    .select({\n      subject: messages.subject,\n      total:',
  );
  verdict(privateProjection, 1);

  const crossAccount = fixture();
  roots.push(crossAccount);
  mutate(
    crossAccount,
    'packages/api/src/services/inboxDailyBrief.service.ts',
    '      eq(messages.userId, userId),',
    '      eq(messages.userId, "somebody-else"),',
  );
  verdict(crossAccount, 1);

  const inclusiveEnd = fixture();
  roots.push(inclusiveEnd);
  mutate(
    inclusiveEnd,
    'packages/api/src/services/inboxDailyBrief.service.ts',
    '      lt(messages.date, endAt),',
    '      lte(messages.date, endAt),',
  );
  verdict(inclusiveEnd, 1);

  const multiplyingAttachment = fixture();
  roots.push(multiplyingAttachment);
  mutate(
    multiplyingAttachment,
    'packages/api/src/services/inboxDailyBrief.service.ts',
    '.where(eq(messageAttachments.messageId, messages.id));',
    '.where(eq(messageAttachments.id, messages.id));',
  );
  verdict(multiplyingAttachment, 1);

  const restoredPage = fixture();
  roots.push(restoredPage);
  mutate(
    restoredPage,
    'packages/api/src/routes/inboxInference.ts',
    '  const body = request.body as InboxDailyBriefRequest;',
    '  await emailService.listMessages(userId(request), null, { limit: 100 });\n  const body = request.body as InboxDailyBriefRequest;',
  );
  verdict(restoredPage, 1);

  const twentyTwoHours = fixture();
  roots.push(twentyTwoHours);
  mutate(
    twentyTwoHours,
    'packages/contracts/src/inference/inbox.ts',
    'const DAILY_BRIEF_MIN_WINDOW_MS = 23 * 60 * 60 * 1_000;',
    'const DAILY_BRIEF_MIN_WINDOW_MS = 22 * 60 * 60 * 1_000;',
  );
  verdict(twentyTwoHours, 1);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('Inbox Daily Brief gate mutation tests passed.\n');
