/**
 * `POST /hub/session` — a Cloudflare Pages Functions DIRECTORY route.
 *
 * A directory (`functions/`, file-based routing), NEVER an advanced-mode
 * `dist/_worker.js`. That is a recorded deploy failure, not a preference: CF
 * Pages was not detecting or invoking the advanced-mode worker on this project
 * at all, reproduced even on the direct `pages.dev` URL. Deploy with
 * `bunx wrangler`, never npm/npx — npm's Arborist rejects the repo-root
 * `overrides` (`npm error EOVERRIDE`).
 *
 * Every file under `functions/hub/` is this same three-line shape: the logic
 * lives in `hub/handlers.ts` so it is testable with `bun test` and depends on
 * nothing Worker-specific.
 */

import { handleHubSession } from '../../hub/handlers';
import type { HubEnv } from '../../hub/upstream';

export async function onRequestPost(context: {
  request: Request;
  env: HubEnv;
}): Promise<Response> {
  return handleHubSession(context.request, context.env);
}
