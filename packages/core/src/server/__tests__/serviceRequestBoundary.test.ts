import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpService } from '../../HttpService';
import { OxyServer } from '../OxyServer';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

afterEach(() => jest.restoreAllMocks());

it('rejects foreign service URLs before minting credentials', async () => {
  const oxy = new OxyServer({ baseURL: 'https://api.oxy.so' });
  const mint = jest.spyOn(oxy, 'serviceToken');
  try {
    await expect(
      oxy.serviceRequest(
        'POST',
        'https://other.example/collect',
        {},
        {
          requesterToken: 'private-proof',
          actAs: 'person',
        },
      ),
    ).rejects.toThrow('configured API origin');
    expect(mint).not.toHaveBeenCalled();
  } finally {
    oxy.dispose();
  }
});

it('rejects foreign ordinary requests carrying requester proofs', async () => {
  const http = new HttpService({ baseURL: 'https://api.oxy.so' });
  const fetch = jest.spyOn(globalThis, 'fetch');
  try {
    await expect(
      http.request({
        method: 'POST',
        url: 'https://other.example/collect',
        headers: {
          'X-Oxy-Requester-Token': 'private-proof',
        },
      }),
    ).rejects.toThrow('configured API origin');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    http.dispose();
  }
});

it.each([302, 307])(
  'never forwards requester proof across a real HTTP %s redirect',
  async (status) => {
    let received = 0;
    const destination = createServer((_req, res) => {
      received++;
      res.end('{}');
    });
    const destinationUrl = await listen(destination);
    let originalProof: string | undefined;
    const origin = createServer((req, res) => {
      originalProof = req.headers['x-oxy-requester-token'] as string | undefined;
      res.writeHead(status, { location: `${destinationUrl}/collect` });
      res.end();
    });
    const baseURL = await listen(origin);
    const oxy = new OxyServer({ baseURL });
    jest.spyOn(oxy, 'serviceToken').mockResolvedValue('service-credential');
    try {
      await expect(
        oxy.serviceRequest(
          'POST',
          '/redirect',
          {},
          {
            requesterToken: 'private-proof',
            actAs: 'person',
            retry: false,
          },
        ),
      ).rejects.toBeDefined();
      expect(originalProof).toBe('private-proof');
      expect(received).toBe(0);
    } finally {
      oxy.dispose();
      await Promise.all([close(origin), close(destination)]);
    }
  },
);

it('keeps concurrent requester responses separate and reads revocation on every call', async () => {
  const subjects: string[] = [];
  let revoked = false;
  const server = createServer((req, res) => {
    const subject = req.headers['x-oxy-user-id'] as string;
    subjects.push(subject);
    if (revoked) {
      res.writeHead(403);
      res.end('{}');
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { subject } }));
    }, 20);
  });
  const oxy = new OxyServer({ baseURL: await listen(server) });
  jest.spyOn(oxy, 'serviceToken').mockResolvedValue('service-credential');
  const read = (subject: string) =>
    oxy.serviceRequest<{ subject: string }>('GET', '/private', undefined, {
      actAs: subject,
      taskId: `task-${subject}`,
      cache: true,
      deduplicate: true,
      retry: false,
    });
  try {
    expect(await Promise.all([read('A'), read('B')])).toEqual([{ subject: 'A' }, { subject: 'B' }]);
    revoked = true;
    await expect(read('A')).rejects.toBeDefined();
    expect(subjects).toEqual(['A', 'B', 'A']);
  } finally {
    oxy.dispose();
    await close(server);
  }
});
