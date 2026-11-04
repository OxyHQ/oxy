/** Database → projection → serializer → public HTTP regression. Selecting the
 * JSON column alone did not preserve it: toPublicUserView silently dropped it. */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { AvatarCharacter } from '@oxy.so/contracts';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveViewerId: (): string | undefined => undefined,
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { userService } from '../../services/user.service';
import { federationService } from '../../services/federation.service';
import profilesRouter from '../profiles';

const character: AvatarCharacter = {
  shape: 'rounded_head_two_ears',
  eyes: 'oval',
  color: 'teal',
  eyewear: 'none',
  accessory: 'none',
};
let server: Server;
let origin: string;
beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/profiles', profilesRouter);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  jest.spyOn(federationService, 'resolveAndUpsert').mockResolvedValue(null);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
});

it.each([
  { label: 'stored bot', kind: 'bot' as const, character, expected: character },
  {
    label: 'old bot without a character',
    kind: 'bot' as const,
    character: null,
    expected: undefined,
  },
  {
    label: 'malformed bot',
    kind: 'bot' as const,
    character: { ...character, unknownPart: true } as AvatarCharacter,
    expected: undefined,
  },
  {
    label: 'human with an image',
    kind: 'personal' as const,
    character: null,
    expected: undefined,
  },
  {
    label: 'remote bot without a character',
    kind: 'bot' as const,
    type: 'federated' as const,
    character: null,
    expected: undefined,
  },
])('preserves only valid bot characters across every read: $label', async (fixture) => {
  const token = randomUUID().replace(/-/g, '').slice(0, 14);
  const username = `character${token}`;
  const [row] = await getDb()
    .insert(users)
    .values({
      username,
      kind: fixture.kind,
      character: fixture.character,
      type: fixture.type ?? 'local',
      avatar: 'file-public-photo',
      nameFirst: 'Fixture',
      accountStatus: 'active',
      reputationTier: 'trusted',
      email: `secret${token}@example.test`,
      refreshToken: `secret${token}`,
    })
    .returning({ id: users.id });
  const publicView = await userService.getPublicUserById(row.id);
  const selfView = await userService.getCurrentUser(row.id);
  expect(publicView).not.toBeNull();
  expect(selfView).not.toBeNull();
  if (!publicView || !selfView) throw new Error('Seeded identity must resolve');
  // PostgreSQL forbids a character on non-bots; the serializer must also
  // protect that boundary when another caller supplies an unexpected object.
  expect(
    userService.formatUserResponse({ ...publicView, kind: 'personal', character }),
  ).not.toHaveProperty('character');
  const batch = await userService.getUsersByIds([row.id]);
  expect(batch).toHaveLength(1);
  const results = [
    userService.formatUserResponse(publicView),
    userService.formatUserResponse(selfView),
    batch[0],
  ];
  for (const path of [
    `/profiles/username/${username}`,
    `/profiles/resolve?handle=${username}`,
    `/profiles/search?query=${username}&limit=10`,
  ]) {
    const response = await fetch(origin + path);
    expect(response.status).toBe(200);
    const body = await response.json();
    const value = Array.isArray(body.data)
      ? body.data.find((u: { id: string }) => u.id === row.id)
      : body.data;
    expect(value?.id).toBe(row.id);
    results.push(value);
  }
  for (const result of results) {
    expect(result.character).toEqual(fixture.expected);
    if (!fixture.expected) expect(result).not.toHaveProperty('character');
    expect(result.avatar).toBe('file-public-photo');
    expect(result.kind).toBe(fixture.kind);
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result)).not.toContain(`secret${token}`);
  }
});
