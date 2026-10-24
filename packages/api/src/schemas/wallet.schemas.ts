import { utf16MinLength } from '@oxy.so/contracts';
import { z } from '@oxy.so/zod4';

// GET /wallet/:userId
export const walletUserIdParams = z.object({
  userId: z.string().trim().check(utf16MinLength(1)),
});

// GET /wallet/transactions/:userId
export const transactionUserIdParams = z.object({
  userId: z.string().trim().check(utf16MinLength(1)),
});

// GET /wallet/transaction/:transactionId
export const transactionIdParams = z.object({
  transactionId: z.string().trim().check(utf16MinLength(1)),
});

// POST /wallet/transfer
export const transferFundsSchema = z.object({
  fromUserId: z.string().trim().check(utf16MinLength(1)),
  toUserId: z.string().trim().check(utf16MinLength(1)),
  amount: z.number().positive(),
  description: z.string().trim().optional(),
});

// POST /wallet/purchase
export const purchaseSchema = z.object({
  userId: z.string().trim().check(utf16MinLength(1)),
  amount: z.number().positive(),
  itemId: z.string().trim().check(utf16MinLength(1)),
  itemType: z.string().trim().check(utf16MinLength(1)),
  description: z.string().trim().optional(),
});

// POST /wallet/withdraw
export const withdrawalSchema = z.object({
  userId: z.string().trim().check(utf16MinLength(1)),
  amount: z.number().positive(),
  address: z.string().trim().check(utf16MinLength(1)),
});
