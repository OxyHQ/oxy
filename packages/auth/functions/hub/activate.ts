/**
 * `POST /hub/activate` — a Cloudflare Pages Functions DIRECTORY route.
 *
 * See `session.ts` for why this is a directory route and not an advanced-mode
 * `dist/_worker.js`, and why every file here is a three-line adapter over
 * `hub/handlers.ts`.
 */

import { handleHubActivate } from '../../hub/handlers';
import type { HubEnv } from '../../hub/upstream';

export async function onRequestPost(context: {
  request: Request;
  env: HubEnv;
}): Promise<Response> {
  return handleHubActivate(context.request, context.env);
}
