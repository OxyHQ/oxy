import {
  profileAccessInputSchema,
  profileAccessDecisionSchema,
  type ProfileAccessInput,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';

export class SafetyApi {
  constructor(private readonly ctx: OxyContext) {}
  /** Server callers must explicitly supply the incoming user bearer or null for anonymous access. */
  async profileAccess(input: ProfileAccessInput, options?: { accessToken: string | null }) {
    if (this.ctx.service && options === undefined)
      throw new Error('Server profile access requires an explicit requester bearer or null');
    return profileAccessDecisionSchema.parse(
      await this.ctx.request(
        'GET',
        '/safety/profile-access',
        profileAccessInputSchema.parse(input),
        {
          cache: false,
          ...(options
            ? {
                skipAuth: true,
                headers: options.accessToken
                  ? { Authorization: `Bearer ${options.accessToken}` }
                  : {},
              }
            : {}),
        },
      ),
    );
  }
}
