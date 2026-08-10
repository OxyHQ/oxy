/**
 * Shared helpers for the unified-Account data migration (`migrate-accounts-*.ts`).
 *
 * The migration transforms the legacy `workspaces` / `workspacemembers` /
 * `managedaccounts` / `applicationmembers` collections (whose Mongoose models
 * were removed in the clean cut) into the unified Account graph: tree fields on
 * `users`, membership rows in `accountmembers`, and `ownerAccountId` on
 * `applications`. Legacy collections are read RAW; new state is written via the
 * surviving models (so schema defaults/hooks run) or raw updates for in-place
 * field backfills.
 *
 * Every minted org account is recorded in an idempotency ledger
 * (`accountmigrations`) keyed by its source so re-runs reuse it (0 writes once
 * migrated). NOTHING is ever deleted.
 */

import mongoose from 'mongoose';
import { User } from '../src/models/User';
import AccountMember from '../src/models/AccountMember';
import {
  permissionsForAccountRole,
  type AccountRole,
} from '../src/utils/accountRoles';
import { logger } from '../src/utils/logger';

/** The production "Oxy" team workspace id (see AGENTS.md). */
export const OXY_WORKSPACE_ID = process.env.OXY_WORKSPACE_ID || '6a2f9d8989b795cfdfac350f';
/** The platform owner username that the Oxy org is minted under. */
export const OXY_USERNAME = process.env.OXY_USERNAME || 'oxy';
/** Display name of the minted Oxy organization account. */
export const OXY_ACCOUNT_NAME = process.env.OXY_ACCOUNT_NAME || 'Oxy';

export const LEDGER_COLLECTION = 'accountmigrations';

export function isDryRun(): boolean {
  return process.env.DRY_RUN === 'true';
}

/** Legacy ManagedAccount manager role → unified AccountRole. */
export function mapManagedRole(role: string): AccountRole {
  switch (role) {
    case 'owner':
      return 'owner';
    case 'admin':
      return 'admin';
    case 'editor':
      return 'editor';
    default:
      return 'editor';
  }
}

/** Legacy WorkspaceMember role → unified AccountRole. */
export function mapWorkspaceRole(role: string): AccountRole {
  switch (role) {
    case 'owner':
      return 'owner';
    case 'admin':
      return 'admin';
    case 'member':
      return 'editor';
    case 'viewer':
      return 'viewer';
    default:
      return 'viewer';
  }
}

/** Connect to MongoDB using `MONGODB_URI`, or exit. */
export async function connect(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    logger.error('MONGODB_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);
  logger.info('Connected to MongoDB');
}

export async function disconnect(): Promise<void> {
  await mongoose.connection.close();
  logger.info('MongoDB connection closed');
}

/** The raw Mongo db handle (for reading legacy collections). */
export function rawDb() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection is not established');
  }
  return db;
}

/** Look up the account previously minted for `source:sourceId`, if any. */
export async function findMintedAccount(
  source: 'workspace' | 'managed',
  sourceId: mongoose.Types.ObjectId
): Promise<mongoose.Types.ObjectId | null> {
  const row = await rawDb()
    .collection(LEDGER_COLLECTION)
    .findOne({ source, sourceId });
  return (row?.accountId as mongoose.Types.ObjectId | undefined) ?? null;
}

/** Record (idempotently) that `accountId` was minted for `source:sourceId`. */
export async function recordMintedAccount(
  source: 'workspace' | 'managed',
  sourceId: mongoose.Types.ObjectId,
  accountId: mongoose.Types.ObjectId
): Promise<void> {
  await rawDb()
    .collection(LEDGER_COLLECTION)
    .updateOne(
      { source, sourceId },
      { $set: { source, sourceId, accountId, updatedAt: new Date() } },
      { upsert: true }
    );
}

/**
 * Resolve a unique `username`, suffixing a numeric counter on collision against
 * the existing `users` collection. Returns the bare base when free.
 */
export async function allocateUsername(base: string): Promise<string> {
  const normalized = base.trim().toLowerCase().replace(/[^\w.-]/g, '') || 'account';
  let candidate = normalized;
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const taken = await User.findOne({ username: candidate }).select('_id').lean();
    if (!taken) {
      return candidate;
    }
    candidate = `${normalized}${suffix}`;
  }
  return `${normalized}-${new mongoose.Types.ObjectId().toString().slice(-6)}`;
}

/**
 * Ensure an active AccountMember row for (`accountId`, `memberUserId`) carrying
 * at least `role`. Idempotent: a pre-existing active row is left untouched
 * (never downgraded). Returns whether a write occurred.
 */
export async function ensureMember(
  accountId: mongoose.Types.ObjectId,
  memberUserId: mongoose.Types.ObjectId,
  role: AccountRole,
  invitedByUserId: mongoose.Types.ObjectId | undefined,
  dryRun: boolean
): Promise<boolean> {
  const existing = await AccountMember.findOne({ accountId, memberUserId });
  if (existing) {
    if (existing.status === 'active') {
      return false;
    }
    if (!dryRun) {
      existing.status = 'active';
      existing.role = role;
      existing.permissions = permissionsForAccountRole(role);
      existing.joinedAt = existing.joinedAt ?? new Date();
      await existing.save();
    }
    return true;
  }
  if (!dryRun) {
    await AccountMember.create({
      accountId,
      memberUserId,
      role,
      permissions: permissionsForAccountRole(role),
      inherit: true,
      status: 'active',
      invitedByUserId,
      joinedAt: new Date(),
    });
  }
  return true;
}
