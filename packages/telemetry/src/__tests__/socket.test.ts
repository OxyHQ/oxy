/** @jest-environment node */
import { EventEmitter } from 'node:events';
import { observeTrafficSocket, socketTrafficType } from '../socket';
import type { TrafficFlow } from '../collector';

class TestSocket extends EventEmitter {
  handshake = { headers: { 'cf-ray': 'anonymous-MAD', authorization: 'private' } };
  nsp = { name: '/messages' };
  incoming = new Set<(event: string) => void>();
  outgoing = new Set<(event: string) => void>();
  onAny(listener: (event: string) => void) { this.incoming.add(listener); }
  onAnyOutgoing(listener: (event: string) => void) { this.outgoing.add(listener); }
  offAny(listener: (event: string) => void) { this.incoming.delete(listener); }
  offAnyOutgoing(listener: (event: string) => void) { this.outgoing.delete(listener); }
}

describe('socket traffic', () => {
  it('records real application directions and strips event identifiers and payloads', () => {
    const socket = new TestSocket();
    const events: TrafficFlow[] = [];
    observeTrafficSocket(socket, { record: event => events.push(event) }, 'syra', 'us-west-2');
    socket.incoming.forEach(listener => listener('player:private-track-id'));
    socket.outgoing.forEach(listener => listener('message:private-user-id'));
    expect(events).toEqual([
      expect.objectContaining({ scope: 'external', direction: 'inbound', sourceRegion: 'edge-mad', targetRegion: 'us-west-2', activityType: 'media' }),
      expect.objectContaining({ scope: 'external', direction: 'outbound', sourceRegion: 'us-west-2', targetRegion: 'edge-mad', activityType: 'communication' }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private|authorization|track-id|user-id/);
    socket.emit('disconnect');
    expect(socket.incoming.size + socket.outgoing.size).toBe(0);
  });

  it('uses only verified peer metadata for internal traffic and reads it at event time', () => {
    const socket = new TestSocket();
    const events: TrafficFlow[] = [];
    let peer: { service: string; region: string } | undefined;
    const stop = observeTrafficSocket(socket, { record: event => events.push(event) }, 'alia', 'us-west-2', { getPeer: () => peer });
    peer = { service: 'mention', region: 'eu-west-1' };
    socket.incoming.forEach(listener => listener('agent:update'));
    expect(events[0]).toMatchObject({ scope: 'internal', sourceService: 'mention', sourceRegion: 'eu-west-1', activityType: 'ai' });
    stop(); stop();
    expect(socket.listenerCount('disconnect')).toBe(0);
  });

  it('does not observe dashboard control namespaces or create events merely for connecting', () => {
    const socket = new TestSocket();
    const record = jest.fn();
    socket.nsp.name = '/platform-activity';
    observeTrafficSocket(socket, { record }, 'oxy-api', 'us-west-2');
    expect(socket.incoming.size + socket.outgoing.size).toBe(0);
    expect(record).not.toHaveBeenCalled();
    expect(socketTrafficType('arbitrary-private-value')).toBe('platform');
  });
});

describe('real Socket.IO transport', () => {
  it('observes events and namespace broadcasts without inventing acknowledgement traffic', async () => {
    const { Server } = await import('socket.io');
    const { io } = await import('socket.io-client');
    const { createServer } = await import('node:http');
    const server = createServer();
    const sockets = new Server(server);
    const events: TrafficFlow[] = [];
    sockets.on('connection', socket => {
      observeTrafficSocket(socket, { record: flow => events.push(flow) }, 'syra', 'us-west-2');
      socket.on('player:seek', (_position, acknowledge) => {
        acknowledge('ok');
        sockets.emit('player:state', { privateTrackId: 'never-published' });
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const client = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], extraHeaders: { 'X-Oxy-Edge-Region': 'NRT' } });
    try {
      await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
      const received = new Promise<void>(resolve => client.once('player:state', () => resolve()));
      await client.emitWithAck('player:seek', 42);
      await received;
      expect(events).toHaveLength(2);
      expect(events.map(flow => [flow.direction, flow.scope, flow.activityType])).toEqual([
        ['inbound', 'external', 'media'], ['outbound', 'external', 'media'],
      ]);
      expect(events[0].sourceRegion).toBe('edge-nrt');
      expect(events[1].targetRegion).toBe('edge-nrt');
      expect(JSON.stringify(events)).not.toContain('never-published');
    } finally {
      client.disconnect();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
    }
  });
});

describe('raw WebSocket transport', () => {
  it('preserves send callbacks, synchronous errors and method cleanup without reading messages', async () => {
    const { observeTrafficWebSocket } = await import('../socket');
    const events: TrafficFlow[] = [];
    const original = jest.fn((_data: unknown, callback: (error?: Error) => void) => callback());
    const socket = Object.assign(new EventEmitter(), { readyState: 1, send: original });
    const stop = observeTrafficWebSocket(socket, { record: flow => events.push(flow) }, 'alia', 'us-west-2', {
      activityType: 'ai', getPeer: () => ({ service: 'alia-integrations', region: 'eu-west-1' }),
    });
    const callback = jest.fn();
    socket.send({ privateBody: 'not-recorded' }, callback);
    socket.emit('message', Buffer.from('private-message'));
    expect(original).toHaveBeenCalledWith({ privateBody: 'not-recorded' }, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(events.map(flow => flow.direction)).toEqual(['outbound', 'inbound']);
    expect(events.every(flow => flow.scope === 'internal' && flow.activityType === 'ai')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/private|not-recorded/);
    original.mockImplementationOnce(() => { throw new Error('send failed'); });
    expect(() => socket.send('', callback)).toThrow('send failed');
    expect(events).toHaveLength(2);
    stop(); stop();
    expect(socket.send).toBe(original);
    expect(socket.listenerCount('message')).toBe(0);
  });
});
