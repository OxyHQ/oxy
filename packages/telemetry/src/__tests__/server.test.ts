import {
  activityFlow,
  metadataFromHeaders,
  normalizeActivityId,
  normalizeEdgePop,
  presenceBucket,
  presenceKeys,
  serviceFromPath,
} from '../server';

describe('server telemetry primitives', () => {
  it('prefers a validated forwarded PoP and accepts Cloudflare ray fallback', () => {
    expect(metadataFromHeaders({
      'x-oxy-edge-region': 'MAD',
      'cf-ray': 'deadbeef-CDG',
      'x-oxy-activity-id': 'anonymous-runtime-a1',
    })).toEqual({ edgePop: 'mad', activityId: 'anonymous-runtime-a1' });
    expect(metadataFromHeaders({ 'cf-ray': 'deadbeef-CDG' })).toEqual({ edgePop: 'cdg' });
  });

  it('rejects identifying or malformed metadata', () => {
    expect(normalizeEdgePop('Madrid')).toBeUndefined();
    expect(normalizeActivityId('short')).toBeUndefined();
    expect(metadataFromHeaders({ 'x-forwarded-for': '203.0.113.8' })).toEqual({});
  });

  it('reduces paths to bounded route groups', () => {
    expect(serviceFromPath('/messages/private-id')).toBe('messages');
    expect(serviceFromPath('/123/private-id')).toBe('platform');
    expect(activityFlow('edge-mad', 'messages')).toEqual({
      sourceRegion: 'edge-mad',
      service: 'messages',
      key: 'edge-mad|messages',
    });
  });

  it('creates current and previous cardinality buckets', () => {
    expect(presenceBucket(65_000)).toBe(2);
    expect(presenceKeys('edge-mad', 65_000)).toEqual([
      'platform-activity:clients:edge-mad:2',
      'platform-activity:clients:edge-mad:1',
    ]);
    expect(() => presenceBucket(1, 0)).toThrow(RangeError);
  });
});
