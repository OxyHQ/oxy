import { stubbedClient } from './helpers';

describe('oxy.console.onboarding', () => {
  it('reads the state without caching', async () => {
    const { oxy, request } = stubbedClient('me');
    const state = { termsCurrent: false };
    request.mockResolvedValue(state);
    await expect(oxy.console.onboarding.get()).resolves.toBe(state);
    expect(request).toHaveBeenCalledWith('GET', '/console/onboarding', undefined, { cache: false });
  });

  it('posts the terms acceptance', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue({});
    const input = {
      version: '2026-10-22',
      adultAcknowledged: true,
      aupAcknowledged: true,
      marketingOptIn: false,
    } as const;
    await oxy.console.onboarding.acceptTerms(input);
    expect(request).toHaveBeenCalledWith('POST', '/console/onboarding/terms', input, {
      cache: false,
    });
  });

  it('posts the use cases', async () => {
    const { oxy, request } = stubbedClient('me');
    request.mockResolvedValue({});
    await oxy.console.onboarding.saveUseCases({ useCases: [], description: 'x' });
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/console/onboarding/use-cases',
      { useCases: [], description: 'x' },
      { cache: false },
    );
  });
});
