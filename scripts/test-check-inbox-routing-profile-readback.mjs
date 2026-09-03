#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.cwd();
const gate = join(repo, "scripts/check-inbox-routing-profile-readback.mjs");
const files = [
  ".github/workflows/inbox-routing-profile-readback.yml",
  "packages/api/scripts/readback-inbox-routing-profile.ts",
  "packages/api/src/scripts/inboxRoutingProfileReadback.ts",
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oxy-inbox-routing-readback-gate-"));
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repo, file), target);
  }
  return root;
}

function mutate(root, file, from, to) {
  const path = join(root, file);
  const source = readFileSync(path, "utf8");
  assert.ok(
    source.includes(from),
    `${file} fixture no longer contains mutation anchor`,
  );
  writeFileSync(path, source.replace(from, to));
}

function verdict(root, expected) {
  const result = spawnSync(process.execPath, [gate], {
    cwd: repo,
    env: { ...process.env, INBOX_ROUTING_READBACK_GATE_ROOT: root },
    encoding: "utf8",
  });
  assert.equal(result.status, expected, result.stderr || result.stdout);
}

const roots = [];
try {
  const clean = fixture();
  roots.push(clean);
  verdict(clean, 0);

  const writableTransaction = fixture();
  roots.push(writableTransaction);
  mutate(
    writableTransaction,
    "packages/api/scripts/readback-inbox-routing-profile.ts",
    "await tx.execute(sql`set transaction read only`);",
    "await tx.execute(sql`select 1`);",
  );
  verdict(writableTransaction, 1);

  const slugLookup = fixture();
  roots.push(slugLookup);
  mutate(
    slugLookup,
    "packages/api/scripts/readback-inbox-routing-profile.ts",
    ".where(eq(inferenceRoutingProfiles.id, requestedRoutingProfileId));",
    ".where(eq(inferenceRoutingProfiles.slug, requestedRoutingProfileId));",
  );
  verdict(slugLookup, 1);

  const nameLookup = fixture();
  roots.push(nameLookup);
  mutate(
    nameLookup,
    "packages/api/scripts/readback-inbox-routing-profile.ts",
    ".where(eq(inferenceRoutingProfiles.id, requestedRoutingProfileId));",
    ".where(eq(inferenceRoutingProfiles.displayName, requestedRoutingProfileId));",
  );
  verdict(nameLookup, 1);

  const firstOrderedRow = fixture();
  roots.push(firstOrderedRow);
  mutate(
    firstOrderedRow,
    "packages/api/scripts/readback-inbox-routing-profile.ts",
    "        .from(inferenceRoutingProfiles)\n        .where(",
    "        .from(inferenceRoutingProfiles)\n        .orderBy(inferenceRoutingProfiles.slug)\n        .limit(1)\n        .where(",
  );
  verdict(firstOrderedRow, 1);

  const candidateNameLookup = fixture();
  roots.push(candidateNameLookup);
  mutate(
    candidateNameLookup,
    "packages/api/scripts/readback-inbox-routing-profile.ts",
    "inferenceRoutingProfileCandidates.routingProfileId,\n            requestedRoutingProfileId,",
    "inferenceModels.slug,\n            requestedRoutingProfileId,",
  );
  verdict(candidateNameLookup, 1);

  const databaseWrite = fixture();
  roots.push(databaseWrite);
  mutate(
    databaseWrite,
    "packages/api/scripts/readback-inbox-routing-profile.ts",
    "      const profiles = await tx",
    "      await tx.delete(inferenceRoutingProfiles);\n      const profiles = await tx",
  );
  verdict(databaseWrite, 1);

  const extraSecret = fixture();
  roots.push(extraSecret);
  mutate(
    extraSecret,
    ".github/workflows/inbox-routing-profile-readback.yml",
    ".secrets = [$database_secret]",
    '.secrets = [$database_secret, {name:"REDIS_URL",valueFrom:"unsafe"}]',
  );
  verdict(extraSecret, 1);

  const productionFamily = fixture();
  roots.push(productionFamily);
  mutate(
    productionFamily,
    ".github/workflows/inbox-routing-profile-readback.yml",
    '.family = "oxy-oxy-api-inbox-routing-readback"',
    '.family = "oxy-oxy-api"',
  );
  verdict(productionFamily, 1);

  const unpinnedImage = fixture();
  roots.push(unpinnedImage);
  mutate(
    unpinnedImage,
    ".github/workflows/inbox-routing-profile-readback.yml",
    "oxy-api@$EXPECTED_LIVE_IMAGE_DIGEST",
    "oxy-api:latest",
  );
  verdict(unpinnedImage, 1);

  const weakenedMetadata = fixture();
  roots.push(weakenedMetadata);
  mutate(
    weakenedMetadata,
    "packages/api/src/scripts/inboxRoutingProfileReadback.ts",
    "profile.optimiseFor !== expected.optimiseFor",
    "false",
  );
  verdict(weakenedMetadata, 1);

  const weakenedCandidate = fixture();
  roots.push(weakenedCandidate);
  mutate(
    weakenedCandidate,
    "packages/api/src/scripts/inboxRoutingProfileReadback.ts",
    "candidate.priority !== expected.candidate.priority",
    "false",
  );
  verdict(weakenedCandidate, 1);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  "Inbox routing-profile readback gate mutation tests passed.\n",
);
