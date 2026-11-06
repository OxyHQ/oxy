import { DEVICE_APP_TOKEN_ERROR_CODES, deviceAppTokenResponseSchema } from '@oxy.so/contracts';
import { z } from 'zod';

/** An application's token (ADR 0058), inside the API data envelope. */
export const deviceAppTokenEnvelopeSchema = z.object({
  data: deviceAppTokenResponseSchema,
});

/** Every refusal is one code of `DEVICE_APP_TOKEN_ERROR_CODES`, or a rate limit. */
export const deviceAppTokenErrorSchema = z.object({ error: z.enum(DEVICE_APP_TOKEN_ERROR_CODES) });
