import { stubbedClient } from './helpers';

describe('oxy.addresses', () => {
  it('never caches private destinations and scopes requests to the current account', async () => {
    const { oxy, request } = stubbedClient();
    request.mockResolvedValue([]);
    await oxy.addresses.list();
    expect(request).toHaveBeenCalledWith('GET', '/addresses', undefined, { cache: false });
    const input = {
      recipientName: 'A Person',
      line1: '1 Road',
      city: 'Dublin',
      postalCode: '',
      country: 'IE',
    };
    await oxy.addresses.create(input);
    expect(request).toHaveBeenCalledWith('POST', '/addresses', input, { cache: false });
    await oxy.addresses.update('id/other', { isDefault: true });
    expect(request).toHaveBeenCalledWith(
      'PATCH',
      '/addresses/id%2Fother',
      { isDefault: true },
      { cache: false },
    );
    await oxy.addresses.delete('id/other');
    expect(request).toHaveBeenCalledWith('DELETE', '/addresses/id%2Fother', undefined, {
      cache: false,
    });
    oxy.dispose();
  });
});
