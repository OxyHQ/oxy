import express from 'express';
import { DevicesController } from '../controllers/devices.controller';
import { authMiddleware } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { deviceIdParams } from '../schemas/devices.schemas';

const router = express.Router();

// All device routes require authentication
router.use(authMiddleware);

/**
 * @openapi
 * /devices:
 *   get:
 *     tags:
 *       - Devices
 *     summary: List the user's devices
 *     description: >
 *       Return devices with active sessions for the authenticated principal and
 *       account. Application-bound sessions return only their current device.
 *     responses:
 *       200:
 *         description: List of devices.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Device'
 *             examples:
 *               twoDevices:
 *                 value:
 *                   - id: dev_64f7c2a1b8e9d3f4a1c2b3d4
 *                     name: MacBook Pro 16
 *                     platform: macOS
 *                     firstSeenAt: '2024-01-15T12:34:56.789Z'
 *                     lastSeenAt: '2025-05-12T09:00:00.000Z'
 *                     sessionCount: 2
 *                   - id: dev_74f7c2a1b8e9d3f4a1c2b3d5
 *                     name: iPhone 15 Pro
 *                     platform: iOS
 *                     firstSeenAt: '2024-02-01T08:00:00.000Z'
 *                     lastSeenAt: '2025-05-12T08:55:00.000Z'
 *                     sessionCount: 1
 *       401:
 *         description: Missing or invalid bearer token.
 *       403:
 *         description: The acting session changed during the request.
 */
router.get('/', DevicesController.getUserDevices);

/**
 * @openapi
 * /devices/security:
 *   get:
 *     tags:
 *       - Devices
 *       - Security
 *     summary: Get aggregate security info for the user's devices
 *     description: >
 *       Return high-level security signals across the user's devices
 *       (count of active sessions, unusual logins, last suspicious activity,
 *       etc.). Used to surface a security health summary on the account
 *       dashboard.
 *     responses:
 *       200:
 *         description: Security info payload.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.get('/security', DevicesController.getSecurityInfo);

/**
 * @openapi
 * /devices/{deviceId}:
 *   delete:
 *     tags:
 *       - Devices
 *     summary: Remove a device
 *     description: >
 *       Revoke active sessions of the authenticated principal and account on
 *       the given remote device. Application-bound sessions cannot remove
 *       remote devices.
 *     parameters:
 *       - name: deviceId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           example: dev_64f7c2a1b8e9d3f4a1c2b3d4
 *     responses:
 *       200:
 *         description: Device removed.
 *       401:
 *         description: Missing or invalid bearer token.
 *       400:
 *         description: The target is the current device or the id is invalid.
 *       403:
 *         description: The application cannot remove devices, or the acting session changed.
 *       404:
 *         description: Device not found.
 */
router.delete('/:deviceId', validate({ params: deviceIdParams }), DevicesController.removeDevice);

export default router;
