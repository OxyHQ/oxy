import { infrastructureLocation } from '@oxy.so/telemetry/collector';
import { randomUUID } from 'node:crypto';
import type { Namespace } from 'socket.io';
import { getRedisClient } from '../config/redis';

export interface InfrastructureMember {
  instanceId: string;
  service: string;
  region: string;
  label: string;
  coordinates: [number, number];
  status: 'online' | 'degraded' | 'offline' | 'unknown';
}
export interface InfrastructureNode {
  region: string;
  label: string;
  coordinates: [number, number];
  services: string[];
  instances: number;
  status: InfrastructureMember['status'];
}
const MEMBER_TTL_MS = 45_000;
const REGISTRY_KEY = 'platform-infrastructure:members';
const localMembers = new Map<string, { member: InfrastructureMember; seenAt: number }>();
const instanceId = randomUUID();
let namespace: Namespace | null = null;
let ownHeartbeat: Promise<void> = Promise.resolve();
let stopping = false;
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot: { nodes: InfrastructureNode[]; emittedAt: string } = { nodes: [], emittedAt: new Date(0).toISOString() };
let refreshing: Promise<typeof snapshot> | null = null;

export function infrastructureSnapshot(members: Array<{ member: InfrastructureMember; seenAt: number }>, now: number): InfrastructureNode[] {
  const regions = new Map<string, InfrastructureNode>();
  for (const { member, seenAt } of members) {
    if (now - seenAt >= MEMBER_TTL_MS) continue;
    let node = regions.get(member.region);
    if (!node) {
      node = { region: member.region, label: member.label, coordinates: member.coordinates, services: [], instances: 0, status: member.status };
      regions.set(member.region, node);
    }
    node.instances++;
    if (!node.services.includes(member.service)) node.services.push(member.service);
    if (node.status !== member.status) node.status = 'degraded';
  }
  return [...regions.values()].map(node => ({ ...node, services: node.services.sort() })).sort((a, b) => a.region.localeCompare(b.region));
}

export async function observeInfrastructure(caller: string, member: InfrastructureMember, removed = false): Promise<void> {
  const key = `${caller}:${member.instanceId}`;
  const redis = getRedisClient();
  if (removed) {
    localMembers.delete(key);
    if (redis) await redis.hdel(REGISTRY_KEY, key);
  } else {
    const value = { member, seenAt: Date.now() };
    localMembers.set(key, value);
    if (redis) await redis.hset(REGISTRY_KEY, key, JSON.stringify(value));
  }
  // A write that overlaps a read must trigger a fresh read after it.
  if (refreshing) await refreshing;
  await refreshInfrastructure();
}

export function refreshInfrastructure(): Promise<typeof snapshot> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const now = Date.now();
    const redis = getRedisClient();
    if (redis) {
      const entries = await redis.hgetall(REGISTRY_KEY);
      localMembers.clear();
      for (const [key, encoded] of Object.entries(entries)) {
        const value = JSON.parse(encoded) as { member: InfrastructureMember; seenAt: number };
        if (now - value.seenAt < MEMBER_TTL_MS) localMembers.set(key, value);
        else {
          // Delete only the expired value we read; a concurrent heartbeat wins.
          await redis.eval('if redis.call("HGET", KEYS[1], ARGV[1]) == ARGV[2] then return redis.call("HDEL", KEYS[1], ARGV[1]) end return 0', 1, REGISTRY_KEY, key, encoded);
        }
      }
    } else {
      for (const [key, value] of localMembers) if (now - value.seenAt >= MEMBER_TTL_MS) localMembers.delete(key);
    }
    const nodes = infrastructureSnapshot([...localMembers.values()], now);
    if (JSON.stringify(nodes) !== JSON.stringify(snapshot.nodes) || snapshot.emittedAt === new Date(0).toISOString()) {
      snapshot = { nodes, emittedAt: new Date(now).toISOString() };
      namespace?.emit('platform_infrastructure', snapshot);
    }
    return snapshot;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function initializePlatformInfrastructure(nextNamespace: Namespace, ready: () => boolean): void {
  namespace = nextNamespace;
  stopping = false;
  namespace.on('connection', socket => {
    void refreshInfrastructure().then(current => socket.emit('platform_infrastructure', current)).catch(() => {});
  });
  const region = process.env.AWS_REGION || 'unknown';
  const location = infrastructureLocation(region);
  const heartbeat = () => location
    ? observeInfrastructure('oxy-api', { instanceId, service: 'oxy-api', region, ...location, status: ready() ? 'online' : 'unknown' }).catch(() => {})
    : refreshInfrastructure().then(() => {}).catch(() => {});
  const tick = () => { if (!stopping) ownHeartbeat = ownHeartbeat.then(heartbeat); };
  tick();
  timer = setInterval(tick, 10_000);
  timer.unref?.();
}

export async function stopPlatformInfrastructure(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  await ownHeartbeat;
  const redis = getRedisClient();
  localMembers.delete(`oxy-api:${instanceId}`);
  if (redis) await redis.hdel(REGISTRY_KEY, `oxy-api:${instanceId}`);
  if (refreshing) await refreshing;
  await refreshInfrastructure();
  namespace = null;
}
