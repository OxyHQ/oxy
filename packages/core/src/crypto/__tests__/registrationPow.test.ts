/**
 * The client half of registration proof-of-work: `solveRegistrationPow` must
 * find a nonce that an INDEPENDENT hasher (not the one it used to search)
 * agrees clears the shared difficulty — otherwise the client and the server
 * (`packages/api`, which hashes with Node's `crypto`, not `@noble/hashes`)
 * could silently disagree about what "solved" means.
 */

import crypto from 'node:crypto';
import {
  meetsRegistrationPowDifficulty,
  registrationPowMessage,
  REGISTRATION_POW_DIFFICULTY_BITS,
} from '@oxy.so/protocol';
import { solveRegistrationPow } from '../registrationPow';

function nodeDigestOf(publicKey: string, timestamp: number, nonce: string): string {
  return crypto
    .createHash('sha256')
    .update(registrationPowMessage(publicKey, timestamp, nonce))
    .digest('hex');
}

describe('solveRegistrationPow', () => {
  it('finds a nonce that Node crypto (not @noble/hashes) also agrees clears the difficulty', async () => {
    const publicKey = 'test-public-key';
    const timestamp = 1_700_000_000_000;

    const nonce = await solveRegistrationPow(publicKey, timestamp);
    const digest = nodeDigestOf(publicKey, timestamp, nonce);

    expect(meetsRegistrationPowDifficulty(digest, REGISTRATION_POW_DIFFICULTY_BITS)).toBe(true);
  });

  it('is deterministic: the same publicKey/timestamp always yields the same nonce', async () => {
    const publicKey = 'deterministic-key';
    const timestamp = 1_700_000_000_001;

    const first = await solveRegistrationPow(publicKey, timestamp);
    const second = await solveRegistrationPow(publicKey, timestamp);

    expect(second).toBe(first);
  });

  it('binds the nonce to publicKey and timestamp, not just to itself', async () => {
    const timestamp = 1_700_000_000_002;
    const nonce = await solveRegistrationPow('bound-key', timestamp);

    // The nonce solves its OWN message under the shared difficulty check...
    expect(
      meetsRegistrationPowDifficulty(nodeDigestOf('bound-key', timestamp, nonce), REGISTRATION_POW_DIFFICULTY_BITS)
    ).toBe(true);
    // ...but the message it was solved for is bound to that exact publicKey —
    // reusing the nonce string under an unrelated one hashes to something
    // unrelated, i.e. `registrationPowMessage` actually mixes `publicKey` in
    // rather than the digest depending on `nonce` alone.
    expect(registrationPowMessage('bound-key', timestamp, nonce)).not.toBe(
      registrationPowMessage('a-different-key', timestamp, nonce)
    );
  });
});
