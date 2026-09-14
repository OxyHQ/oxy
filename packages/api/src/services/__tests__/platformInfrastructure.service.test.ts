import { infrastructureSnapshot } from '../platformInfrastructure.service';

const now = 100_000;
const member = (instanceId: string, region = 'us-west-2') => ({ member: { instanceId, region, service: 'mention', label: region, coordinates: [-122, 45] as [number, number], status: 'online' as const }, seenAt: now });

describe('live infrastructure registry', () => {
  it('aggregates replicas while preserving services and new regions', () => {
    const nodes = infrastructureSnapshot([member('a'), member('b'), member('c', 'eu-central-1')], now);
    expect(nodes).toHaveLength(2);
    expect(nodes.find(node => node.region === 'us-west-2')).toMatchObject({ instances: 2, services: ['mention'], status: 'online' });
  });
  it('expires a crashed instance and removes a region once its last instance disappears', () => {
    expect(infrastructureSnapshot([member('a')], now + 44_999)).toHaveLength(1);
    expect(infrastructureSnapshot([member('a')], now + 45_000)).toEqual([]);
  });
  it('does not call a partly unhealthy region fully online', () => {
    expect(infrastructureSnapshot([member('a'), { ...member('b'), member: { ...member('b').member, status: 'unknown' } }], now)[0].status).toBe('degraded');
  });
});
