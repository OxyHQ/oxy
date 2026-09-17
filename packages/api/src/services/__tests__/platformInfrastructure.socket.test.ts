jest.unmock('socket.io');
jest.unmock('socket.io-client');
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import * as redis from '../../config/redis';
import { initializePlatformInfrastructure, observeInfrastructure, stopPlatformInfrastructure, type InfrastructureNode } from '../platformInfrastructure.service';

type Snapshot = { nodes: InfrastructureNode[] };
function nextSnapshot(client: Socket, matches: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('platform_infrastructure', listener); reject(new Error('Infrastructure update missing')); }, 3_000);
    const listener = (snapshot: Snapshot) => {
      if (!matches(snapshot)) return;
      clearTimeout(timer);
      client.off('platform_infrastructure', listener);
      resolve(snapshot);
    };
    client.on('platform_infrastructure', listener);
  });
}

it('sends additions, removals and reconnect snapshots over a real socket without dashboard activity', async () => {
  const previousRegion = process.env.AWS_REGION;
  delete process.env.AWS_REGION;
  const redisMock = jest.spyOn(redis, 'getRedisClient').mockReturnValue(null);
  const server = createServer();
  const sockets = new Server(server);
  const namespace = sockets.of('/platform-activity');
  initializePlatformInfrastructure(namespace, () => true);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const client = io(`http://127.0.0.1:${address.port}/platform-activity`, { transports: ['websocket'], autoConnect: false });
  const member = { instanceId: 'test-instance', service: 'mention', region: 'eu-central-1', label: 'Frankfurt', coordinates: [8.68, 50.11] as [number, number], status: 'online' as const };
  try {
    const initial = nextSnapshot(client, snapshot => snapshot.nodes.length === 0);
    client.connect();
    await initial;
    const added = nextSnapshot(client, snapshot => snapshot.nodes.some(node => node.region === member.region));
    await observeInfrastructure('mention-app', member);
    expect((await added).nodes[0]).toMatchObject({ region: member.region, instances: 1, services: ['mention'] });
    client.disconnect();
    const reconnected = nextSnapshot(client, snapshot => snapshot.nodes.some(node => node.region === member.region));
    client.connect();
    await reconnected;
    const removed = nextSnapshot(client, snapshot => snapshot.nodes.length === 0);
    await observeInfrastructure('mention-app', member, true);
    expect((await removed).nodes).toEqual([]);
  } finally {
    client.disconnect();
    await observeInfrastructure('mention-app', member, true);
    await stopPlatformInfrastructure();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    redisMock.mockRestore();
    if (previousRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previousRegion;
  }
});
