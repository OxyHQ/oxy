import { holderContextEvidenceV1ResponseSchema } from '@oxy.so/contracts';
import { z } from 'zod';

/** The holder endpoint's observed binding, with no bearer or device secret. */
export const holderContextEvidenceV1EnvelopeSchema = z.object({
  data: holderContextEvidenceV1ResponseSchema,
});

export const holderContextEvidenceV1ErrorSchema = z.object({ error: z.string() });
