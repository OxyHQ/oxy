import { integerCheck, isoDateTime, utf16MaxLength, utf16MinLength } from '@oxy.so/contracts';
import { z } from 'zod';

const region = z.string().regex(/^(?:edge-[a-z]{3}|[a-z]{2}(?:-[a-z]+)+-\d|[a-z]{3}\d|unknown)$/);
const service = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const platformActivityBatchSchema = z
  .array(
    z
      .object({
        region,
        sourceRegion: region.optional(),
        targetRegion: region.optional(),
        sourceService: service.optional(),
        targetService: service.optional(),
        service,
        scope: z.enum(['internal', 'external']),
        direction: z.enum(['inbound', 'outbound']),
        activityType: z.enum(['identity', 'ai', 'communication', 'media', 'platform']),
        requests: z.number().check(integerCheck()).min(1).max(1_000_000),
        windowStartedAt: z.string().check(isoDateTime()),
        emittedAt: z.string().check(isoDateTime()),
      })
      .strict()
      .refine((event) => {
        const emittedAt = Date.parse(event.emittedAt);
        return (
          emittedAt >= Date.now() - 60_000 &&
          emittedAt <= Date.now() + 5_000 &&
          Date.parse(event.windowStartedAt) <= emittedAt
        );
      }, 'Activity window must be current'),
  )
  .min(1)
  .max(256);

export const infrastructureHeartbeatSchema = z
  .object({
    instanceId: z.string().guid(),
    service,
    region,
    label: z.string().check(utf16MinLength(1)).check(utf16MaxLength(80)),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    status: z.enum(['online', 'degraded', 'offline', 'unknown']),
    removed: z.boolean().optional(),
  })
  .strict();
