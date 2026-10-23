import { z } from '@oxy.so/zod3';

// GET /wallet/:userId
export const walletUserIdParams = z.object({
  userId: z.string().trim().min(1),
});

// GET /wallet/transactions/:userId
export const transactionUserIdParams = z.object({
  userId: z.string().trim().min(1),
});

// GET /wallet/transaction/:transactionId
export const transactionIdParams = z.object({
  transactionId: z.string().trim().min(1),
});

// POST /wallet/transfer
export const transferFundsSchema = z.object({
  fromUserId: z.string().trim().min(1),
  toUserId: z.string().trim().min(1),
  amount: z.number().positive(),
  description: z.string().trim().optional(),
});

// POST /wallet/purchase
export const purchaseSchema = z.object({
  userId: z.string().trim().min(1),
  amount: z.number().positive(),
  itemId: z.string().trim().min(1),
  itemType: z.string().trim().min(1),
  description: z.string().trim().optional(),
});

// POST /wallet/withdraw
export const withdrawalSchema = z.object({
  userId: z.string().trim().min(1),
  amount: z.number().positive(),
  address: z.string().trim().min(1),
});
