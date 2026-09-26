import { z } from 'zod';
import { identityLinkIdSchema } from '@oxy.so/contracts';

// /identity/link/:linkId
export const identityLinkParams = z.object({ linkId: identityLinkIdSchema });
