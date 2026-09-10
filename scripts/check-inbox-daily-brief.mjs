#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.INBOX_DAILY_BRIEF_GATE_ROOT ?? process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const route = read('packages/api/src/routes/inboxInference.ts');
const service = read('packages/api/src/services/inboxDailyBrief.service.ts');
const contract = read('packages/contracts/src/inference/inbox.ts');

const failures = [];
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message);
};
const requireText = (source, expected, message) => {
  if (!source.includes(expected)) failures.push(message);
};
const forbid = (source, pattern, message) => {
  if (pattern.test(source)) failures.push(message);
};

const dailyBriefStart = route.indexOf("router.post('/daily-brief'");
const dailyBriefEnd = route.indexOf("router.post('/natural-search'");
if (dailyBriefStart < 0 || dailyBriefEnd <= dailyBriefStart) {
  failures.push('the gate could not isolate the Daily Brief route from the real router');
}
const dailyBriefRoute = route.slice(dailyBriefStart, dailyBriefEnd);

requireMatch(
  dailyBriefRoute,
  /const body = request\.body as InboxDailyBriefRequest;[\s\S]*?getInboxDailyBriefCounts\(\s*userId\(request\),\s*new Date\(body\.startAt\),\s*new Date\(body\.endAt\),\s*\)/,
  'the Daily Brief route must pass the validated client UTC bounds to the exact aggregate',
);
forbid(
  dailyBriefRoute,
  /listMessages\s*\(/,
  'the Daily Brief route must never restore a paginated message sample',
);
forbid(
  dailyBriefRoute,
  /recent:\s*recent\.|recent\.data/,
  'the Daily Brief prompt must contain no sampled recent count or message rows',
);

for (const [fragment, name] of [
  ['total: sql<number>`count(*)::int`', 'total'],
  ['unread: sql<number>`count(*) filter (where not ${messages.seen})::int`', 'unread'],
  ['starred: sql<number>`count(*) filter (where ${messages.starred})::int`', 'starred'],
  ['withAttachments: sql<number>`count(*) filter (where ${exists(attachmentRows)})::int`', 'withAttachments'],
]) {
  requireText(
    service,
    fragment,
    `the service must project the ${name} count from PostgreSQL`,
  );
}
requireMatch(
  service,
  /\.select\(\{ one: sql`1` \}\)\s*\.from\(messageAttachments\)\s*\.where\(eq\(messageAttachments\.messageId, messages\.id\)\)/,
  'withAttachments must use a correlated EXISTS so attachment fan-out cannot multiply messages',
);
requireMatch(
  service,
  /\.where\(and\(\s*eq\(messages\.userId, userId\),\s*gte\(messages\.date, startAt\),\s*lt\(messages\.date, endAt\),\s*\)\)/,
  'the aggregate must stay account-scoped and use the exact half-open [startAt, endAt) interval',
);
forbid(
  service,
  /messages\.(?:text|html|headers|encryptedBody|fromName|fromAddress|replyToName|replyToAddress|subject|searchVector)|messageAttachments\.(?:name|contentType|fileId|size|contentId|isInline)/,
  'the Daily Brief aggregate must not read message content, sender, subject or attachment metadata',
);
forbid(
  service,
  /\.select\(\s*\)|\.limit\(|\.offset\(|\.orderBy\(|\.(?:left|right|inner|full)Join\(/,
  'the Daily Brief aggregate must not select rows, paginate, order or multiply them through a join',
);

requireMatch(
  contract,
  /const DAILY_BRIEF_MIN_WINDOW_MS = 23 \* 60 \* 60 \* 1_000;[\s\S]*?const DAILY_BRIEF_MAX_WINDOW_MS = 25 \* 60 \* 60 \* 1_000;/,
  'the contract must admit only one reasonable local day, including 23h/25h DST days',
);
requireMatch(
  contract,
  /startAt: inboxUtcTimestampSchema,\s*endAt: inboxUtcTimestampSchema,\s*stream: z\.boolean\(\)\.optional\(\),/,
  'startAt and endAt must be required UTC timestamp fields while stream stays optional',
);
requireMatch(
  contract,
  /!Number\.isFinite\(durationMs\) \|\| durationMs <= 0[\s\S]*?durationMs < DAILY_BRIEF_MIN_WINDOW_MS \|\| durationMs > DAILY_BRIEF_MAX_WINDOW_MS/,
  'the request contract must fail closed on reversed and unreasonable windows',
);

if (failures.length > 0) {
  process.stderr.write(`Inbox Daily Brief gate failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(
  'Inbox Daily Brief stays client-day-bounded, exact-count, account-scoped and metadata-only.\n',
);
