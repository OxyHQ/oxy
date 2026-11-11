/**
 * Which part of the API this process serves.
 *
 * One image, two ECS services:
 *
 *   - `platform` (the default, and what every deployment ran before this file):
 *     the whole API on `api.oxy.so`, every route, every scheduled job.
 *   - `inbosh`: only the email backend on `api.inbo.sh` — `/health`, `/email/*`
 *     (including `/email/ai`, `/email/proxy`, `/email/inbound`, `/email/feedback`)
 *     and the Inbox MCP host — against the same Postgres and Redis. Nothing else
 *     is mounted and no platform job runs.
 *
 * The role is chosen by `OXY_API_ROLE` at startup. An unset or empty value is
 * `platform`, so an existing task definition behaves exactly as it did. A value
 * that is set and not one of the two is a boot error: a typo must never fall
 * back to serving the whole platform under the Inbosh hostname.
 *
 * ## Who runs the email maintenance
 *
 * The 60 s email maintenance (snooze, reminders, scheduled send,
 * `processEmailOutbox`) must run in exactly ONE place, or scheduled sends and
 * push notifications are duplicated. `EMAIL_MAINTENANCE_ENABLED` decides, and its
 * default depends on the role: the `platform` service keeps running it (today's
 * behaviour, ownership is NOT moved by adding the role), the `inbosh` service
 * does not unless it is set to `true` explicitly. Moving the work is two
 * deliberate settings, one on each service, never an accident of a default.
 *
 * The normalized Inbox event outbox worker is gated by its own
 * `INBOX_EVENT_OUTBOX_WORKER_ENABLED` (off unless set), exactly as before; the
 * same rule applies — set it on one service only.
 */

export type ApiRole = 'platform' | 'inbosh';

const API_ROLES: readonly ApiRole[] = ['platform', 'inbosh'];

export class ApiRoleError extends Error {
  constructor(value: string) {
    super(`OXY_API_ROLE must be one of ${API_ROLES.join(', ')} (or unset); got "${value}"`);
    this.name = 'ApiRoleError';
  }
}

/** The role this process serves. Throws {@link ApiRoleError} for an unknown value. */
export function getApiRole(env: NodeJS.ProcessEnv = process.env): ApiRole {
  const value = env.OXY_API_ROLE?.trim();
  if (!value) return 'platform';
  const role = API_ROLES.find((candidate) => candidate === value);
  if (!role) throw new ApiRoleError(value);
  return role;
}

/** Whether this process runs the 60 s email maintenance (see the header). */
export function isEmailMaintenanceEnabled(
  role: ApiRole,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.EMAIL_MAINTENANCE_ENABLED?.trim().toLowerCase();
  if (value) return ['true', '1', 'yes'].includes(value);
  return role === 'platform';
}
