#!/usr/bin/env bun
/**
 * Add explicitly approved scopes to one existing service credential without
 * rotating or exposing its secret. The caller identifies the deployed public
 * key by SHA-256, so neither the key nor the secret is carried in ECS overrides.
 *
 * This script can only copy scopes the parent application already owns. The
 * canonical application seed remains the staff-controlled authority ceiling;
 * this operation merely brings a named deployment credential up to that ceiling.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import {
  APPLICATION_CREDENTIAL_ENVIRONMENTS,
  applicationCredentials,
  type ApplicationCredentialEnvironment,
} from '../src/db/schema/applicationCredentials';
import { applications } from '../src/db/schema/applications';
import { users } from '../src/db/schema/users';
import { APPLICATION_SCOPES, type ApplicationScope } from '../src/utils/applicationScopes';
import { isCredentialUsable } from '../src/utils/credentialUsability';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function environment(): ApplicationCredentialEnvironment {
  const value = process.env.ENVIRONMENT?.trim() || 'production';
  if (!APPLICATION_CREDENTIAL_ENVIRONMENTS.includes(value as ApplicationCredentialEnvironment)) {
    throw new Error(`ENVIRONMENT must be one of ${APPLICATION_CREDENTIAL_ENVIRONMENTS.join(', ')}`);
  }
  return value as ApplicationCredentialEnvironment;
}

function requestedScopes(): ApplicationScope[] {
  const values = [...new Set(required('ADD_SCOPES').split(',').map((value) => value.trim()).filter(Boolean))];
  const allowed = new Set<string>(APPLICATION_SCOPES);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length > 0) throw new Error(`ADD_SCOPES contains unknown scopes: ${invalid.join(', ')}`);
  return values as ApplicationScope[];
}

function fingerprint(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

async function main(): Promise<void> {
  const appName = required('APP_NAME');
  const ownerUsername = process.env.OWNER_USERNAME?.trim() || 'oxy';
  const credentialEnvironment = environment();
  const additions = requestedScopes();
  const expectedFingerprintHex = required('PUBLIC_KEY_SHA256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprintHex)) {
    throw new Error('PUBLIC_KEY_SHA256 must be a SHA-256 hex digest');
  }
  const expectedFingerprint = Buffer.from(expectedFingerprintHex, 'hex');
  const dryRun = process.env.DRY_RUN !== 'false';

  await connectPostgres();
  const db = getDb();
  const [owner] = await db.select({ id: users.id }).from(users)
    .where(eq(users.username, ownerUsername)).limit(1);
  if (!owner) throw new Error(`Owner user "${ownerUsername}" was not found`);

  const [application] = await db.select({
    id: applications.id,
    status: applications.status,
    scopes: applications.scopes,
  }).from(applications).where(and(
    eq(applications.name, appName),
    eq(applications.createdByUserId, owner.id),
    ne(applications.status, 'deleted'),
  )).limit(1);
  if (!application || application.status !== 'active') {
    throw new Error(`Active application "${appName}" owned by "${ownerUsername}" was not found`);
  }
  const missingFromApplication = additions.filter((scope) => !application.scopes.includes(scope));
  if (missingFromApplication.length > 0) {
    throw new Error(`Application authority must be reconciled first: ${missingFromApplication.join(', ')}`);
  }

  const candidates = await db.select().from(applicationCredentials).where(and(
    eq(applicationCredentials.applicationId, application.id),
    eq(applicationCredentials.type, 'service'),
    eq(applicationCredentials.environment, credentialEnvironment),
    ne(applicationCredentials.status, 'revoked'),
  ));
  const matches = candidates.filter((credential) => {
    const actual = fingerprint(credential.publicKey);
    return actual.length === expectedFingerprint.length
      && timingSafeEqual(actual, expectedFingerprint)
      && isCredentialUsable(credential);
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one usable matching service credential, found ${matches.length}`);
  }
  const credential = matches[0];
  if (!credential) throw new Error('Matched credential disappeared');

  // An empty credential scope list inherits the application's full live scope
  // set. Writing additions into it would accidentally NARROW existing authority.
  const desiredScopes = credential.scopes.length === 0
    ? []
    : [...new Set([...credential.scopes, ...additions])];
  const changed = desiredScopes.length !== credential.scopes.length;
  if (changed && !dryRun) {
    await db.update(applicationCredentials).set({
      scopes: desiredScopes,
      updatedAt: new Date(),
    }).where(eq(applicationCredentials.id, credential.id));
  }

  process.stdout.write(`SERVICE_AUTHORITY_JSON=${JSON.stringify({
    applicationId: application.id,
    credentialId: credential.id,
    environment: credentialEnvironment,
    inheritedApplicationScopes: credential.scopes.length === 0,
    addedScopes: changed ? additions.filter((scope) => !credential.scopes.includes(scope)) : [],
    resultingScopes: desiredScopes,
    changed,
    dryRun,
  })}\n`);
}

void main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => closePostgres());
