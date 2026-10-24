import { z } from '@oxy.so/zod4';
import { identityLinkIdSchema } from '@oxy.so/contracts';

// /identity/link/:linkId
export const identityLinkParams = z.object({ linkId: identityLinkIdSchema });
