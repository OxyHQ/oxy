import { deviceContextTokenV1ResponseSchema } from '@oxy.so/contracts';
import { z } from 'zod';

/** The holder endpoint returns its binding inside the API data envelope. */
export const deviceContextTokenV1EnvelopeSchema = z.object({
  data: deviceContextTokenV1ResponseSchema,
});

/** Validation, secret and unavailable-binding errors have only an error string. */
export const deviceContextTokenV1ErrorSchema = z.object({ error: z.string() });
