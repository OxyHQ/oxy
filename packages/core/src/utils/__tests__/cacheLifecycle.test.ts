import { TTLCache, registerCacheForCleanup, unregisterCacheFromCleanup, stopAllCleanupIntervals } from '../cache';

afterEach(() => { stopAllCleanupIntervals(); jest.useRealTimers(); });

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
test('server barrel imports and client construction start no background timers', () => {
  jest.useFakeTimers();
  jest.isolateModules(() => {
    const server = require('../../server');
    expect(typeof server.createEcosystemTraffic).toBe('function');
    expect(jest.getTimerCount()).toBe(0);
    require('../cache').stopAllCleanupIntervals();
  });
});
