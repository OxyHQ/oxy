/**
 * `oxy.apps.assertions` (ADR 0045): each call is one attempt with the person's
 * bearer — challenges are single-use, so nothing is cached, deduplicated or
 * retried — and every answer is checked against its contract before the SDK
 * trusts it.
 */

import { ContractCheckError } from '@oxy.so/contracts/client';
import { OxyServices } from '../../OxyServices';

const CHALLENGE = 'A'.repeat(43);
const KEY_ID = `${'B'.repeat(43)}=`;
const SINGLE_ATTEMPT = { cache: false, deduplicate: false, retry: false };

describe('oxy.apps.assertions', () => {
  let oxy: OxyServices;
  let request: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    request = jest.spyOn(oxy, 'request');
  });

  it('asks for a challenge', async () => {
    const answer = {
      challenge: CHALLENGE,
      requestHash: CHALLENGE,
      expiresAt: '2026-10-16T12:02:00.000Z',
      cloudProjectNumber: '123',
    };
    request.mockResolvedValue(answer);
    await expect(
      oxy.apps.assertions.challenge({ applicationId: 'app', platform: 'android' }),
    ).resolves.toEqual(answer);
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/apps/assertions/challenge',
      { applicationId: 'app', platform: 'android' },
      SINGLE_ATTEMPT,
    );
  });

  it('registers an App Attest key', async () => {
    request.mockResolvedValue({ keyId: KEY_ID });
    const input = {
      applicationId: 'app',
      keyId: KEY_ID,
      challenge: CHALLENGE,
      attestation: 'bw==',
    };
    await expect(oxy.apps.assertions.registerAttestKey(input)).resolves.toEqual({ keyId: KEY_ID });
    expect(request).toHaveBeenCalledWith('POST', '/apps/attest-keys', input, SINGLE_ATTEMPT);
  });

  it('trades a proof for an assertion', async () => {
    const answer = {
      assertion: 'a.b.c',
      applicationId: 'app',
      platform: 'web',
      expiresAt: '2026-10-16T12:05:00.000Z',
    };
    request.mockResolvedValue(answer);
    await expect(
      oxy.apps.assertions.create({ applicationId: 'app', platform: 'web' }),
    ).resolves.toEqual(answer);
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/apps/assertions',
      { applicationId: 'app', platform: 'web' },
      SINGLE_ATTEMPT,
    );
  });

  it('refuses an answer that is not the contract', async () => {
    request.mockResolvedValue({ assertion: 'not-a-jws', applicationId: 'app', platform: 'web' });
    await expect(
      oxy.apps.assertions.create({ applicationId: 'app', platform: 'web' }),
    ).rejects.toBeInstanceOf(ContractCheckError);
  });
});
