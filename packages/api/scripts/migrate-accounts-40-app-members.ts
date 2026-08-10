#!/usr/bin/env bun
/**
 * Account migration — Phase 4: audit legacy application members.
 *
 * Reads the legacy `applicationmembers` collection and identifies memberships
 * that cannot be represented by the unified account-wide authorization model.
 *
 * A per-application grant must never be converted to an AccountMember on the
 * application's current owner: doing so grants access to every sibling app (and
 * potentially descendant accounts). Existing account members need no migration;
 * app-only members are reported for explicit project-account scoping and fail
 * closed in the meantime.
 *
 * NOTHING is deleted. Run Phases 0–3 first.
 *
 *   bun run packages/api/scripts/migrate-accounts-40-app-members.ts
 *   DRY_RUN=true  plan only
 */

import mongoose from 'mongoose';
import {
  connect,
  disconnect,
  isDryRun,
  rawDb,
} from './account-migration-lib';
import AccountMember from '../src/models/AccountMember';
import { logger } from '../src/utils/logger';

interface UnscopedMember {
  applicationId: string;
  ownerAccountId: string;
  memberUserId: string;
  appRole: string;
}

async function migrate(): Promise<void> {
  const dryRun = isDryRun();
  if (dryRun) logger.info('DRY RUN — no writes will be performed');

  const applications = rawDb().collection('applications');
  const appMembers = rawDb().collection('applicationmembers');

  const memberships = await appMembers.find({ status: 'active' }).toArray();
  logger.info('Active application memberships', { count: memberships.length });

  // Cache app → ownerAccountId.
  const ownerByApp = new Map<string, mongoose.Types.ObjectId>();
  const unscoped: UnscopedMember[] = [];

  let existingAccountMembers = 0;
  let skippedNoOwner = 0;

  for (const member of memberships) {
    const applicationId = member.applicationId as mongoose.Types.ObjectId;
    const memberUserId = member.userId as mongoose.Types.ObjectId;
    const appRole = (member.role as string) || 'viewer';
    if (!applicationId || !memberUserId) continue;

    const appKey = applicationId.toString();
    let ownerAccountId = ownerByApp.get(appKey) ?? null;
    if (!ownerAccountId) {
      const app = await applications.findOne(
        { _id: applicationId },
        { projection: { ownerAccountId: 1 } }
      );
      ownerAccountId = (app?.ownerAccountId as mongoose.Types.ObjectId | undefined) ?? null;
      if (ownerAccountId) ownerByApp.set(appKey, ownerAccountId);
    }

    if (!ownerAccountId) {
      skippedNoOwner += 1;
      logger.warn('Application member skipped (app has no ownerAccountId — run Phase 3)', {
        applicationId: appKey,
      });
      continue;
    }

    const existingAccountMember = await AccountMember.exists({
      accountId: ownerAccountId,
      memberUserId,
      status: 'active',
    });
    if (existingAccountMember) {
      existingAccountMembers += 1;
      continue;
    }

    unscoped.push({
      applicationId: appKey,
      ownerAccountId: ownerAccountId.toString(),
      memberUserId: memberUserId.toString(),
      appRole,
    });
  }

  logger.info('Phase 4 summary', {
    dryRun,
    memberships: memberships.length,
    existingAccountMembers,
    skippedNoOwner,
    unscopedCount: unscoped.length,
  });
  // eslint-disable-next-line no-console
  console.log('OXY_ACCOUNTS_UNSCOPED_APP_MEMBERS=' + JSON.stringify(unscoped));
}

async function main(): Promise<void> {
  await connect();
  try {
    await migrate();
  } finally {
    await disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(
      'Phase 4 (app-member audit) failed',
      error instanceof Error ? error : new Error(String(error)),
      { component: 'migrate-accounts-40' }
    );
    process.exit(1);
  });
