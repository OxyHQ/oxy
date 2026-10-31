import type { DeviceCredential } from './SessionClient';

/** Isolated experiment: no shared token store or bearer-bearing mint request. */
export function createExperimentalContextTransport(baseURL: string, fetcher: typeof fetch = fetch) {
  const base = new URL(baseURL);
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('Context transport requires an HTTPS origin');
  }

  async function read(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetcher(new URL(path, base).href, {
      ...init,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Context binding unavailable');
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
      throw new Error('Invalid context response');
    }
    return envelope.data;
  }

  return {
    mint(credential: DeviceCredential): Promise<unknown> {
      return read('/session/device/context-token-v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: credential.deviceId,
          deviceSecret: credential.deviceSecret,
        }),
      });
    },
    async readState(accessToken: string): Promise<unknown> {
      const body = await read('/session/device/state', {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!body || typeof body !== 'object' || !('state' in body)) {
        throw new Error('Invalid device state response');
      }
      return body.state;
    },
    readDirectory(accessToken: string): Promise<unknown> {
      return read('/session/device/directory', {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    },
  };
}
