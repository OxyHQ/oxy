import express from 'express';
import { SessionController } from '../controllers/session.controller';
import { authMiddleware } from '../middleware/auth';
import { idpServiceLimiter } from '../middleware/security';
import { validate } from '../middleware/validate';
import { sessionIdParams, updateDeviceNameSchema, batchUsersSchema } from '../schemas/session.schemas';

const router = express.Router();

// ============================================
// Session-based data retrieval
// ============================================

/**
 * @openapi
 * /session/user/{sessionId}:
 *   get:
 *     tags:
 *       - Sessions
 *     summary: Resolve a session ID to the user it belongs to
 *     description: >
 *       Look up the user record for a given session ID. Requires a valid
 *       access token whose user owns the referenced session — callers cannot
 *       look up sessions belonging to other users. Used by SDK clients
 *       (e.g. `@oxy.so/core`) to hydrate user state from a stored session
 *       reference. Expired, revoked, or non-owned sessions return 404.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           example: sess_64f7c2a1b8e9d3f4a1c2b3d4
 *     responses:
 *       200:
 *         description: User attached to this session.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Malformed sessionId.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Session not found or expired.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/user/:sessionId', authMiddleware, validate({ params: sessionIdParams }), SessionController.getUserBySession);

/**
 * @openapi
 * /session/sessions/{sessionId}:
 *   get:
 *     tags:
 *       - Sessions
 *     summary: List all sessions for the user of the given session
 *     description: >
 *       Return every active session the user has across all devices, with
 *       a flag marking the current session. Requires a valid access token
 *       whose user owns the referenced session.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Active sessions for the user.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Session'
 *       404:
 *         description: Session not found or expired.
 */
router.get('/sessions/:sessionId', authMiddleware, validate({ params: sessionIdParams }), SessionController.getUserSessions);

// ============================================
// Session management
// ============================================

/**
 * @openapi
 * /session/logout/{sessionId}:
 *   post:
 *     tags:
 *       - Sessions
 *     summary: Sign out the given session
 *     description: >
 *       Revoke the session identified by `sessionId`. After this call any
 *       bearer token tied to that session is rejected. Idempotent — calling
 *       twice is a no-op on the second call.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session revoked.
 *       404:
 *         description: Session not found.
 */
router.post('/logout/:sessionId', validate({ params: sessionIdParams }), SessionController.logoutSession);

/**
 * @openapi
 * /session/logout/{sessionId}/{targetSessionId}:
 *   post:
 *     tags:
 *       - Sessions
 *     summary: Sign another session out via an authenticated session
 *     description: >
 *       Use `sessionId` (which must be a valid active session) to revoke a
 *       different session identified by `targetSessionId`. This is how the
 *       "sign out other devices" flow works.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: targetSessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Target session revoked.
 *       401:
 *         description: The acting session is not valid.
 *       404:
 *         description: Target session not found.
 */
router.post('/logout/:sessionId/:targetSessionId', SessionController.logoutSession);

/**
 * @openapi
 * /session/logout-all/{sessionId}:
 *   post:
 *     tags:
 *       - Sessions
 *     summary: Sign out every session for this user
 *     description: >
 *       Revoke every session belonging to the user behind `sessionId`,
 *       including the calling session itself. Recommended after a password
 *       reset or suspected compromise.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: All sessions revoked.
 *       404:
 *         description: Session not found.
 */
router.post('/logout-all/:sessionId', validate({ params: sessionIdParams }), SessionController.logoutAllSessions);

/**
 * @openapi
 * /session/validate/{sessionId}:
 *   get:
 *     tags:
 *       - Sessions
 *     security: []
 *     summary: Validate a session ID
 *     description: >
 *       Cheap liveness check — returns 200 with a small payload if the
 *       session is still active, 404 otherwise. Use this in lieu of the
 *       heavier `/session/user/:id` lookup when you only need a yes/no.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session is active.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                   example: true
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Session not found or expired.
 */
// Excluded from rl:general (IdP worker server-to-server session resolution; see
// isIdpServiceToServicePath). idpServiceLimiter is this route's sole per-IP cap.
router.get('/validate/:sessionId', idpServiceLimiter, validate({ params: sessionIdParams }), SessionController.validateSession);

/**
 * @openapi
 * /session/validate-header/{sessionId}:
 *   get:
 *     tags:
 *       - Sessions
 *     summary: Validate a session using a header-bound bearer token
 *     description: >
 *       Like `/session/validate/:sessionId` but cross-checks the bearer
 *       token against the session — returns 200 only if the token still
 *       belongs to the session.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Session and bearer token match.
 *       401:
 *         description: Token does not match the session.
 *       404:
 *         description: Session not found.
 */
router.get('/validate-header/:sessionId', validate({ params: sessionIdParams }), SessionController.validateSessionFromHeader);

// ============================================
// Device management
// ============================================

/**
 * @openapi
 * /session/device/sessions/{sessionId}:
 *   get:
 *     tags:
 *       - Devices
 *     summary: List sessions on the same device as the given session
 *     description: >
 *       Return every active session that shares the device fingerprint of
 *       the supplied session. Used to power "this device has these
 *       accounts" UI in the auth picker.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sessions on this device.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Session'
 *       404:
 *         description: Session not found.
 */
router.get('/device/sessions/:sessionId', validate({ params: sessionIdParams }), SessionController.getDeviceSessions);

/**
 * @openapi
 * /session/device/logout-all/{sessionId}:
 *   post:
 *     tags:
 *       - Devices
 *     summary: Sign out every session on this device
 *     description: >
 *       Revoke every session that shares the device fingerprint of the
 *       supplied session. Useful for a one-click "sign out this device"
 *       button.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Device sessions revoked.
 *       404:
 *         description: Session not found.
 */
router.post('/device/logout-all/:sessionId', validate({ params: sessionIdParams }), SessionController.logoutAllDeviceSessions);

/**
 * @openapi
 * /session/device/name/{sessionId}:
 *   put:
 *     tags:
 *       - Devices
 *     summary: Rename the device for the given session
 *     description: >
 *       Update the human-readable device label shown in the user's devices
 *       list. The change applies to every session sharing the device
 *       fingerprint.
 *     parameters:
 *       - name: sessionId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - deviceName
 *             properties:
 *               deviceName:
 *                 type: string
 *                 example: Living room iPad
 *     responses:
 *       200:
 *         description: Device renamed.
 *       400:
 *         description: Validation failed.
 *       404:
 *         description: Session not found.
 */
router.put('/device/name/:sessionId', validate({ params: sessionIdParams, body: updateDeviceNameSchema }), SessionController.updateDeviceName);

// ============================================
// Batch operations
// ============================================

/**
 * @openapi
 * /session/users/batch:
 *   post:
 *     tags:
 *       - Sessions
 *     summary: Resolve multiple session IDs in one call
 *     description: >
 *       Batch counterpart of `/session/user/:sessionId`. Pass an array of
 *       session IDs and get back a map of user records — used by clients
 *       that need to render multiple connected accounts at once (e.g. the
 *       account switcher).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sessionIds
 *             properties:
 *               sessionIds:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: string
 *           examples:
 *             pair:
 *               value:
 *                 sessionIds:
 *                   - sess_64f7c2a1b8e9d3f4a1c2b3d4
 *                   - sess_74f7c2a1b8e9d3f4a1c2b3d5
 *     responses:
 *       200:
 *         description: User records keyed by session ID. Missing sessions are omitted.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 $ref: '#/components/schemas/User'
 *       400:
 *         description: Validation failed.
 */
router.post('/users/batch', validate({ body: batchUsersSchema }), SessionController.getUsersBySessions);

export default router;
