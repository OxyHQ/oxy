/**
 * PUBLIC Oxy Updates manifest endpoint (expo-updates v1 protocol).
 *
 *   GET /updates/v1/apps/:clientId/manifest
 *
 * No auth, no CSRF — mounted BEFORE the CSRF group in `server.ts`. A device
 * identifies its app by the `:clientId` (an `ApplicationCredential.publicKey`,
 * `oxy_dk_…`) and its `(channel, runtimeVersion, platform)` via the expo-updates
 * request headers. The response is a signed `multipart/mixed` manifest or
 * directive assembled by the manifest service.
 *
 * Only genuinely malformed/missing REQUIRED protocol headers (platform, runtime,
 * protocol version) produce a 400. An unknown channel or an up-to-date client is
 * a normal `noUpdateAvailable` directive (or a 204 on protocol 0), never an error.
 */

import express from 'express';
import { and, eq } from 'drizzle-orm';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../utils/logger';
import { getDb } from '../config/postgres';
import { applicationCredentials, applications } from '../db/schema';
import { isCredentialUsable } from '../utils/credentialUsability';
import {
  buildManifestResponse,
  type ManifestRequest,
} from '../services/updates/manifest.service';
import { CodeSigningNotConfiguredError } from '../services/updates/signing.service';

const router = express.Router();

/**
 * Dedicated limiter for the public manifest endpoint. Anonymous, so keyed on the
 * privacy-preserving hashed IP (never raw `req.ip`). Generous — a device polls
 * for updates on foreground/interval and many devices share a NAT egress IP.
 */
const manifestLimiter = rateLimit({
  prefix: 'rl:updates:manifest:',
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many update checks. Please slow down.',
  keyGenerator: (req: express.Request) => `updates:manifest:${hashedIpKey(req)}`,
});

/** Read a single header value; returns undefined for absent or multi-valued headers. */
function singleHeader(req: express.Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extract one key from an Expo SFV dictionary header (`expo-extra-params`). We
 * only need `oxy-device-id`, so a minimal comma-split parse that unwraps a quoted
 * or bare token value is sufficient and avoids a structured-headers dependency.
 */
function extraParam(req: express.Request, key: string): string | undefined {
  const raw = singleHeader(req, 'expo-extra-params');
  if (!raw) return undefined;
  for (const member of raw.split(',')) {
    const eq = member.indexOf('=');
    if (eq === -1) continue;
    const name = member.slice(0, eq).trim();
    if (name !== key) continue;
    let value = member.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Resolve the Application id for a clientId (usable credential → active app), or
 * null. One round trip on a path every installed device polls: the credential
 * and its application are a join, not two lookups.
 */
async function resolveApplicationId(clientId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({
      applicationId: applications.id,
      status: applicationCredentials.status,
      expiresAt: applicationCredentials.expiresAt,
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .where(
      and(
        eq(applicationCredentials.publicKey, clientId),
        eq(applications.status, 'active')
      )
    );
  if (!row || !isCredentialUsable(row)) {
    return null;
  }
  return row.applicationId;
}

router.get(
  '/apps/:clientId/manifest',
  manifestLimiter,
  asyncHandler(async (req: express.Request, res: express.Response) => {
    // --- Required protocol headers (the only 400 conditions) ---
    const protocolRaw = req.headers['expo-protocol-version'];
    if (Array.isArray(protocolRaw)) {
      return res.status(400).json({ error: 'Unsupported protocol version' });
    }
    const protocolVersion = protocolRaw === undefined ? 0 : Number.parseInt(protocolRaw, 10);
    if (protocolVersion !== 0 && protocolVersion !== 1) {
      return res.status(400).json({ error: 'Unsupported protocol version. Expected 0 or 1.' });
    }

    const platform = singleHeader(req, 'expo-platform');
    if (platform !== 'ios' && platform !== 'android') {
      return res.status(400).json({ error: 'Unsupported platform. Expected ios or android.' });
    }

    const runtimeVersion = singleHeader(req, 'expo-runtime-version');
    if (!runtimeVersion) {
      return res.status(400).json({ error: 'Missing expo-runtime-version header.' });
    }

    // --- App resolution ---
    const applicationId = await resolveApplicationId(req.params.clientId);
    if (!applicationId) {
      return res.status(404).json({ error: 'Unknown application client id.' });
    }

    const input: ManifestRequest = {
      applicationId,
      platform,
      runtimeVersion,
      channelName: singleHeader(req, 'expo-channel-name'),
      currentUpdateId: singleHeader(req, 'expo-current-update-id'),
      embeddedUpdateId: singleHeader(req, 'expo-embedded-update-id'),
      protocolVersion: protocolVersion as 0 | 1,
      expectSignature: singleHeader(req, 'expo-expect-signature') !== undefined,
      deviceKey: extraParam(req, 'oxy-device-id'),
    };

    let response;
    try {
      response = await buildManifestResponse(input);
    } catch (error) {
      if (error instanceof CodeSigningNotConfiguredError) {
        // A signed manifest was requested but the signing key is unconfigured.
        // Serving an unsigned manifest to a code-signing client would be rejected
        // anyway; fail loudly so the misconfiguration is visible.
        logger.error('Update manifest requested with signing but no key configured', {
          clientId: req.params.clientId,
          runtimeVersion,
          platform,
        });
        return res.status(500).json({ error: 'Code signing is not configured on this server.' });
      }
      throw error;
    }

    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value);
    }
    res.status(response.status);
    if (response.body) {
      return res.end(response.body);
    }
    return res.end();
  })
);

export default router;
