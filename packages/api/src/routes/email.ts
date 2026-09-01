/**
 * Email Routes
 *
 * RESTful API routes for the Oxy email system.
 * All routes require authentication via authMiddleware.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { inferenceStreamEventSchema, type InferenceStreamEvent } from '@oxyhq/contracts';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { BadRequestError } from '../utils/error';
import { rateLimit } from '../middleware/rateLimiter';
import {
  inboxInferenceRequestSchema,
  inboxInferenceResponseEnvelopeSchema,
  inboxInferenceResponseSchema,
  inboxInferenceStreamResponseSchema,
  type InboxInferenceRequest,
} from '../schemas/inboxInference.schemas';
import { runInboxInference, streamInboxInference } from '../services/inboxInference.service';
import {
  createMailboxSchema,
  mailboxIdParams,
  messageIdParams,
  updateFlagsSchema,
  updateLabelsSchema,
  moveMessageSchema,
  snoozeMessageSchema,
  bulkUpdateFlagsSchema,
  bulkMoveMessagesSchema,
  createLabelSchema,
  labelIdParams,
  updateLabelSchema,
  sendMessageSchema,
  saveDraftSchema,
  unsubscribeSchema,
  bundleIdParams,
  updateBundleSchema,
  updateEmailSettingsSchema,
  createReminderSchema,
  reminderIdParams,
  updateReminderSchema,
  createFilterSchema,
  filterIdParams,
  updateFilterSchema,
  createTemplateSchema,
  templateIdParams,
  updateTemplateSchema,
  createSavedSearchSchema,
  savedSearchIdParams,
  outboxIdParams,
  createContactSchema,
  contactIdParams,
  updateContactSchema,
} from '../schemas/email.schemas';
import {
  listMailboxes,
  createMailbox,
  deleteMailbox,
  listMessages,
  getMessage,
  getThread,
  updateMessageFlags,
  updateMessageLabels,
  moveMessage,
  deleteMessage,
  snoozeMessage,
  unsnoozeMessage,
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  sendMessage,
  saveDraft,
  searchMessages,
  getQuota,
  getEmailSettings,
  updateEmailSettings,
  listSubscriptions,
  unsubscribe,
  listBundles,
  updateBundle,
  listBundledMessages,
  bulkUpdateFlags,
  bulkMoveMessages,
  suggestContacts,
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  createReminder,
  listReminders,
  getReminder,
  updateReminder,
  deleteReminder,
  listFilters,
  createFilter,
  updateFilter,
  deleteFilter,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  exportMessage,
  importMessages,
  listOutboundMessages,
  retryOutboundMessage,
  cancelOutboundMessage,
  listSavedSearches,
  createSavedSearch,
  deleteSavedSearch,
} from '../controllers/email.controller';

const router = Router();

const IMPORT_MAX_FILES = 5;
const IMPORT_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

const inboxInferenceLimiter = rateLimit({
  prefix: 'rl:email:inference:',
  windowMs: 60_000,
  max: 30,
  keyGenerator: getRequiredOxyUserId,
  message: 'Inbox inference request limit exceeded, please slow down.',
});

// Multer for .eml uploads on POST /import (in-memory, max 25 MB / file).
// Attachment uploads no longer flow through this route — clients upload files
// to the Oxy file manager (/assets) and reference them by fileId on send.
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: IMPORT_MAX_FILE_SIZE_BYTES,
    files: IMPORT_MAX_FILES,
    fields: 0,
    parts: IMPORT_MAX_FILES,
  },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.eml')) {
      cb(
        new BadRequestError(
          `Invalid file type: ${file.originalname}. Only .eml files are accepted.`,
        ),
      );
      return;
    }
    cb(null, true);
  },
});

const importUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  importUpload.array('files', IMPORT_MAX_FILES)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      next(new BadRequestError(err.message));
      return;
    }
    next(err);
  });
};

// All email routes require authentication
router.use(authMiddleware);

function requestSignal(req: Request, res: Response) {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once('aborted', abort);
  res.once('close', abort);
  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', abort);
      res.off('close', abort);
    },
  };
}

// ─── Inbox point-action inference BFF ────────────────────────────
// These routes serve stateless Inbox helpers such as drafting, polishing,
// summaries and smart replies. Conversational surfaces (including
// AliaChatSheet) continue through Alia so its agent, tools, conversations and
// memory remain authoritative; they must never be redirected here.

/**
 * `POST /email/ai` — one authenticated, stateless Inbox point action.
 *
 * The server owns identity, prompts, labels, token ceilings and routing. This
 * endpoint is not an Alia conversation surface.
 *
 * @response 200 inboxInferenceResponseEnvelopeSchema The completed point action.
 */
router.post(
  '/ai',
  inboxInferenceLimiter,
  validate({ body: inboxInferenceRequestSchema }),
  asyncHandler(async (req, res) => {
    const lifecycle = requestSignal(req, res);
    try {
      const result = await runInboxInference(
        req.body as InboxInferenceRequest,
        getRequiredOxyUserId(req),
        lifecycle.signal,
      );
      const body = inboxInferenceResponseSchema.parse(result);
      res.status(200).json(inboxInferenceResponseEnvelopeSchema.parse({ data: body }));
    } finally {
      lifecycle.dispose();
    }
  }),
);

/**
 * `POST /email/ai/stream` — stream a supported Inbox point action as validated
 * normalized inference events. A failure after headers emits a terminal,
 * user-safe `error` event rather than a successful-looking truncation.
 *
 * @response 200 text/event-stream inboxInferenceStreamResponseSchema Normalized SSE events ending in `done` or `error`.
 */
router.post(
  '/ai/stream',
  inboxInferenceLimiter,
  validate({ body: inboxInferenceRequestSchema }),
  asyncHandler(async (req, res) => {
    const lifecycle = requestSignal(req, res);
    let opened = false;
    let lastEvent: InferenceStreamEvent | undefined;
    try {
      for await (const event of streamInboxInference(
        req.body as InboxInferenceRequest,
        getRequiredOxyUserId(req),
        lifecycle.signal,
      )) {
        lastEvent = event;
        if (!opened) {
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();
          opened = true;
        }
        if (!res.writableEnded && !res.destroyed) {
          const data = inboxInferenceStreamResponseSchema.parse(JSON.stringify(event));
          res.write(`event: ${event.type}\ndata: ${data}\n\n`);
        }
      }
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (opened && lastEvent !== undefined) {
        if (!lifecycle.signal.aborted && !res.writableEnded && !res.destroyed) {
          const terminalError = inferenceStreamEventSchema.parse({
            schemaVersion: 1,
            type: 'error',
            requestId: lastEvent.requestId,
            sequence: lastEvent.sequence + 1,
            error: {
              schemaVersion: 1,
              code: 'service_unavailable',
              message: 'Inbox inference is temporarily unavailable',
              retryable: false,
              requestId: lastEvent.requestId,
            },
          });
          const data = inboxInferenceStreamResponseSchema.parse(JSON.stringify(terminalError));
          res.write(
            `event: error\ndata: ${data}\n\n`,
          );
          res.end();
        }
        return;
      }
      throw error;
    } finally {
      lifecycle.dispose();
    }
  }),
);

// ─── Mailboxes ────────────────────────────────────────────────────

router.get('/mailboxes', asyncHandler(listMailboxes));
router.post('/mailboxes', validate({ body: createMailboxSchema }), asyncHandler(createMailbox));
router.delete('/mailboxes/:mailboxId', validate({ params: mailboxIdParams }), asyncHandler(deleteMailbox));

// ─── Messages ─────────────────────────────────────────────────────

router.get('/messages', asyncHandler(listMessages));
router.get('/messages/bundled', asyncHandler(listBundledMessages));
// ─── Bulk Operations ─────────────────────────────────────────────
// Register these before /messages/:messageId routes so "bulk" is not
// captured as a messageId by Express' first-match routing.

router.post('/messages/bulk/flags', validate({ body: bulkUpdateFlagsSchema }), asyncHandler(bulkUpdateFlags));
router.post('/messages/bulk/move', validate({ body: bulkMoveMessagesSchema }), asyncHandler(bulkMoveMessages));

router.get('/messages/:messageId', validate({ params: messageIdParams }), asyncHandler(getMessage));
router.get('/messages/:messageId/thread', validate({ params: messageIdParams }), asyncHandler(getThread));
router.get('/messages/:messageId/export', validate({ params: messageIdParams }), asyncHandler(exportMessage));
router.put('/messages/:messageId/flags', validate({ params: messageIdParams, body: updateFlagsSchema }), asyncHandler(updateMessageFlags));
router.put('/messages/:messageId/labels', validate({ params: messageIdParams, body: updateLabelsSchema }), asyncHandler(updateMessageLabels));
router.post('/messages/:messageId/move', validate({ params: messageIdParams, body: moveMessageSchema }), asyncHandler(moveMessage));
router.delete('/messages/:messageId', validate({ params: messageIdParams }), asyncHandler(deleteMessage));
router.post('/messages/:messageId/snooze', validate({ params: messageIdParams, body: snoozeMessageSchema }), asyncHandler(snoozeMessage));
router.post('/messages/:messageId/unsnooze', validate({ params: messageIdParams }), asyncHandler(unsnoozeMessage));

// ─── Labels ──────────────────────────────────────────────────────

router.get('/labels', asyncHandler(listLabels));
router.post('/labels', validate({ body: createLabelSchema }), asyncHandler(createLabel));
router.put('/labels/:labelId', validate({ params: labelIdParams, body: updateLabelSchema }), asyncHandler(updateLabel));
router.delete('/labels/:labelId', validate({ params: labelIdParams }), asyncHandler(deleteLabel));

// ─── Contacts ────────────────────────────────────────────────────

router.get('/contacts/suggest', asyncHandler(suggestContacts));
router.get('/contacts', asyncHandler(listContacts));
router.post('/contacts', validate({ body: createContactSchema }), asyncHandler(createContact));
router.put('/contacts/:contactId', validate({ params: contactIdParams, body: updateContactSchema }), asyncHandler(updateContact));
router.delete('/contacts/:contactId', validate({ params: contactIdParams }), asyncHandler(deleteContact));

// ─── Compose ──────────────────────────────────────────────────────

router.post('/messages', validate({ body: sendMessageSchema }), asyncHandler(sendMessage));
router.post('/drafts', validate({ body: saveDraftSchema }), asyncHandler(saveDraft));
router.get('/outbox', asyncHandler(listOutboundMessages));
router.post('/outbox/:outboxId/retry', validate({ params: outboxIdParams }), asyncHandler(retryOutboundMessage));
router.post('/outbox/:outboxId/cancel', validate({ params: outboxIdParams }), asyncHandler(cancelOutboundMessage));

// ─── Search ───────────────────────────────────────────────────────

router.get('/search', asyncHandler(searchMessages));
router.get('/saved-searches', asyncHandler(listSavedSearches));
router.post('/saved-searches', validate({ body: createSavedSearchSchema }), asyncHandler(createSavedSearch));
router.delete('/saved-searches/:savedSearchId', validate({ params: savedSearchIdParams }), asyncHandler(deleteSavedSearch));

// ─── Quota ────────────────────────────────────────────────────────

router.get('/quota', asyncHandler(getQuota));

// ─── Import ───────────────────────────────────────────────────────
// .eml files are uploaded as multipart via multer; attachments inside the
// .eml are extracted server-side and persisted via the Oxy file manager
// (assetService.uploadFileDirect), exactly like inbound MIME from Cloudflare.

router.post('/import', importUploadMiddleware, asyncHandler(importMessages));

// ─── Subscriptions ───────────────────────────────────────────

router.get('/subscriptions', asyncHandler(listSubscriptions));
router.post('/subscriptions/unsubscribe', validate({ body: unsubscribeSchema }), asyncHandler(unsubscribe));

// ─── Bundles ──────────────────────────────────────────────────────

router.get('/bundles', asyncHandler(listBundles));
router.put('/bundles/:bundleId', validate({ params: bundleIdParams, body: updateBundleSchema }), asyncHandler(updateBundle));

// ─── Reminders ───────────────────────────────────────────────────

router.post('/reminders', validate({ body: createReminderSchema }), asyncHandler(createReminder));
router.get('/reminders', asyncHandler(listReminders));
router.get('/reminders/:reminderId', validate({ params: reminderIdParams }), asyncHandler(getReminder));
router.put('/reminders/:reminderId', validate({ params: reminderIdParams, body: updateReminderSchema }), asyncHandler(updateReminder));
router.delete('/reminders/:reminderId', validate({ params: reminderIdParams }), asyncHandler(deleteReminder));

// ─── Filters ────────────────────────────────────────────────────

router.get('/filters', asyncHandler(listFilters));
router.post('/filters', validate({ body: createFilterSchema }), asyncHandler(createFilter));
router.put('/filters/:filterId', validate({ params: filterIdParams, body: updateFilterSchema }), asyncHandler(updateFilter));
router.delete('/filters/:filterId', validate({ params: filterIdParams }), asyncHandler(deleteFilter));

// ─── Templates ──────────────────────────────────────────────────

router.get('/templates', asyncHandler(listTemplates));
router.post('/templates', validate({ body: createTemplateSchema }), asyncHandler(createTemplate));
router.put('/templates/:templateId', validate({ params: templateIdParams, body: updateTemplateSchema }), asyncHandler(updateTemplate));
router.delete('/templates/:templateId', validate({ params: templateIdParams }), asyncHandler(deleteTemplate));

// ─── Settings ─────────────────────────────────────────────────────

router.get('/settings', asyncHandler(getEmailSettings));
router.put('/settings', validate({ body: updateEmailSettingsSchema }), asyncHandler(updateEmailSettings));

export default router;
