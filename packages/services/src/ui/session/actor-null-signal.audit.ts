import assert from 'node:assert/strict';
import { SessionClient } from '/home/nate/Oxy/worktrees/session-sync-stale-bearer/packages/core/src/session/SessionClient';
import { createTokenTransport } from './tokenTransport';

const claims = (actor: string) => `header.${Buffer.from(JSON.stringify({userId: 'org', sessionId: `session-${actor}`, act: {sub: actor}, exp: 4102444800})).toString('base64url')}.signature`;
let bearer = claims('alice');
let revision = 1;
let stateReads = 0;
let refreshCalls = 0;
const state = () => ({deviceId: 'd1', revision, updatedAt: 1720000000000, activeAccountId: 'org', accounts: [
  {accountId: 'org', sessionId: 'session-alice', authuser: 0, operatedByUserId: 'alice'},
  {accountId: 'org', sessionId: 'session-nate', authuser: 1, operatedByUserId: 'nate'},
]});
const directory = () => ({deviceId: 'd1', revision, updatedAt: 1720000000000, activeContextId: `ctx-${revision === 1 ? 'alice' : 'nate'}-org`, principals: ['alice','nate'].map((id, i) => ({id: `p-${id}`, userId: id, authuser: i, user: {id, username: id}, contexts: [{id: `ctx-${id}-org`, accountId:'org', kind:'organization', relationship:'member', account:{id:'org', username:'org'}, onDevice:true, available:true, active:id === (revision === 1 ? 'alice' : 'nate'), lastUsedAt:null}]}))});
const handlers = new Map<string, (...args: unknown[]) => void>();
const socket = {connected: true, on: (name: string, cb: (...args: unknown[]) => void) => { handlers.set(name, cb); }, off: () => {}, connect: () => {}, disconnect: () => {}};
const host = {makeRequest: async (_method: string, path: string) => {
  if (path === '/session/device/directory') return directory();
  if (path === '/session/device/state') { stateReads++; return {state: state(), activeToken: null}; }
  throw new Error(`unexpected path ${path}`);
}, getBaseURL: () => 'http://fixture.invalid', getAccessToken: () => bearer, getDeviceCredential: () => null, onTokensChanged: () => () => {}, setTokens: (value: string) => {bearer = value;}, getCurrentAccountId: () => 'org'};
const oxy = {session: {get userId() {return 'org';}}, http: {refreshAccessToken: async () => {refreshCalls++; return null;}}};
const client = new SessionClient(host as never, {transport: createTokenTransport(oxy as never), socketFactory: () => socket as never});
await client.start();
await client.refreshDirectory();
assert.equal(client.getActiveContext()?.actor.userId, 'alice');
const observations: {actor?: string, bearerActor: string}[] = [];
client.subscribe(() => observations.push({actor: client.getActiveContext()?.actor.userId, bearerActor: JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).act.sub}));
revision = 2;
handlers.get('session_state')!(state());
for (let i = 0; i < 20; i++) await Promise.resolve();
const afterFirst = {actor: client.getActiveContext()?.actor.userId, reads: stateReads, refreshCalls};
handlers.get('session_accounts_changed')!({userId:'org', revision:2, reason:'switch'});
for (let i = 0; i < 20; i++) await Promise.resolve();
const result = {afterFirst, afterBoth: {actor: client.getActiveContext()?.actor.userId, bearerActor: JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).act.sub, reads: stateReads, refreshCalls}, observations};
assert.equal(result.afterBoth.actor, 'nate');
assert.equal(result.afterBoth.bearerActor, 'alice');
assert.equal(result.afterBoth.refreshCalls, 0);
assert.equal(result.afterBoth.reads, 2);
client.stop();
console.log(JSON.stringify(result));
