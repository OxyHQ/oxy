import { Router, type Request, type Response } from 'express';
import axios from 'axios';
import { authMiddleware } from '../middleware/auth';
import {
  machineApplicationLimiter,
  machineCredentialLimiter,
  machineOrUserAuth,
} from '../middleware/machineCredential';

const router = Router();

const ALIA_BASE_URL = 'https://api.alia.onl/v1';
const ALIA_API_KEY = process.env.ALIA_API_KEY;
const ALIA_PROXY_ERROR_MESSAGE = 'Failed to reach Alia API';

const isReadableStream = (value: unknown): value is NodeJS.ReadableStream => {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NodeJS.ReadableStream).pipe === 'function' &&
    typeof (value as NodeJS.ReadableStream).on === 'function'
  );
};

const toSafeErrorMessage = (data: unknown): unknown => {
  if (data === undefined || data === null || isReadableStream(data)) {
    return ALIA_PROXY_ERROR_MESSAGE;
  }

  if (typeof data !== 'object') {
    return data;
  }

  try {
    JSON.stringify(data);
    return data;
  } catch {
    return ALIA_PROXY_ERROR_MESSAGE;
  }
};

const proxyAliaJson = async (req: Request, res: Response, path: string) => {
  const apiKey = ALIA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ALIA_API_KEY not configured on server' });
    return;
  }

  try {
    const response = await axios.post(`${ALIA_BASE_URL}${path}`, req.body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      responseType: 'json',
    });
    res.json(response.data);
  } catch (err: any) {
    const status = err.response?.status ?? 502;
    const message = toSafeErrorMessage(err.response?.data);
    res.status(status).json({ error: 'ALIA_PROXY_ERROR', message });
  }
};

/**
 * POST /v1/chat/completions (also mounted at /alia/chat/completions)
 * Proxies chat completion requests to the Alia API.
 * Supports both streaming (SSE) and non-streaming responses.
 *
 * ## Two principals, one route
 *
 * `machineOrUserAuth` accepts EITHER the ordinary user session bearer this route
 * has always taken, or an `oxy_sk_…` machine credential holding
 * `inference:invoke` (issue #972 §2.3). The second is the whole point of the
 * machine credential type: `https://api.oxy.so/v1` with a single bearer string
 * is what a stock OpenAI SDK is configured with, and this is the one path in the
 * repository an SDK already points at.
 *
 * The two machine limiters run only for machine-authenticated requests (they
 * `skip` when there is no principal to key on) and are what bounds an API key's
 * spend of the shared upstream budget until the usage ledger lands (§7). They
 * are mounted here, after the lane, because their keys do not exist before it.
 */
router.post(
  '/chat/completions',
  machineOrUserAuth('inference:invoke'),
  machineCredentialLimiter,
  machineApplicationLimiter,
  async (req: Request, res: Response) => {
    const apiKey = ALIA_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'ALIA_API_KEY not configured on server' });
      return;
    }

    const isStreaming = req.body.stream === true;

    try {
      const response = await axios.post(`${ALIA_BASE_URL}/chat/completions`, req.body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        responseType: isStreaming ? 'stream' : 'json',
      });

      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        response.data.pipe(res);
      } else {
        res.json(response.data);
      }
    } catch (err: any) {
      const status = err.response?.status ?? 502;
      const message = toSafeErrorMessage(err.response?.data);
      res.status(status).json({ error: 'ALIA_PROXY_ERROR', message });
    }
  },
);

/** POST /v1/voice/token — LiveKit session mint for Alia voice (inbox, etc.). */
router.post('/voice/token', authMiddleware, (req, res) => proxyAliaJson(req, res, '/voice/token'));

/** POST /v1/voice/transcribe — speech-to-text for Alia chat input. */
router.post('/voice/transcribe', authMiddleware, (req, res) =>
  proxyAliaJson(req, res, '/voice/transcribe'),
);

export default router;
