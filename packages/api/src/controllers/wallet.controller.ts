import type { Response } from 'express';
import { and, count, desc, eq, getTableColumns, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth';
import { type DatabaseOrTransaction, getDb } from '../config/postgres';
import { transactions as transactionsTable } from '../db/schema/transactions';
import { users } from '../db/schema/users';
import { wallets } from '../db/schema/wallets';
import { logger } from '../utils/logger';
import { validatePagination } from '../utils/validation';
import { sendSuccess, sendPaginated } from '../utils/asyncHandler';
import { BadRequestError, NotFoundError, ForbiddenError, UnauthorizedError, InternalServerError } from '../utils/error';
import { TRANSACTION } from '../utils/constants';

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const TRANSFER_SCHEMA = z.object({
  fromUserId: z.string().min(1, 'From user ID is required'),
  toUserId: z.string().min(1, 'To user ID is required'),
  amount: z.number().positive('Amount must be positive'),
  description: z.string().optional(),
});

const WITHDRAWAL_SCHEMA = z.object({
  userId: z.string().min(1, 'User ID is required'),
  amount: z.number().positive('Amount must be positive'),
  address: z.string().min(1, 'Address is required'),
});

const PURCHASE_SCHEMA = z.object({
  userId: z.string().min(1, 'User ID is required'),
  amount: z.number().positive('Amount must be positive'),
  itemId: z.string().min(1, 'Item ID is required'),
  itemType: z.string().min(1, 'Item type is required'),
  description: z.string().optional(),
});

// =============================================================================
// MONEY — reading, writing and spending a `numeric` balance
// =============================================================================

/**
 * `wallets.balance` and `transactions.amount` are `numeric(38, 8)` and
 * postgres.js hands them back as STRINGS, deliberately: parsing one into a
 * double re-introduces exactly the representation error the column type exists
 * to remove.
 *
 * This function is the ONE place that conversion is allowed, and it is the
 * SERIALIZATION boundary — the wire has always carried these as JSON numbers
 * (`Wallet.balance: number`, `WalletTransaction.amount: number` in
 * `@oxyhq/services`), so emitting a string would be the wire change. Nothing
 * computes with the result; every sum, difference and comparison below happens
 * in SQL, on the exact decimal value.
 */
function toWireAmount(value: string): number {
  return Number(value);
}

/**
 * Bind a caller-supplied amount as an exact `numeric`.
 *
 * The value arrives as a JSON number, so it is stringified rather than bound as
 * a float: `numeric` parses the decimal text exactly, while a float binding
 * would round-trip through a double on the way in and defeat the column type at
 * the only point where the value is still authoritative.
 */
function amountParam(amount: number) {
  return sql`${String(amount)}::numeric`;
}

/**
 * The account's wallet, created empty on first touch.
 *
 * `getWallet` created a wallet on read and the three spend paths each created
 * one before checking funds, so a wallet has always been implicit rather than
 * provisioned. `onConflictDoNothing` keeps that safe against two concurrent
 * first touches: the loser writes nothing instead of raising a duplicate-key
 * error, and the follow-up SELECT sees the row the winner committed.
 */
async function ensureWallet(
  db: DatabaseOrTransaction,
  userId: string
): Promise<typeof wallets.$inferSelect> {
  const [inserted] = await db
    .insert(wallets)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  const [existing] = await db.select().from(wallets).where(eq(wallets.userId, userId));
  return existing;
}

/**
 * Debit a wallet, refusing rather than overdrawing.
 *
 * **This is the whole point of the money port.** Every spend path used to read
 * the balance, compare it in JavaScript, and then write the difference back —
 * a read-modify-write, so two concurrent spends both read the same balance, both
 * decided they could afford it, and both wrote. The guard now travels INTO the
 * statement: under READ COMMITTED a concurrent `UPDATE` on the same row blocks
 * on the row lock and then RE-EVALUATES its `WHERE` against the committed new
 * version, so the loser matches nothing. Same mechanism, and the same reasoning,
 * as `db/credits.ts`.
 *
 * `wallets_balance_check` (`balance >= 0`) is the second line, for any future
 * write path that forgets this one.
 *
 * @returns Whether the debit applied. `false` means insufficient funds and
 *   NOTHING was moved — the guard is part of the same statement.
 */
async function debitWallet(
  db: DatabaseOrTransaction,
  userId: string,
  amount: number
): Promise<boolean> {
  const [row] = await db
    .update(wallets)
    .set({ balance: sql`${wallets.balance} - ${amountParam(amount)}` })
    .where(and(eq(wallets.userId, userId), sql`${wallets.balance} >= ${amountParam(amount)}`))
    .returning({ userId: wallets.userId });

  return row !== undefined;
}

// =============================================================================
// WIRE SHAPES
// =============================================================================

/**
 * A ledger party as the transaction endpoints emit it.
 *
 * Mongoose `populate('userId', 'username')` replaced the id with
 * `{ _id, username }`, and `WalletTransaction` in `@oxyhq/services` models both
 * that object and a bare id string. The populated object is reproduced here with
 * a join rather than narrowed to the id: no consumer in this repo reads
 * `.username`, but this is a published API and the contract for endpoints this
 * port touches is parity, not "parity with the consumers we can enumerate".
 *
 * `null` matches what populate produced when the referenced account was gone.
 */
interface LedgerParty {
  _id: string;
  /** Omitted, not `null`, when the account has no username — as populate did. */
  username?: string;
}

interface TransactionResponse {
  id: string;
  userId: LedgerParty | string;
  type: (typeof transactionsTable.$inferSelect)['type'];
  amount: number;
  status: (typeof transactionsTable.$inferSelect)['status'];
  description: string | null;
  recipientId: LedgerParty | null;
  itemId: string | null;
  itemType: string | null;
  /** The row's `createdAt`, under the name the wire has always used. */
  timestamp: Date;
  completedAt: Date | null;
}

/** The three fields every write path echoes back after committing. */
interface TransactionReceipt {
  id: string;
  type: (typeof transactionsTable.$inferSelect)['type'];
  amount: number;
  status: (typeof transactionsTable.$inferSelect)['status'];
  timestamp: Date;
}

type TransactionRow = typeof transactionsTable.$inferSelect;

function toReceipt(row: TransactionRow): TransactionReceipt {
  return {
    id: row.id,
    type: row.type,
    amount: toWireAmount(row.amount),
    status: row.status,
    timestamp: row.createdAt,
  };
}

/**
 * A joined row → the populated wire shape.
 *
 * The two party columns are joined separately because a transfer's payer and
 * payee are different accounts; `recipient` is null both when the movement had
 * no counterparty and when the counterparty's account is gone, which is exactly
 * what populate did.
 */
function toTransactionResponse(
  row: TransactionRow,
  payer: LedgerParty | null,
  recipient: LedgerParty | null
): TransactionResponse {
  return {
    id: row.id,
    // `user_id` is NOT NULL with a RESTRICT foreign key, so the payer always
    // resolves; the bare-id arm exists only so a row can still be served if that
    // invariant is ever violated out of band.
    userId: payer ?? row.userId,
    type: row.type,
    amount: toWireAmount(row.amount),
    status: row.status,
    description: row.description,
    recipientId: recipient,
    itemId: row.itemId,
    itemType: row.itemType,
    timestamp: row.createdAt,
    completedAt: row.completedAt,
  };
}

/** The two `users` aliases a single ledger row needs: it references two accounts. */
const payerAccount = alias(users, 'payer_account');
const recipientAccount = alias(users, 'recipient_account');

/** Assemble a joined pair of columns into the populated shape, or `null`. */
function toLedgerParty(id: string | null, username: string | null): LedgerParty | null {
  if (id === null) return null;
  return username === null ? { _id: id } : { _id: id, username };
}

/**
 * `transactions` joined to both party accounts — the replacement for
 * `.populate('userId', 'username').populate('recipientId', 'username')`.
 *
 * Only `id` and `username` are taken from each alias. Never the whole `users`
 * row: that would pull every protected column into a serializer, which is the
 * failure `schema/protectedColumns.ts` exists to make impossible.
 *
 * Both joins are LEFT, so a row still serves when a party account is absent —
 * populate returned `null` in exactly that case.
 */
function selectTransactions(db: DatabaseOrTransaction) {
  return db
    .select({
      transaction: getTableColumns(transactionsTable),
      payerId: payerAccount.id,
      payerUsername: payerAccount.username,
      recipientAccountId: recipientAccount.id,
      recipientUsername: recipientAccount.username,
    })
    .from(transactionsTable)
    .leftJoin(payerAccount, eq(payerAccount.id, transactionsTable.userId))
    .leftJoin(recipientAccount, eq(recipientAccount.id, transactionsTable.recipientId));
}

/** Existence check plus the username the transfer description needs. */
async function selectAccount(
  db: DatabaseOrTransaction,
  userId: string
): Promise<{ id: string; username: string | null } | undefined> {
  const [row] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Checks if the requesting user has permission to access a resource.
 * Currently only allows self-access. Extend with proper RBAC when admin roles are implemented.
 */
function hasPermission(requestingUserId: string, resourceUserId: string): boolean {
  return requestingUserId === resourceUserId;
}

// =============================================================================
// CONTROLLER FUNCTIONS
// =============================================================================

/**
 * Retrieves wallet information for a user
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const getWallet = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;

    // Validate user authentication
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    // Check permissions
    const hasAccess = hasPermission(req.user._id.toString(), userId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have permission to view this wallet');
    }

    const wallet = await ensureWallet(getDb(), userId);

    sendSuccess(res, {
      userId,
      balance: toWireAmount(wallet.balance),
      address: wallet.address || null,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof BadRequestError || error instanceof ForbiddenError) {
      throw error;
    }
    logger.error('Error fetching wallet', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Server error when fetching wallet');
  }
};

/**
 * Retrieves transaction history for a user
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const getTransactionHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const { limit: parsedLimit, offset: parsedOffset } = validatePagination(
      req.query.limit,
      req.query.offset,
      TRANSACTION.MAX_LIMIT,
      TRANSACTION.DEFAULT_LIMIT
    );

    // Validate user authentication
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    // Check permissions
    const hasAccess = hasPermission(req.user._id.toString(), userId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have permission to view these transactions');
    }

    // Either side of the ledger — the Mongo `$or` on `userId` / `recipientId`.
    const partyFilter = or(
      eq(transactionsTable.userId, userId),
      eq(transactionsTable.recipientId, userId)
    );

    const db = getDb();
    const [rows, [totals]] = await Promise.all([
      selectTransactions(db).where(partyFilter)
        .orderBy(desc(transactionsTable.createdAt))
        .limit(parsedLimit)
        .offset(parsedOffset),
      db.select({ value: count() }).from(transactionsTable).where(partyFilter),
    ]);

    const formattedTransactions = rows.map((row) =>
      toTransactionResponse(
        row.transaction,
        toLedgerParty(row.payerId, row.payerUsername),
        toLedgerParty(row.recipientAccountId, row.recipientUsername)
      )
    );

    sendPaginated(res, formattedTransactions, totals.value, parsedLimit, parsedOffset);
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof BadRequestError || error instanceof ForbiddenError) {
      throw error;
    }
    logger.error('Error fetching transaction history', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Server error when fetching transaction history');
  }
};

/**
 * Transfers funds between users
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const transferFunds = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const validatedData = TRANSFER_SCHEMA.parse(req.body);
    const { fromUserId, toUserId, amount, description } = validatedData;

    // Validate user authentication
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    // Prevent self-transfer
    if (fromUserId === toUserId) {
      throw new BadRequestError('Cannot transfer funds to the same user');
    }

    // Check permissions
    const hasAccess = hasPermission(req.user._id.toString(), fromUserId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have permission to transfer from this account');
    }

    const receipt = await getDb().transaction(async (tx) => {
      // Verify both users exist. `transactions.user_id` / `recipient_id` are
      // RESTRICT foreign keys, so a missing account would fail the insert
      // anyway — this is what turns that into the 404 the endpoint documents,
      // and it supplies the recipient's username for the default description.
      const [fromUser, toUser] = await Promise.all([
        selectAccount(tx, fromUserId),
        selectAccount(tx, toUserId),
      ]);
      if (!fromUser || !toUser) {
        throw new NotFoundError(!fromUser ? 'Sender user not found' : 'Recipient user not found');
      }

      await ensureWallet(tx, fromUserId);
      await ensureWallet(tx, toUserId);

      // The two wallet rows are touched in a DETERMINISTIC order — lowest
      // account id first — so A→B and B→A running concurrently can never each
      // hold the row the other needs. Ordering costs nothing here because both
      // statements are inside ONE transaction: if the guarded debit runs second
      // and refuses, the credit that ran first rolls back with it.
      const debitFirst = fromUserId < toUserId;
      let debited = true;
      const debit = async () => {
        debited = await debitWallet(tx, fromUserId, amount);
      };
      const credit = async () => {
        await tx
          .update(wallets)
          .set({ balance: sql`${wallets.balance} + ${amountParam(amount)}` })
          .where(eq(wallets.userId, toUserId));
      };

      if (debitFirst) {
        await debit();
        // Nothing to credit if the payer could not pay.
        if (!debited) throw new BadRequestError('Insufficient funds');
        await credit();
      } else {
        await credit();
        await debit();
        if (!debited) throw new BadRequestError('Insufficient funds');
      }

      const [transaction] = await tx
        .insert(transactionsTable)
        .values({
          userId: fromUserId,
          recipientId: toUserId,
          type: 'transfer',
          amount: String(amount),
          status: 'completed',
          description: description || `Transfer to ${toUser.username}`,
          completedAt: new Date(),
        })
        .returning();

      return toReceipt(transaction);
    });

    sendSuccess(res, {
      message: 'Transfer completed successfully',
      transaction: receipt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new BadRequestError('Invalid transfer data', { errors: error.errors });
    }
    if (error instanceof UnauthorizedError || error instanceof BadRequestError ||
        error instanceof ForbiddenError || error instanceof NotFoundError) {
      throw error;
    }

    logger.error('Error processing transfer', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Server error when processing transfer');
  }
};

/**
 * Processes a purchase using FairCoin
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const processPurchase = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const validatedData = PURCHASE_SCHEMA.parse(req.body);
    const { userId, amount, itemId, itemType, description } = validatedData;

    // Validate user authentication
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    // Check permissions
    const hasAccess = hasPermission(req.user._id.toString(), userId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have permission to make purchases from this account');
    }

    const receipt = await getDb().transaction(async (tx) => {
      const user = await selectAccount(tx, userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await ensureWallet(tx, userId);
      if (!(await debitWallet(tx, userId, amount))) {
        throw new BadRequestError('Insufficient funds');
      }

      const [transaction] = await tx
        .insert(transactionsTable)
        .values({
          userId,
          type: 'purchase',
          amount: String(amount),
          status: 'completed',
          description: description || `Purchase of ${itemType}`,
          itemId,
          itemType,
          completedAt: new Date(),
        })
        .returning();

      return toReceipt(transaction);
    });

    sendSuccess(res, {
      message: 'Purchase completed successfully',
      transaction: receipt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new BadRequestError('Invalid purchase data', { errors: error.errors });
    }
    if (error instanceof UnauthorizedError || error instanceof BadRequestError ||
        error instanceof ForbiddenError || error instanceof NotFoundError) {
      throw error;
    }

    logger.error('Error processing purchase', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Server error when processing purchase');
  }
};

/**
 * Requests a withdrawal
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const requestWithdrawal = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const validatedData = WITHDRAWAL_SCHEMA.parse(req.body);
    const { userId, amount, address } = validatedData;

    // Validate user authentication
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    // Check permissions
    const hasAccess = hasPermission(req.user._id.toString(), userId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have permission to withdraw from this account');
    }

    const receipt = await getDb().transaction(async (tx) => {
      const user = await selectAccount(tx, userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      await ensureWallet(tx, userId);

      // A withdrawal does NOT debit — it is created `pending` and settled out of
      // band — but it must still refuse when the funds are not there. Folding
      // that check into the same statement that stores the payout address means
      // the address is only recorded for a request that was actually accepted,
      // and the check cannot be answered from a stale read.
      const [reserved] = await tx
        .update(wallets)
        .set({ address })
        .where(and(eq(wallets.userId, userId), sql`${wallets.balance} >= ${amountParam(amount)}`))
        .returning({ userId: wallets.userId });
      if (!reserved) {
        throw new BadRequestError('Insufficient funds');
      }

      const [transaction] = await tx
        .insert(transactionsTable)
        .values({
          userId,
          type: 'withdrawal',
          amount: String(amount),
          // Withdrawals start as pending until manually approved
          status: 'pending',
          description: `Withdrawal to ${address.substring(0, 8)}...`,
        })
        .returning();

      return toReceipt(transaction);
    });

    sendSuccess(res, {
      message: 'Withdrawal request submitted and pending approval',
      transaction: receipt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new BadRequestError('Invalid withdrawal data', { errors: error.errors });
    }
    if (error instanceof UnauthorizedError || error instanceof BadRequestError ||
        error instanceof ForbiddenError || error instanceof NotFoundError) {
      throw error;
    }

    logger.error('Error requesting withdrawal', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Server error when requesting withdrawal');
  }
};

/**
 * Retrieves a specific transaction
 * @param req - Express request with authentication
 * @param res - Express response
 */
export const getTransaction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { transactionId } = req.params;

    // Validate user authentication
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    const [row] = await selectTransactions(getDb())
      .where(eq(transactionsTable.id, transactionId))
      .limit(1);

    if (!row) {
      throw new NotFoundError('Transaction not found');
    }

    // Check permissions - user can view if they're the sender or the recipient
    const viewerId = req.user._id.toString();
    const isSender = viewerId === row.transaction.userId;
    const isRecipient = viewerId === row.transaction.recipientId;

    if (!isSender && !isRecipient) {
      throw new ForbiddenError('You do not have permission to view this transaction');
    }

    sendSuccess(res, {
      transaction: toTransactionResponse(
        row.transaction,
        toLedgerParty(row.payerId, row.payerUsername),
        toLedgerParty(row.recipientAccountId, row.recipientUsername)
      ),
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof BadRequestError ||
        error instanceof ForbiddenError || error instanceof NotFoundError) {
      throw error;
    }
    logger.error('Error fetching transaction', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Server error when fetching transaction');
  }
};
