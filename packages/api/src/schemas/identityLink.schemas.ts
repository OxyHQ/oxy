import { z } from '@oxy.so/zod3';
import { identityLinkIdSchema } from '@oxy.so/contracts';

// /identity/link/:linkId
export const identityLinkParams = z.object({ linkId: identityLinkIdSchema });
