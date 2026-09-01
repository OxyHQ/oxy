/**
 * Transparency Log Routes — the public audit surface.
 *
 * Serves Oxy's signed commitments to every subject's chain head, plus the
 * inclusion proofs that let anyone verify their own head is inside a published
 * root WITHOUT trusting this server:
 *  - `GET /transparency/checkpoints/latest` — newest signed checkpoint
 *  - `GET /transparency/checkpoints/:index` — one checkpoint by index
 *  - `GET /transparency/checkpoints?since=` — the chain, oldest first, for
 *    walking `prevCheckpointHash` links
 *  - `GET /transparency/proof?subject=&index=` — inclusion proof for a subject
 *
 * Public, cacheable, CORS-open, no auth, no CSRF — like the DID documents, this
 * is public infrastructure, and an audit trail nobody can read is not an audit
 * trail. Mounted OUTSIDE the CSRF group in `server.ts`.
 *
 * Deliberately NOT offered: any endpoint that returns the committed snapshot or
 * otherwise enumerates subjects. A proof is served for a subject the caller
 * already knows; the leaf set stays server-side.
 */

import {
  safeParseContract,
  transparencyCheckpointListSchema,
  transparencyCheckpointSchema,
  transparencyInclusionProofSchema,
} from '@oxyhq/contracts';
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { rateLimit } from '../middleware/rateLimiter';
import {
  getCheckpoint,
  getInclusionProof,
  getLatestCheckpoint,
  listCheckpoints,
} from '../services/transparency.service';
import { logger } from '../utils/logger';

const router = Router();

/** Page size cap so one request cannot pull the entire checkpoint history. */
const MAX_CHECKPOINT_PAGE = 200;
const DEFAULT_CHECKPOINT_PAGE = 50;

const transparencyReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  prefix: 'rl:transparency:read:',
});

router.use(transparencyReadLimiter);

/** Headers shared by every transparency response. */
function setTransparencyHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // A published checkpoint is immutable except for appended signatures/anchors,
  // so a short cache is safe and keeps auditing cheap.
  res.setHeader('Cache-Control', 'public, max-age=60');
}

function notFound(res: Response, message: string): Response {
  return res.status(404).json({ error: 'NOT_FOUND', message });
}

function badRequest(res: Response, message: string): Response {
  return res.status(400).json({ error: 'BAD_REQUEST', message });
}

function respondWithContract<T>(res: Response, schema: z.ZodType<T>, payload: unknown): Response {
  const parsed = safeParseContract(schema, payload);
  if (!parsed) {
    logger.error('Transparency response failed contract validation', {
      component: 'transparency',
    });
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Response contract violation' });
  }
  setTransparencyHeaders(res);
  return res.json(parsed);
}

/** Parse a non-negative integer query/param, or `null` when malformed. */
function parseNonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

// The chain, oldest first. Registered before `/checkpoints/:index` only for
// readability — Express matches the exact path first regardless.
router.get('/checkpoints', async (req: Request, res: Response) => {
  try {
    let since = 0;
    if (req.query.since !== undefined) {
      const parsedSince = parseNonNegativeInt(req.query.since);
      if (parsedSince === null) {
        return badRequest(res, 'since must be a non-negative integer');
      }
      since = parsedSince;
    }

    let limit = DEFAULT_CHECKPOINT_PAGE;
    if (req.query.limit !== undefined) {
      const parsedLimit = parseNonNegativeInt(req.query.limit);
      if (parsedLimit === null) {
        return badRequest(res, 'limit must be a non-negative integer');
      }
      limit = Math.min(Math.max(parsedLimit, 1), MAX_CHECKPOINT_PAGE);
    }

    return respondWithContract(res, transparencyCheckpointListSchema, {
      checkpoints: await listCheckpoints(since, limit),
    });
  } catch (error) {
    logger.error('Failed to list transparency checkpoints', error instanceof Error ? error : new Error(String(error)));
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list checkpoints' });
  }
});

// MUST stay above `/checkpoints/:index`, or `latest` is parsed as an index and
// the newest-checkpoint route becomes unreachable (a 400 instead of a result).
router.get('/checkpoints/latest', async (_req: Request, res: Response) => {
  try {
    const checkpoint = await getLatestCheckpoint();
    if (!checkpoint) {
      return notFound(res, 'No checkpoint has been published yet');
    }
    return respondWithContract(res, transparencyCheckpointSchema, checkpoint);
  } catch (error) {
    logger.error('Failed to read the latest transparency checkpoint', error instanceof Error ? error : new Error(String(error)));
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to read checkpoint' });
  }
});

router.get('/checkpoints/:index', async (req: Request, res: Response) => {
  try {
    const index = parseNonNegativeInt(req.params.index);
    if (index === null) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'index must be a non-negative integer' });
    }
    const checkpoint = await getCheckpoint(index);
    if (!checkpoint) {
      return notFound(res, 'Checkpoint not found');
    }
    return respondWithContract(res, transparencyCheckpointSchema, checkpoint);
  } catch (error) {
    logger.error('Failed to read a transparency checkpoint', error instanceof Error ? error : new Error(String(error)));
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to read checkpoint' });
  }
});

router.get('/proof', async (req: Request, res: Response) => {
  try {
    const subject = req.query.subject;
    if (typeof subject !== 'string' || subject.length === 0) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'subject is required' });
    }

    let index: number | undefined;
    if (req.query.index !== undefined) {
      const parsed = parseNonNegativeInt(req.query.index);
      if (parsed === null) {
        return res.status(400).json({ error: 'BAD_REQUEST', message: 'index must be a non-negative integer' });
      }
      index = parsed;
    }

    const proof = await getInclusionProof(subject, index);
    if (!proof) {
      return notFound(res, 'No inclusion proof for that subject');
    }
    return respondWithContract(res, transparencyInclusionProofSchema, proof);
  } catch (error) {
    logger.error('Failed to build a transparency inclusion proof', error instanceof Error ? error : new Error(String(error)));
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to build proof' });
  }
});

export default router;
