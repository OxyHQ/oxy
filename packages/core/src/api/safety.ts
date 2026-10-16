import type { ProfileAccessInput } from '@oxy.so/contracts';
import {
  profileAccessDecisionCheck,
  profileAccessInputCheck,
  parseContract,
} from '@oxy.so/contracts/client';
import type { OxyContext } from '../client/context';

export class SafetyApi {
  constructor(private readonly ctx: OxyContext) {}
  /** Server callers must explicitly supply the incoming user bearer or null for anonymous access. */
  async profileAccess(input: ProfileAccessInput, options?: { accessToken: string | null }) {
    if (this.ctx.service && options === undefined)
      throw new Error('Server profile access requires an explicit requester bearer or null');
    return parseContract(
      profileAccessDecisionCheck,
      await this.ctx.request(
        'GET',
        '/safety/profile-access',
        parseContract(profileAccessInputCheck, input),
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
