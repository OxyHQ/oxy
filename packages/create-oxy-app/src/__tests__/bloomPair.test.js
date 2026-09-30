import { describe, expect, test } from 'bun:test';
import { assertPublishedBloomPair } from '../../scripts/assert-bloom-pair.mjs';

const pair = (bloom) => new Map([
  ['@oxy.so/services@^9.0.0', '9.2.0'],
  ['@oxy.so/bloom@^5.1.0', bloom],
]);

const registry = async (spec, field) => {
  if (spec === '@oxy.so/services@9.2.0' && field === 'peerDependencies') {
    return { '@oxy.so/bloom': '^5.1.0' };
  }
  if (spec === '@oxy.so/bloom@^5.1.0' && field === 'version') return ['5.1.0', '5.4.1'];
  throw new Error(`Unexpected registry lookup ${spec} ${field}`);
};

describe('published scaffold Services/Bloom compatibility', () => {
  test('accepts a published pair without requiring unreleased workspace majors', async () => {
    await expect(assertPublishedBloomPair(pair('5.4.1'), registry)).resolves.toBeUndefined();
  });

  test('rejects a resolvable Bloom major outside the selected Services peer', async () => {
    await expect(assertPublishedBloomPair(pair('6.0.0'), registry)).rejects.toThrow('outside Services 9.2.0');
  });

  test('does not treat missing peer metadata as compatibility', async () => {
    await expect(assertPublishedBloomPair(pair('5.4.1'), async () => ({}))).rejects.toThrow('no Bloom peer');
  });

  test('fails closed when the registry cannot verify the pair', async () => {
    await expect(assertPublishedBloomPair(pair('5.4.1'), async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
});
