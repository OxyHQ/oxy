import express from 'express';
import { getSecurityActivity, logPrivateKeyExported, logBackupCreated } from '../controllers/securityActivity.controller';
import { authMiddleware } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  logPrivateKeyExportedSchema,
  logBackupCreatedSchema,
} from '../schemas/security.schemas';

const router = express.Router();

/**
 * @openapi
 * /security/activity:
 *   get:
 *     tags:
 *       - Security
 *     summary: Account activity log with pagination
 *     description: >
 *       Return security-relevant events for the authenticated user — sign-ins,
 *       email changes, device add/remove, private-key exports, backup
 *       creations, suspicious activity flags. Always scoped to the bearer's own
 *       account; there is no parameter that widens it to another user.
 *       Used to power the activity history screen.
 *
 *
 *       No event carries an IP address, a country or any other network-derived
 *       location: the platform stores no user IPs at rest, in any form. Do not
 *       add such a field here or to the underlying table.
 *     parameters:
 *       - name: limit
 *         in: query
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *       - name: offset
 *         in: query
 *         required: false
 *         description: Rows to skip. Offset/limit paging — there is no cursor.
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *       - name: eventType
 *         in: query
 *         required: false
 *         description: Restrict to one event type. An unknown value is a 400.
 *         schema:
 *           type: string
 *           enum:
 *             - sign_in
 *             - sign_out
 *             - email_changed
 *             - profile_updated
 *             - device_added
 *             - device_removed
 *             - account_recovery
 *             - security_settings_changed
 *             - private_key_exported
 *             - backup_created
 *             - suspicious_activity
 *     responses:
 *       200:
 *         description: Activity events, newest first.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       userId:
 *                         type: string
 *                       eventType:
 *                         type: string
 *                         example: sign_in
 *                       eventDescription:
 *                         type: string
 *                       metadata:
 *                         type: object
 *                         additionalProperties: true
 *                       userAgent:
 *                         type: [string, "null"]
 *                       deviceId:
 *                         type: [string, "null"]
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                         description: When the EVENT happened.
 *                       severity:
 *                         type: string
 *                         enum: [low, medium, high, critical]
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                         description: When the row was written.
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *       400:
 *         description: Unknown eventType.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.get('/activity', authMiddleware, getSecurityActivity);

/**
 * @openapi
 * /security/activity/private-key-exported:
 *   post:
 *     tags:
 *       - Security
 *     summary: Log a "private key exported" event
 *     description: >
 *       Record that the local identity wallet exported its private key for
 *       backup. The event surfaces in the activity log and is used to remind
 *       the user to safely store the key.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               deviceId:
 *                 type: string
 *                 description: Device that performed the export. Optional.
 *     responses:
 *       200:
 *         description: Event recorded.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.post('/activity/private-key-exported', authMiddleware, validate({ body: logPrivateKeyExportedSchema }), logPrivateKeyExported);

/**
 * @openapi
 * /security/activity/backup-created:
 *   post:
 *     tags:
 *       - Security
 *     summary: Log a "backup created" event
 *     description: Record that the local identity wallet wrote a backup of its keys.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               deviceId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Event recorded.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.post('/activity/backup-created', authMiddleware, validate({ body: logBackupCreatedSchema }), logBackupCreated);

export default router;
