import { platformActivityBatchSchema } from '../platformActivity.schema';

const event = () => ({ region: 'us-west-2', sourceRegion: 'us-west-2', targetRegion: 'us-west-2', sourceService: 'alia', targetService: 'oxy-api', service: 'alia', scope: 'internal', direction: 'outbound', activityType: 'ai', requests: 1, windowStartedAt: new Date().toISOString(), emittedAt: new Date().toISOString() });

describe('aggregate activity ingestion', () => {
  it('accepts real internal traffic even within one region', () => {
    expect(platformActivityBatchSchema.safeParse([event()]).success).toBe(true);
  });
  it('rejects identifiers, raw paths and arbitrary coordinates instead of publishing them', () => {
    for (const extra of [{ userId: 'private' }, { path: '/private' }, { ip: '203.0.113.8' }, { sourceCoordinates: [0, 0] }, { sourceCountry: 'ES' }]) {
      expect(platformActivityBatchSchema.safeParse([{ ...event(), ...extra }]).success).toBe(false);
    }
  });
  it('rejects replays, impossible counts, invalid directions and oversized batches', () => {
    for (const change of [{ emittedAt: '2020-01-01T00:00:00Z' }, { requests: -1 }, { requests: Infinity }, { direction: 'internal' }, { activityType: 'private' }]) {
      expect(platformActivityBatchSchema.safeParse([{ ...event(), ...change }]).success).toBe(false);
    }
    expect(platformActivityBatchSchema.safeParse(Array.from({ length: 257 }, event)).success).toBe(false);
  });
});
