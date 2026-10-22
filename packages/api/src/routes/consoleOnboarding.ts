/**
 * Oxy Console first-run onboarding: the terms a person accepts and what they
 * came to do.
 *
 * Acceptance belongs to the PERSON (the authenticated user), never to a
 * workspace, and the user id always comes from the session, never the body.
 * No IP is stored or logged (the no-IP invariant): acceptance is evidenced by
 * user, version and time. Rate-limit keys are the user id, or `hashedIpKey`
 * when no user resolved.
 */

import { Router, type Response } from 'express';
import { and, eq } from 'drizzle-orm';
import {
  CONSOLE_TERMS_VERSION,
  acceptConsoleTermsInputSchema,
  saveConsoleUseCasesInputSchema,
  type AcceptConsoleTermsInput,
  type ConsoleOnboardingState,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { consoleOnboarding } from '../db/schema/consoleOnboarding';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { ConflictError, UnauthorizedError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';

const router = Router();

router.use(authMiddleware);

const limiter = rateLimit({
  prefix: 'rl:console:onboarding:',
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many onboarding requests. Please wait a minute before trying again.',
  keyGenerator: (req) => {
    const userId = (req as AuthRequest).user?._id?.toString();
    return userId ? `console:onboarding:${userId}` : `console:onboarding:ip:${hashedIpKey(req)}`;
  },
});
router.use(limiter);

function requireUserId(req: AuthRequest): string {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new UnauthorizedError('Authentication required');
  }
  return userId;
}

type OnboardingRow = typeof consoleOnboarding.$inferSelect;

const EMPTY_STATE: ConsoleOnboardingState = {
  termsVersion: null,
  termsAcceptedAt: null,
  termsCurrent: false,
  marketingOptIn: false,
  useCases: [],
  useCaseDescription: null,
  useCasesAnswered: false,
};

function toState(row: OnboardingRow | undefined): ConsoleOnboardingState {
  if (!row) {
    return EMPTY_STATE;
  }
  return {
    termsVersion: row.termsVersion,
    termsAcceptedAt: row.termsAcceptedAt ? row.termsAcceptedAt.toISOString() : null,
    termsCurrent: row.termsVersion === CONSOLE_TERMS_VERSION,
    marketingOptIn: row.marketingOptIn,
    // The column CHECK holds these to the closed set.
    useCases: row.useCases as ConsoleOnboardingState['useCases'],
    useCaseDescription: row.useCaseDescription,
    useCasesAnswered: row.useCasesAnsweredAt !== null,
  };
}

async function readState(userId: string): Promise<ConsoleOnboardingState> {
  const [row] = await getDb()
    .select()
    .from(consoleOnboarding)
    .where(eq(consoleOnboarding.userId, userId))
    .limit(1);
  return toState(row);
}

/**
 * @openapi
 * /console/onboarding:
 *   get:
 *     tags: [Console]
 *     summary: The signed-in person's Console onboarding state
 *     description: A person with no record gets the empty state (terms not accepted, use cases unanswered).
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: The onboarding state.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [termsVersion, termsAcceptedAt, termsCurrent, marketingOptIn, useCases, useCaseDescription, useCasesAnswered]
 *               properties:
 *                 termsVersion: { type: string, nullable: true }
 *                 termsAcceptedAt: { type: string, format: date-time, nullable: true }
 *                 termsCurrent: { type: boolean }
 *                 marketingOptIn: { type: boolean }
 *                 useCases: { type: array, items: { type: string } }
 *                 useCaseDescription: { type: string, nullable: true }
 *                 useCasesAnswered: { type: boolean }
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.json(await readState(requireUserId(req)));
  }),
);

/**
 * @openapi
 * /console/onboarding/terms:
 *   post:
 *     tags: [Console]
 *     summary: Accept the current Console terms
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [version, adultAcknowledged, aupAcknowledged, marketingOptIn]
 *             properties:
 *               version: { type: string }
 *               adultAcknowledged: { type: boolean, enum: [true] }
 *               aupAcknowledged: { type: boolean, enum: [true] }
 *               marketingOptIn: { type: boolean }
 *     responses:
 *       200:
 *         description: The updated onboarding state.
 *       400:
 *         description: Validation failed (an acknowledgement is not true).
 *       401:
 *         description: Missing or invalid bearer token.
 *       409:
 *         description: The version is not the current terms version.
 */
router.post(
  '/terms',
  validate({ body: acceptConsoleTermsInputSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const input = req.body as AcceptConsoleTermsInput;
    if (input.version !== CONSOLE_TERMS_VERSION) {
      throw new ConflictError('These terms are no longer current', {
        currentVersion: CONSOLE_TERMS_VERSION,
      });
    }
    const now = new Date();
    const accepted = {
      termsVersion: CONSOLE_TERMS_VERSION,
      termsAcceptedAt: now,
      adultAcknowledged: true,
      aupAcknowledged: true,
      marketingOptIn: input.marketingOptIn,
    };
    const [row] = await getDb()
      .insert(consoleOnboarding)
      .values({ userId, ...accepted })
      .onConflictDoUpdate({ target: consoleOnboarding.userId, set: accepted })
      .returning();
    res.json(toState(row));
  }),
);

/**
 * @openapi
 * /console/onboarding/use-cases:
 *   post:
 *     tags: [Console]
 *     summary: Save what the person came to do, or skip
 *     description: An empty list is a skip and still counts as answered. Requires the current terms to be accepted.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [useCases]
 *             properties:
 *               useCases:
 *                 type: array
 *                 items: { type: string, enum: [build-with-api, ai-models, publish-apps, billing-credits, explore-platform] }
 *               description: { type: string, maxLength: 2000 }
 *     responses:
 *       200:
 *         description: The updated onboarding state.
 *       400:
 *         description: Validation failed (unknown use case, description too long).
 *       401:
 *         description: Missing or invalid bearer token.
 *       409:
 *         description: The current terms have not been accepted.
 */
router.post(
  '/use-cases',
  validate({ body: saveConsoleUseCasesInputSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const input = req.body as { useCases: string[]; description?: string };
    const [row] = await getDb()
      .update(consoleOnboarding)
      .set({
        useCases: input.useCases,
        useCaseDescription: input.description ? input.description : null,
        useCasesAnsweredAt: new Date(),
      })
      .where(
        and(
          eq(consoleOnboarding.userId, userId),
          eq(consoleOnboarding.termsVersion, CONSOLE_TERMS_VERSION),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictError('Accept the current terms first');
    }
    res.json(toState(row));
  }),
);

export default router;
