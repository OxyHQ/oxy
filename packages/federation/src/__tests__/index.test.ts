import type { NetworkId } from '../index';

describe('@oxy.so/federation', () => {
  it('accepts the supported network ids', () => {
    const networks: NetworkId[] = ['activitypub', 'atproto'];
    expect(networks).toEqual(['activitypub', 'atproto']);
  });
});
