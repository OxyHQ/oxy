/** Real session service + device routes/PG and the built SDK; no auth/mint mocks.
 * Native storage is an owned key/value fixture. A stopped sibling is recreated
 * from those same bytes after the other authenticated holder signs out. */
import express from 'express';
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { OxyServices } from '@oxy.so/core';
import { createNativeAuthStateStore, runSessionColdBoot, type NativeKeyValueStorage } from '@oxy.so/core/session';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../services/securityActivityService', () => ({__esModule: true, default: {logDeviceAdded: jest.fn()}}));
jest.mock('../../utils/socket', () => ({broadcastDeviceState: jest.fn(), broadcastSessionAccountsChanged: jest.fn()}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { deviceCredentials } from '../../db/schema/deviceCredentials';
import { deviceSessions } from '../../db/schema/deviceSessions';
import sessionService from '../../services/session.service';
import deviceService from '../../services/deviceSession.service';
import sessionDeviceRouter from '../sessionDevice';
import { errorHandler } from '../../middleware/errorHandler';

let server: http.Server;
let baseURL: string;
const requests: string[] = [];
beforeAll(async () => {
  await connectPostgres();
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {requests.push(`${req.method} ${req.path}`); next();});
  app.use('/session/device', sessionDeviceRouter); app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await closePostgres();});
async function person() {const [row] = await getDb().insert(users).values({username: `holder-${randomUUID().slice(0, 12)}`}).returning(); return row.id;}
async function signIn(userId: string, deviceId: string) {
  const req = {headers: {'user-agent': 'Oxy-owned-native-fixture', 'accept-language': 'en-US'}} as unknown as Parameters<typeof sessionService.createSession>[1];
  const session = await sessionService.createSession(userId, req, {deviceId});
  await deviceService.addAccount(deviceId, {accountId: userId, sessionId: session.sessionId});
  return session;
}
function storage() {
  const data = new Map<string, string>();
  const kv: NativeKeyValueStorage = {getItem: async k => data.get(k) ?? null, setItem: async (k, v) => {data.set(k, v);}, removeItem: async k => {data.delete(k);}};
  return kv;
}
async function holderCount(deviceId: string) {
  const rows = await getDb().select({id: deviceCredentials.id}).from(deviceCredentials).innerJoin(deviceSessions, eq(deviceCredentials.deviceSessionId, deviceSessions.id)).where(eq(deviceSessions.deviceId, deviceId));
  return rows.length;
}

it.each(['full', 'last-account'] as const)('recreated stopped holder remains signed out after %s logout without a key challenge', async kind => {
  const userId = await person(); const deviceId = `native-${randomUUID()}`;
  const session = await signIn(userId, deviceId);
  const secretA = await deviceService.issueDeviceSecret(deviceId); const secretB = await deviceService.issueDeviceSecret(deviceId);
  expect(secretA).toBeTruthy(); expect(secretB).toBeTruthy(); expect(await holderCount(deviceId)).toBe(2);
  const kv = storage(); await createNativeAuthStateStore(kv).save({sessionId: session.sessionId, userId, deviceId, deviceSecret: secretB as string});
  const a = new OxyServices({baseURL}); a.session.setAccessToken(session.accessToken);
  // API auth resolves the real signed-in session; no test-only caller identity.
  const response = await fetch(`${baseURL}/session/device/signout`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}`}, body: JSON.stringify(kind === 'full' ? {all: true} : {accountId: userId})});
  expect(response.status).toBe(200); expect(await holderCount(deviceId)).toBe(0);
  const raw = await fetch(`${baseURL}/session/device/token`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({deviceId, deviceSecret: secretB})});
  expect(raw.status).toBe(401); expect(await raw.json()).toMatchObject({error: 'invalid_device_secret'});
  const b = new OxyServices({baseURL}); const commons = jest.spyOn(b.auth, 'signInWithCommonsIdentity'); const restored = createNativeAuthStateStore(kv); requests.length = 0;
  const outcome = await runSessionColdBoot({oxy: b, store: restored, platform: {isWeb: false, isNative: true}});
  expect(outcome.kind).toBe('unauthenticated'); expect(commons).not.toHaveBeenCalled(); expect(b.session.accessToken).toBeNull();
  expect(requests).toContain('POST /session/device/token');
  expect(requests.some(path => path.includes('/auth/challenge') || path.includes('/auth/verify'))).toBe(false);
  expect(await createNativeAuthStateStore(kv).isAutomaticIdentitySignInSuppressed?.()).toBe(true);
  expect(await restored.load()).toMatchObject({deviceId, deviceSecret: secretB, sessionId: session.sessionId, userId});
});

it('partial logout keeps both legitimate holders minting the remaining person and does not set logout intent', async () => {
  const first = await person(); const remaining = await person(); const deviceId = `partial-${randomUUID()}`;
  const session = await signIn(first, deviceId); await signIn(remaining, deviceId);
  const secretA = await deviceService.issueDeviceSecret(deviceId); const secretB = await deviceService.issueDeviceSecret(deviceId);
  const response = await fetch(`${baseURL}/session/device/signout`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}`}, body: JSON.stringify({accountId: first})});
  expect(response.status).toBe(200); expect(await holderCount(deviceId)).toBe(2);
  for (const secret of [secretA, secretB]) {
    const kv = storage(); const store = createNativeAuthStateStore(kv); await store.save({sessionId: session.sessionId, userId: first, deviceId, deviceSecret: secret as string});
    const oxy = new OxyServices({baseURL});
    expect(await runSessionColdBoot({oxy, store, platform: {isWeb: false, isNative: true}})).toMatchObject({kind: 'session', session: {userId: remaining}});
    expect(await store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
  }
});

it('a new explicit sign-in publishes a new holder for the same ended device and warm sibling proves it before adoption', async () => {
  const userId = await person(); const deviceId = `relogin-${randomUUID()}`;
  const initial = await signIn(userId, deviceId);
  const secretA = await deviceService.issueDeviceSecret(deviceId); const secretB = await deviceService.issueDeviceSecret(deviceId);
  expect(await holderCount(deviceId)).toBe(2);
  const kv = storage(); const store = createNativeAuthStateStore(kv);
  const prior = {sessionId: initial.sessionId, userId, deviceId, deviceSecret: secretB as string}; await store.save(prior);
  const response = await fetch(`${baseURL}/session/device/signout`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${initial.accessToken}`}, body: JSON.stringify({all: true})});
  expect(response.status).toBe(200); expect(await holderCount(deviceId)).toBe(0);
  const explicit = await signIn(userId, deviceId); const newSecret = await deviceService.issueDeviceSecret(deviceId);
  expect(newSecret).not.toBe(secretA); expect(newSecret).not.toBe(secretB);
  const {publishProvenDeviceCredential, refreshPersistedSession} = await import('@oxy.so/core/session');
  let current = {deviceId, deviceSecret: secretA as string};
  const shared = {read: async () => ({state: 'present' as const, credential: current}), publish: async (value: typeof current) => {current = value; return true;}, clear: jest.fn(async () => undefined)};
  // Existing same-device publication rule updates an ended slot after explicit
  // authentication; a different healthy device is never overwritten here.
  const a = new OxyServices({baseURL});
  const proven = await a.devices.mintToken(deviceId, newSecret as string);
  expect(proven.state.activeAccountId).toBe(userId);
  expect(await publishProvenDeviceCredential({shared, credential: {deviceId, deviceSecret: newSecret as string}})).toEqual({status: 'published'});
  const b = new OxyServices({baseURL}); const commons = jest.spyOn(b.auth, 'signInWithCommonsIdentity');
  expect(await refreshPersistedSession({oxy: b, store, sharedDeviceCredential: shared, allowCommonsIdentityFallback: false})).toBeTruthy();
  expect(await store.load()).toMatchObject({deviceId, deviceSecret: newSecret, sessionId: explicit.sessionId, userId});
  expect(commons).not.toHaveBeenCalled(); expect(shared.clear).not.toHaveBeenCalled();
  // Shared adoption does not turn generic saves into an explicit sign-in.
  expect(await store.isAutomaticIdentitySignInSuppressed?.()).toBe(true);
});
