/**
 * `OxyServer`'s `session`: the client session API, plus the reviewed
 * supervised-action lane its auth middleware validates through (ADR 0041).
 *
 * Server-only, so the Zod schemas parse here; `../api/session.ts` stays on the
 * client entry without them.
 */
import {
  type SupervisedAction,
  safetySessionInputSchema,
  safetySessionValidationSchema,
} from '@oxy.so/contracts';
import { SessionApi, type SessionValidateOptions, type SessionValidation } from '../api/session';
import type { User } from '../models/interfaces';
import { normalizeUserIdentity } from '../utils/userIdentity';

export interface ServerSessionValidateOptions extends SessionValidateOptions {
  /**
   * A reviewed route category. Oxy then validates the bearer through this
   * service's live `safety:<action>:v1` authority, the only lane a supervised
   * account's session passes.
   */
  supervisedAction?: SupervisedAction;
}

export class ServerSessionApi extends SessionApi {
  override async validate(
    sessionId: string,
    options: ServerSessionValidateOptions = {},
  ): Promise<SessionValidation> {
    const { supervisedAction, ...rest } = options;
    if (!supervisedAction) return super.validate(sessionId, rest);
    if (!this.ctx.service?.available || !options.accessToken) {
      throw new Error(
        'Reviewed supervision validation requires service identity and the original bearer',
      );
    }
    try {
      const validation = safetySessionValidationSchema.parse(
        await this.ctx.service.request(
          'POST',
          '/safety/service/session',
          safetySessionInputSchema.parse({
            sessionId,
            accessToken: options.accessToken,
            action: supervisedAction,
          }),
          { cache: false, retry: false, serviceTokenScopes: ['safety:decide'] },
        ),
      );
      return { ...validation, user: normalizeUserIdentity(validation.user) as User };
    } catch (error) {
      // The session is gone: drop any user cached for it (#196).
      this.ctx.oxy.cache.delete(`GET:/session/user/${sessionId}`);
      throw error;
    }
  }
}
