import { normalizeInfrastructureRegion, type TrafficFlow, type TrafficType } from './collector.js';
import { metadataFromHeaders, type TelemetryHeaders } from './server.js';

export interface TrafficSocket {
  handshake: { headers: TelemetryHeaders };
  nsp?: { name: string };
  onAny(listener: (event: string) => void): unknown;
  onAnyOutgoing(listener: (event: string) => void): unknown;
  offAny(listener: (event: string) => void): unknown;
  offAnyOutgoing(listener: (event: string) => void): unknown;
  once(event: 'disconnect', listener: () => void): unknown;
  off(event: 'disconnect', listener: () => void): unknown;
}

const CATEGORIES: Record<string, TrafficType> = {
  auth: 'identity', session: 'identity', user: 'identity', profile: 'identity',
  chat: 'ai', agent: 'ai', inference: 'ai', completion: 'ai',
  message: 'communication', notification: 'communication', typing: 'communication',
  media: 'media', audio: 'media', video: 'media', stream: 'media', player: 'media',
  track: 'media', playback: 'media', playlist: 'media', room: 'media',
};

/** Event names are reduced locally to five categories; payloads are never read. */
export function socketTrafficType(event: string): TrafficType {
  return CATEGORIES[event.toLowerCase().split(/[:/._-]/, 1)[0]] ?? 'platform';
}

/**
 * Observes application events only, once per local socket. Socket.IO catch-all
 * hooks exclude acknowledgements, ping/pong and transport frames. Outgoing
 * packets describe sends, not delivery acknowledgements. No connection ID,
 * event name, IP, credential, room name or payload enters a traffic record.
 */
export function observeTrafficSocket(
  socket: TrafficSocket,
  collector: { record(flow: TrafficFlow): void },
  service: string,
  region: string,
  options: { getPeer?: () => { service: string; region?: string } | undefined } = {},
): () => void {
  if (/^\/platform-(?:activity|stats)(?:\/|$)/.test(socket.nsp?.name ?? '')) return () => {};
  let stopped = false;
  const record = (event: string, direction: 'inbound' | 'outbound') => {
    if (stopped) return;
    const peer = options.getPeer?.();
    const peerService = peer && /^[a-z][a-z0-9-]{0,39}$/.test(peer.service) ? peer.service : undefined;
    const edgePop = metadataFromHeaders(socket.handshake.headers).edgePop;
    const peerRegion = peerService ? normalizeInfrastructureRegion(peer?.region) : edgePop ? `edge-${edgePop}` : undefined;
    collector.record({
      region, service, scope: peerService ? 'internal' : 'external', direction,
      activityType: socketTrafficType(event),
      sourceRegion: direction === 'inbound' ? peerRegion : region,
      targetRegion: direction === 'inbound' ? region : peerRegion,
      sourceService: direction === 'inbound' ? peerService : service,
      targetService: direction === 'inbound' ? service : peerService,
    });
  };
  const inbound = (event: string) => record(event, 'inbound');
  const outbound = (event: string) => record(event, 'outbound');
  const stop = () => {
    if (stopped) return;
    stopped = true;
    socket.offAny(inbound);
    socket.offAnyOutgoing(outbound);
    socket.off('disconnect', stop);
  };
  socket.onAny(inbound);
  socket.onAnyOutgoing(outbound);
  socket.once('disconnect', stop);
  return stop;
}

export interface TrafficWebSocket {
  readonly readyState: number;
  // ws accepts data/options overloads; they are forwarded without inspecting
  // or changing them. Keep this boundary permissive for Node ws versions.
  send(...args: any[]): unknown;
  on(event: 'message', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'message' | 'close', listener: () => void): unknown;
}

/** Raw ws application messages. Sends are attempts, never delivery receipts. */
export function observeTrafficWebSocket(
  socket: TrafficWebSocket,
  collector: { record(flow: TrafficFlow): void },
  service: string,
  region: string,
  options: {
    headers?: TelemetryHeaders;
    activityType?: TrafficType;
    getPeer?: () => { service: string; region?: string } | undefined;
  } = {},
): () => void {
  let stopped = false;
  const record = (direction: 'inbound' | 'outbound') => {
    if (stopped) return;
    const peer = options.getPeer?.();
    const peerService = peer && /^[a-z][a-z0-9-]{0,39}$/.test(peer.service) ? peer.service : undefined;
    const edgePop = metadataFromHeaders(options.headers ?? {}).edgePop;
    const peerRegion = peerService ? normalizeInfrastructureRegion(peer?.region) : edgePop ? `edge-${edgePop}` : undefined;
    collector.record({
      service, region, scope: peerService ? 'internal' : 'external', direction,
      activityType: options.activityType ?? 'communication',
      sourceRegion: direction === 'inbound' ? peerRegion : region,
      targetRegion: direction === 'inbound' ? region : peerRegion,
      sourceService: direction === 'inbound' ? peerService : service,
      targetService: direction === 'inbound' ? service : peerService,
    });
  };
  const inbound = () => record('inbound');
  const originalSend = socket.send;
  const send: TrafficWebSocket['send'] = function (this: TrafficWebSocket, ...args) {
    const open = this.readyState === 1;
    // Preserve overload arguments, callback identity, return value and throws.
    const result = Reflect.apply(originalSend, this, args);
    if (open) record('outbound');
    return result;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    socket.off('message', inbound);
    socket.off('close', stop);
    if (socket.send === send) socket.send = originalSend;
  };
  socket.send = send;
  socket.on('message', inbound);
  socket.once('close', stop);
  return stop;
}
