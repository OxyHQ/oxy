import { stubbedClient } from './helpers';

describe('oxy.contentClaims', () => {
  it('posts an owner’s counter-notice, uncached, and returns the answer', async () => {
    const { oxy, request } = stubbedClient('owner');
    const answer = {
      id: 'n1',
      reference: 'OXY-7K3M-9Q2D',
      state: 'counter_noticed' as const,
      fileIds: ['f1'],
    };
    request.mockResolvedValue(answer);
    const notice = {
      reference: 'OXY-7K3M-9Q2D',
      subscriber: {
        name: 'Grace Owner',
        address: '1 Harbor Way, Arlington, VA 22201, USA',
        phone: '+1 555 010 2030',
        email: 'grace@example.com',
      },
      material: { description: 'A photo of my garden.', location: 'https://mention.earth/p/1' },
      explanation: 'I took this photo myself; it is not the claimant’s.',
      statements: {
        perjury: true as const,
        jurisdiction: true as const,
        serviceOfProcess: true as const,
        disclosure: true as const,
      },
      signature: 'Grace Owner',
    };
    await expect(oxy.contentClaims.submitCounterNotice(notice)).resolves.toBe(answer);
    expect(request).toHaveBeenCalledWith('POST', '/content-claims/counter-notices', notice, {
      cache: false,
    });
  });
});
