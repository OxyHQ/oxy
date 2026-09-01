/**
 * Payment controller.
 *
 * Real payment processing lives in `routes/billing.ts` (Stripe-backed checkout,
 * subscriptions, and webhook handling).
 *
 * `getUserPayments` is a read-only endpoint that returns the authenticated
 * user's payment transaction history.
 *
 * ## Two things the Postgres port has to get right, and neither is visible in
 * the query
 *
 * **`amount` is `numeric(38, 8)`, and postgres.js hands a `numeric` back as a
 * STRING.** The wire has always carried it as a JSON number (`Payment.amount`
 * in `@oxyhq/services`), so the conversion happens here, at the serialization
 * boundary, and nowhere else — nothing in this file computes with the value.
 *
 * **Drizzle returns `null` for an unset optional column where Mongoose returned
 * `undefined`.** `JSON.stringify` OMITS an `undefined` property and EMITS a
 * `null` one, so a naive port silently adds `"description": null`,
 * `"itemId": null`, `"itemType": null` and `"completedAt": null` to every
 * payment — a wire change against a published contract whose fields are all
 * `?:`. Each optional is therefore spread in only when it has a value.
 */

import type { Response } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AuthRequest } from '../middleware/auth';
import { getDb } from '../config/postgres';
import { transactions } from '../db/schema/transactions';
import { logger } from '../utils/logger';
import { sendSuccess } from '../utils/asyncHandler';
import { UnauthorizedError, InternalServerError } from '../utils/error';

/** The transaction kinds that count as a payment in this history. */
const PAYMENT_TYPES = ['deposit', 'purchase'] as const;

/**
 * One entry of the payment history, exactly as the wire has always carried it.
 *
 * Every optional is `?:` rather than `| null` on purpose — see the header: the
 * absent form is an OMITTED key, which is what `Payment` in `@oxyhq/services`
 * models.
 */
interface PaymentResponse {
  id: string;
  userId: string;
  type: (typeof transactions.$inferSelect)['type'];
  amount: number;
  status: (typeof transactions.$inferSelect)['status'];
  description?: string;
  itemId?: string;
  itemType?: string;
  /** The row's `createdAt`, under the name the wire has always used. */
  timestamp: Date;
  completedAt?: Date;
}

/**
 * Get all payments for the authenticated user.
 * Reads `transactions` rows of type `deposit` or `purchase`.
 */
export const getUserPayments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    const userId = req.user._id;

    const rows = await getDb()
      .select({
        id: transactions.id,
        userId: transactions.userId,
        type: transactions.type,
        amount: transactions.amount,
        status: transactions.status,
        description: transactions.description,
        itemId: transactions.itemId,
        itemType: transactions.itemType,
        createdAt: transactions.createdAt,
        completedAt: transactions.completedAt,
      })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), inArray(transactions.type, [...PAYMENT_TYPES])))
      .orderBy(desc(transactions.createdAt));

    const payments: PaymentResponse[] = rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      type: row.type,
      amount: Number(row.amount),
      status: row.status,
      ...(row.description !== null && { description: row.description }),
      ...(row.itemId !== null && { itemId: row.itemId }),
      ...(row.itemType !== null && { itemType: row.itemType }),
      timestamp: row.createdAt,
      ...(row.completedAt !== null && { completedAt: row.completedAt }),
    }));

    sendSuccess(res, payments);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    logger.error('Error fetching user payments', error instanceof Error ? error : new Error(String(error)));
    throw new InternalServerError('Server error when fetching user payments');
  }
};
