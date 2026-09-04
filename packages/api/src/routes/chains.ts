/**
 * `/chains` — the app-authored write to a person's signed chain.
 *
 * Separate from `/identity/records` on purpose, and the split is the security
 * story rather than tidiness. That route is USER-authenticated and binds
 * `env.subject` to the caller: a person signing on their own device. This one is
 * SERVICE-authenticated and writes on someone else's behalf, so it answers to a
 * different question — not "is this you?" but "may this application write this
 * kind of record for this person?".
 *
 * The route itself decides almost nothing. It checks the scope, then hands the
 * request to `appChainWrite.service`, where the namespace boundary and the
 * custodial signature live. Keeping the decision out of the router is what lets
 * the boundary be tested against a real database without an HTTP layer.
 */

import { Router, type Response } from 'express';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, ForbiddenError } from '../utils/error';
import { logger } from '../utils/logger';
import {
  appendChainRecordSchema,
  readChainRecordsQuerySchema,
  type AppendChainRecordBody,
  type ReadChainRecordsQuery,
} from '../schemas/chains.schemas';
import { appendAppRecord, CHAINS_WRITE_SCOPE } from '../services/appChainWrite.service';
import { readPublicChainRecords, CHAINS_READ_SCOPE } from '../services/appChainRead.service';

const router = Router();

/** Assert the requesting credential carries the chain-write scope. */
function assertChainsScope(req: ServiceAuthRequest): void {
  const scopes = req.serviceApp?.scopes ?? [];
  if (!scopes.includes(CHAINS_WRITE_SCOPE)) {
    throw new ForbiddenError(`Missing required scope: ${CHAINS_WRITE_SCOPE}`);
  }
}

/**
 * POST /chains/records — append a record to `oxyUserId`'s chain.
 *
 * Requires the `chains:write` scope, a matching user OAuth grant, AND that
 * `collection` falls under one of the calling application's `chainNamespaces`.
 * Oxy issues and signs the envelope
 * (`issuer = OXY_DID`); the application never holds a chain signing key.
 *
 * 201 with the stored record on success. A namespace violation is 403 rather
 * than 404: the caller is authenticated and the answer is "not yours to write",
 * which is what it needs to know. A rejected envelope is 400. An environment
 * with no custodial key answers 503 — it is a deployment state, not the caller's
 * mistake, and it must not read as "accepted" to a retrying client.
 */
router.post(
  '/records',
  serviceAuthMiddleware,
  validate({ body: appendChainRecordSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertChainsScope(req);

    const appId = req.serviceApp?.appId;
    if (!appId) {
      throw new ForbiddenError('Service credential carries no application');
    }

    const body = req.body as AppendChainRecordBody;
    const result = await appendAppRecord({
      appId,
      oxyUserId: body.oxyUserId,
      collection: body.collection,
      rkey: body.rkey,
      record: body.record,
    });

    if (!result.ok) {
      switch (result.reason) {
        case 'namespace_forbidden':
          // Logged because a credential reaching for another app's namespace is
          // worth seeing, whether it is a misconfiguration or something worse.
          logger.warn('chains/records: collection outside the application namespace', {
            appId,
            collection: body.collection,
          });
          throw new ForbiddenError('collection is not within this application’s chain namespaces');
        case 'unknown_application':
          throw new ForbiddenError('Service credential does not name a known application');
        case 'subject_forbidden':
          throw new ForbiddenError(
            'The subject has not authorized this application to write chain records',
          );
        case 'signing_disabled':
          res.status(503).json({ error: 'Chain signing is not configured on this deployment' });
          return;
        case 'rejected':
          throw new BadRequestError(`Record rejected: ${result.detail ?? 'unknown'}`);
      }
    }

    res.status(201).json({
      recordId: result.record.recordId,
      seq: result.record.seq,
      envelope: result.record.envelope,
      verified: result.record.verified,
    });
  }),
);

/**
 * GET /chains/records?authors=&collections=&since=&limit= — records from MANY
 * subjects, oldest first. This is what an app projects a cross-app feed from:
 * "records of these people, of these lexicons, since this cursor".
 *
 * Requires `chains:read`. What it can return is narrowed SERVER-SIDE to the
 * collections `chainCollectionPolicy` declares public — a request naming a
 * private collection gets an empty page, not an error, because "you may not read
 * that" and "there is nothing there" should look the same from outside.
 *
 * `nextCursor` is opaque. Callers hand it back rather than building one, and
 * MUST re-poll from slightly before their last position and dedupe by
 * `recordId`: `created_at` is a transaction-start time, so a row can commit
 * behind a cursor that already passed it (see `listRecordsByAuthors`).
 */
router.get(
  '/records',
  serviceAuthMiddleware,
  validate({ query: readChainRecordsQuerySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    const scopes = req.serviceApp?.scopes ?? [];
    if (!scopes.includes(CHAINS_READ_SCOPE)) {
      throw new ForbiddenError(`Missing required scope: ${CHAINS_READ_SCOPE}`);
    }

    const query = req.query as unknown as ReadChainRecordsQuery;
    const page = await readPublicChainRecords({
      oxyUserIds: query.authors,
      collections: query.collections,
      since: query.since ?? null,
      limit: query.limit,
    });

    res.json(page);
  }),
);

export default router;
