import { Router } from 'express';
import { postalAddressInputSchema, postalAddressUpdateSchema } from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireFirstPartyDeviceAccess } from '../middleware/firstPartyDeviceAccess';
import { parseValidatedRequestValue } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError, ServiceUnavailableError, UnauthorizedError } from '../utils/error';
import { listPostalAddresses, savePostalAddress, deletePostalAddress } from '../db/postalAddresses';

const router = Router();
router.use(authMiddleware, requireFirstPartyDeviceAccess);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
/** Database exceptions can contain bound postal values; never expose/log them. */
async function privateOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ServiceUnavailableError('Saved addresses are temporarily unavailable');
  }
}
function owner(req: AuthRequest): string {
  if (!req.user?.id) throw new UnauthorizedError('Authentication required');
  return req.user.id;
}
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await privateOperation(() => listPostalAddresses(owner(req))));
  }),
);
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = parseValidatedRequestValue(postalAddressInputSchema, req.body);
    res.status(201).json(await privateOperation(() => savePostalAddress(owner(req), input)));
  }),
);
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const input = parseValidatedRequestValue(postalAddressUpdateSchema, req.body);
    res.json(await privateOperation(() => savePostalAddress(owner(req), input, req.params.id)));
  }),
);
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await privateOperation(() => deletePostalAddress(owner(req), req.params.id));
    res.status(204).end();
  }),
);
export default router;
