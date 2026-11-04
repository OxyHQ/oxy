import {
  TTLCache,
  registerCacheForCleanup,
  unregisterCacheFromCleanup,
  stopAllCleanupIntervals,
  sweptCacheCount,
} from '../cache';
import { HttpService } from '../../HttpService';

afterEach(() => {
  stopAllCleanupIntervals();
  jest.useRealTimers();
});

test('empty registration is inert and first data starts one shared cleanup timer', () => {
  jest.useFakeTimers();
  const a = new TTLCache<string>(10);
  const b = new TTLCache<string>(10);
  registerCacheForCleanup(a);
  registerCacheForCleanup(b);
  expect(jest.getTimerCount()).toBe(0);
  a.set('a', 'value');
  b.set('b', 'value');
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(11);
  expect(a.get('a')).toBeNull();
  expect(b.has('b')).toBe(false);
  jest.advanceTimersByTime(60_000);
  expect(jest.getTimerCount()).toBe(0);
});
test('periodic cleanup expires unread entries and clear restarts lazily without losing registration', () => {
  jest.useFakeTimers();
  const a = new TTLCache<string>(10);
  registerCacheForCleanup(a);
  a.set('expired', 'value');
  jest.advanceTimersByTime(60_000);
  expect(a.size()).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  a.set('again', 'value');
  expect(jest.getTimerCount()).toBe(1);
  a.clear();
  expect(jest.getTimerCount()).toBe(0);
  a.set('after-clear', 'value');
  expect(jest.getTimerCount()).toBe(1);
});
test('unregister and stop preserve entries but prevent writes restarting automatic cleanup', () => {
  jest.useFakeTimers();
  const a = new TTLCache<string>(100_000);
  const b = new TTLCache<string>(100_000);
  a.set('a', 'value');
  registerCacheForCleanup(a);
  registerCacheForCleanup(b);
  b.set('b', 'value');
  unregisterCacheFromCleanup(a);
  expect(jest.getTimerCount()).toBe(1);
  b.delete('b');
  expect(jest.getTimerCount()).toBe(0);
  a.set('unregistered', 'value');
  expect(jest.getTimerCount()).toBe(0);
  registerCacheForCleanup(a);
  expect(jest.getTimerCount()).toBe(1);
  stopAllCleanupIntervals();
  a.set('stopped', 'value');
  expect(jest.getTimerCount()).toBe(0);
  expect(a.get('a')).toBe('value');
});
test('the sweep holds a registered cache only while it has entries to expire', () => {
  jest.useFakeTimers();
  const cache = new TTLCache<string>(10);
  registerCacheForCleanup(cache);
  expect(sweptCacheCount()).toBe(0);
  cache.set('a', 'value');
  expect(sweptCacheCount()).toBe(1);
  jest.advanceTimersByTime(60_000);
  // Expired by the sweep: nothing global references the cache any more.
  expect(cache.size()).toBe(0);
  expect(sweptCacheCount()).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

test('a client nobody disposed is released by the sweep once its entries expire', () => {
  jest.useFakeTimers();
  // One per request, never disposed: the leak this registry used to have.
  const clients = Array.from(
    { length: 50 },
    () => new HttpService({ baseURL: 'https://api.oxy.so', cacheTTL: 10 }),
  );
  expect(sweptCacheCount()).toBe(0);
  for (const [index, client] of clients.entries()) {
    (client as unknown as { cache: TTLCache<unknown> }).cache.set(`GET:/r/${index}`, { ok: true });
  }
  expect(sweptCacheCount()).toBe(50);
  jest.advanceTimersByTime(60_000);
  expect(sweptCacheCount()).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

test('server barrel imports and client construction start no background timers', () => {
  jest.useFakeTimers();
  jest.isolateModules(() => {
    const server = require('../../server');
    expect(typeof server.createEcosystemTraffic).toBe('function');
    expect(jest.getTimerCount()).toBe(0);
    require('../cache').stopAllCleanupIntervals();
  });
});

test.each([0, 10])('TTL %i expires at the exact boundary in every read path', (ttl) => {
  jest.useFakeTimers();
  const cache = new TTLCache<string>(ttl);
  for (const key of ['get', 'has', 'keys', 'cleanup']) cache.set(key, 'value');
  jest.advanceTimersByTime(ttl);
  expect(cache.get('get')).toBeNull();
  expect(cache.has('has')).toBe(false);
  expect(cache.cleanup()).toBe(2);
  expect(cache.keys()).toEqual([]);
  cache.set('keys', 'value', 0);
  expect(cache.keys()).toEqual([]);
});
