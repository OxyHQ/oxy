/**
 * Device-to-device identity transfer routes (b3 Feature 2 — "add a device").
 *
 * Mounted at `/identity/device-transfer` (no CSRF — public/unauthenticated init,
 * info, deny; the approve write is bearer + signature-authenticated, so per the
 * bearer-write CSRF rule it takes no ambient cookie CSRF token):
 *  - `POST /identity/device-transfer/init`               (public) register a pairing
 *  - `GET  /identity/device-transfer/:pairingId`         (public) resolve a pairing
 *  - `POST /identity/device-transfer/:pairingId/approve` (bearer + signature) seal + relay
 *  - `POST /identity/device-transfer/:pairingId/deny`    (public) cancel a pairing
 *
 * The relay is E2E-encrypted via an ephemeral secp256k1 ECDH handshake: the
 * server stores only the two ephemeral public keys plus an opaque AEAD
 * ciphertext/nonce and NEVER holds a decryption key. See
 * `services/deviceTransfer.service.ts` for the full security model.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../utils/error';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import {
  deviceTransferInitRequestSchema,
  deviceTransferApproveRequestSchema,
  type DeviceTransferInitRequest,
  type DeviceTransferApproveRequest,
} from '@oxy.so/contracts';
import {
  initDeviceTransfer,
  getDeviceTransferInfo,
  approveDeviceTransfer,
  denyDeviceTransfer,
} from '../services/deviceTransfer.service';
import { emitDevicePairUpdate } from '../utils/devicePairSocket';

const router = Router();

/** `:pairingId` path param — the public 128-bit hex handle from the QR. */
const pairingIdParams = z.object({
  pairingId: z.string().trim().min(1).max(128),
});

/* -------------------------------------------------------------------------- */
/*  Rate limiters — public endpoints keyed by hashed IP (privacy invariant),   */
/*  the bearer approve keyed by user id.                                       */
/* -------------------------------------------------------------------------- */

const initLimiter = rateLimit({
  prefix: 'rl:identity:devicetransfer:init:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 20,
  message: 'Too many device-transfer requests. Please slow down.',
  keyGenerator: (req: Request) => `devicetransfer:init:ip:${hashedIpKey(req)}`,
});

const infoLimiter = rateLimit({
  prefix: 'rl:identity:devicetransfer:info:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 300 : 120,
  message: 'Too many device-transfer lookups. Please slow down.',
  keyGenerator: (req: Request) => `devicetransfer:info:ip:${hashedIpKey(req)}`,
});

const approveLimiter = rateLimit({
  prefix: 'rl:identity:devicetransfer:approve:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
  message: 'Too many device-transfer approvals. Please slow down.',
  keyGenerator: (req: Request) => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `devicetransfer:approve:${userId}` : `devicetransfer:approve:ip:${hashedIpKey(req)}`;
  },
});

const denyLimiter = rateLimit({
  prefix: 'rl:identity:devicetransfer:deny:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
  message: 'Too many device-transfer denials. Please slow down.',
  keyGenerator: (req: Request) => `devicetransfer:deny:ip:${hashedIpKey(req)}`,
});

/* -------------------------------------------------------------------------- */
/*  POST /identity/device-transfer/init                                        */
/* -------------------------------------------------------------------------- */
router.post(
  '/init',
  initLimiter,
  validate({ body: deviceTransferInitRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { newEphPub, newDeviceLabel } = req.body as DeviceTransferInitRequest;

    const outcome = await initDeviceTransfer({ newEphPub, newDeviceLabel });
    if (!outcome.ok) {
      throw new BadRequestError(outcome.message);
    }

    sendSuccess(
      res,
      { pairingId: outcome.pairingId, expiresAt: outcome.expiresAt.toISOString() },
      201,
    );
  }),
);

/* -------------------------------------------------------------------------- */
/*  GET /identity/device-transfer/:pairingId                                   */
/* -------------------------------------------------------------------------- */
router.get(
  '/:pairingId',
  infoLimiter,
  validate({ params: pairingIdParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const { pairingId } = req.params;

    const info = await getDeviceTransferInfo(pairingId);
    if (!info) {
      throw new NotFoundError('Pairing not found');
    }

    sendSuccess(res, info);
  }),
);

/* -------------------------------------------------------------------------- */
/*  POST /identity/device-transfer/:pairingId/approve                          */
/* -------------------------------------------------------------------------- */
router.post(
  '/:pairingId/approve',
  authMiddleware,
  approveLimiter,
  validate({ params: pairingIdParams, body: deviceTransferApproveRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const { pairingId } = req.params;
    const { oldEphPub, ciphertext, nonce, signature, timestamp } =
      req.body as DeviceTransferApproveRequest;

    const outcome = await approveDeviceTransfer({
      pairingId,
      authenticatedUserId: userId,
      oldEphPub,
      ciphertext,
      nonce,
      signature,
      timestamp,
    });

    if (!outcome.ok) {
      if (outcome.status === 401) throw new UnauthorizedError(outcome.message);
      if (outcome.status === 404) throw new NotFoundError(outcome.message);
      if (outcome.status === 409) throw new ConflictError(outcome.message);
      throw new BadRequestError(outcome.message);
    }

    // Notify the waiting new device to fetch the sealed material and import it.
    emitDevicePairUpdate(pairingId, { status: 'approved' });

    logger.info('Device transfer approved (relay sealed)', {
      pairingId: pairingId.substring(0, 8) + '...',
      userId,
    });

    sendSuccess(res, { success: true, pairingId, status: 'approved' as const });
  }),
);

/* -------------------------------------------------------------------------- */
/*  POST /identity/device-transfer/:pairingId/deny                             */
/* -------------------------------------------------------------------------- */
router.post(
  '/:pairingId/deny',
  denyLimiter,
  validate({ params: pairingIdParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const { pairingId } = req.params;

    const outcome = await denyDeviceTransfer(pairingId);
    if (!outcome.ok) {
      if (outcome.status === 404) throw new NotFoundError(outcome.message);
      throw new ConflictError(outcome.message);
    }

    emitDevicePairUpdate(pairingId, { status: 'denied' });

    sendSuccess(res, { success: true, pairingId, status: outcome.status });
  }),
);

export default router;
