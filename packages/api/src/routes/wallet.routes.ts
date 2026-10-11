import express from 'express';
import {
  getWallet,
  getTransactionHistory,
  transferFunds,
  processPurchase,
  requestWithdrawal,
  getTransaction,
} from '../controllers/wallet.controller';
import { authMiddleware } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  walletUserIdParams,
  transactionUserIdParams,
  transactionIdParams,
  transferFundsSchema,
  purchaseSchema,
  withdrawalSchema,
} from '../schemas/wallet.schemas';

const router = express.Router();

// All wallet routes require authentication
router.use(authMiddleware);

// Wallet info routes
router.get('/:userId', validate({ params: walletUserIdParams }), getWallet);
router.get(
  '/transactions/:userId',
  validate({ params: transactionUserIdParams }),
  getTransactionHistory,
);
router.get(
  '/transaction/:transactionId',
  validate({ params: transactionIdParams }),
  getTransaction,
);

// Transaction routes
router.post('/transfer', validate({ body: transferFundsSchema }), transferFunds);
router.post('/purchase', validate({ body: purchaseSchema }), processPurchase);
router.post('/withdraw', validate({ body: withdrawalSchema }), requestWithdrawal);

export default router;
