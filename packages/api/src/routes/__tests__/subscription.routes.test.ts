/**
 * Locks the legacy self-service subscription upgrade path shut.
 * Plan changes are owned by Stripe billing (`/billing/*`), not session auth.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import subscriptionRoutes from '../subscription.routes';

async function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number }> {
  const app = express();
  app.use(express.json());
  app.use('/subscription', subscriptionRoutes);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('subscription routes', () => {
  it('does not expose a self-service PUT upgrade endpoint', async () => {
    const response = await request('PUT', '/subscription/user-1', { plan: 'pro' });
    expect(response.status).toBe(404);
  });
});
