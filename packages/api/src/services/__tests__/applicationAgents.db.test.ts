/**
 * ADR 0044 — an Oxy application may confine its own agent to its own surfaces.
 *
 * `application_agents` is written ONLY by Oxy staff, through the application
 * administration lane that governs an application's scopes and capabilities
 * (`/applications/:appId/agents/:agentAccountId`, staff AND `app:update`). The
 * agent must be an active bot under an account the application's owner
 * operates, and is one application's at most. Alia reads the answer on the
 * coordinator lane (`GET /capabilities/agent-availability/:agentAccountId`).
 *
 * Everything is real — the rows, the membership resolver, both routers,
 * Postgres — except the bearer: `authMiddleware` takes the caller and its staff
 * flag from test headers, because these tests are about who may write, not how
 * they signed in. `requireStaff` is the real guard.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    authMiddleware: (
      req: { headers: Record<string, string | undefined>; user?: unknown },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) => {
      const userId = req.headers['x-test-user'];
      if (!userId) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      req.user = { _id: userId, id: userId, isStaff: req.headers['x-test-staff'] === 'true' };
      next();
    },
  };
});

jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: async () => {},
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { accountMembers } from '../../db/schema/accountMembers';
import { applicationAgents } from '../../db/schema/applicationAgents';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { userAncestors } from '../../db/schema/userAncestors';
import { users } from '../../db/schema/users';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { errorHandler } from '../../middleware/errorHandler';
import applicationsRouter from '../../routes/applications';
import capabilitiesRouter from '../../routes/capabilities';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

const server = express();
server.use(express.json());
server.use('/applications', applicationsRouter);
server.use('/capabilities', capabilitiesRouter);
server.use(errorHandler);

async function account(
  kind: 'personal' | 'organization' | 'project' | 'bot',
  parentAccountId?: string,
): Promise<string> {
  const [row] = await insertAccountFixtures(
    { kind, username: `agents-${kind}-${randomUUID().slice(0, 12)}`, parentAccountId },
    { id: users.id },
  );
  return row.id;
}

/** The materialised path the account service keeps for a moved or created account. */
async function ancestors(accountId: string, path: string[]): Promise<void> {
  await getDb()
    .insert(userAncestors)
    .values(path.map((ancestorId, depth) => ({ userId: accountId, depth, ancestorId })));
}

async function application(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `Clarity ${randomUUID()}`, ownerAccountId, status: 'active' })
    .returning({ id: applications.id });
  return row.id;
}

/**
 * Clarity's organization (owned by a staff member and an ordinary admin), its
 * project, Clarity's assistant under the project, a bot directly under the
 * organization, a bot under a stranger, a person, and an archived bot.
 */
async function world() {
  const staff = await account('personal');
  const admin = await account('personal');
  const outsiderStaff = await account('personal');
  const stranger = await account('personal');
  const org = await account('organization');
  await getDb()
    .insert(accountMembers)
    .values([
      { accountId: org, memberUserId: staff, role: 'owner', status: 'active' },
      { accountId: org, memberUserId: admin, role: 'owner', status: 'active' },
    ]);
  const project = await account('project', org);
  await ancestors(project, [org]);
  const assistant = await account('bot', project);
  await ancestors(assistant, [org, project]);
  const orgBot = await account('bot', org);
  await ancestors(orgBot, [org]);
  const strangerBot = await account('bot', stranger);
  await ancestors(strangerBot, [stranger]);
  const archivedBot = await account('bot', project);
  await ancestors(archivedBot, [org, project]);
  await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, archivedBot));
  const clarity = await application(org);
  const otherApp = await application(org);
  return {
    staff,
    admin,
    outsiderStaff,
    stranger,
    org,
    project,
    assistant,
    orgBot,
    strangerBot,
    archivedBot,
    clarity,
    otherApp,
  };
}

const asCaller = (userId: string, staff: boolean) => ({
  put: (path: string, body: unknown) =>
    request(server)
      .put(path)
      .set('x-test-user', userId)
      .set('x-test-staff', String(staff))
      .send(body as object),
  delete: (path: string) =>
    request(server).delete(path).set('x-test-user', userId).set('x-test-staff', String(staff)),
  get: (path: string) =>
    request(server).get(path).set('x-test-user', userId).set('x-test-staff', String(staff)),
});

async function rowOf(agentAccountId: string) {
  const [row] = await getDb()
    .select()
    .from(applicationAgents)
    .where(eq(applicationAgents.agentAccountId, agentAccountId));
  return row;
}

/** Alia's coordinator: `capabilities:read` and, unless told otherwise, `agency:coordinate`. */
async function coordinator(ownerAccountId: string, capabilities = ['agency:coordinate']) {
  const scopes = ['capabilities:read'];
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `Coordinator ${randomUUID()}`,
      ownerAccountId,
      status: 'active',
      isInternal: true,
      scopes,
      capabilities,
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'Coordinator credential',
      publicKey: `oxy_dk_${randomUUID()}`,
      secretHash: 'test-only-secret-hash',
      type: 'service',
      environment: 'production',
      scopes,
      status: 'active',
    })
    .returning({ id: applicationCredentials.id });
  const token = signServiceTokenEd25519({
    type: 'service',
    appId: app.id,
    appName: 'Alia fixture',
    credentialId: credential.id,
    ownerAccountId,
    environment: 'production',
    tier: 'internal',
    scopes,
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  return (agentAccountId: string) =>
    request(server)
      .get(`/capabilities/agent-availability/${encodeURIComponent(agentAccountId)}`)
      .set('authorization', `Bearer ${token}`);
}

describe('only the staff lane writes an application agent', () => {
  it('a staff member who may update the application writes it, and may change it', async () => {
    const w = await world();
    const staff = asCaller(w.staff, true);
    const written = await staff.put(`/applications/${w.clarity}/agents/${w.assistant}`, {
      availability: 'own_application',
    });
    expect(written.status).toBe(200);
    expect(written.body.agent).toMatchObject({
      applicationId: w.clarity,
      agentAccountId: w.assistant,
      availability: 'own_application',
      createdByUserId: w.staff,
    });

    const changed = await staff.put(`/applications/${w.clarity}/agents/${w.assistant}`, {
      availability: 'anywhere',
    });
    expect(changed.status).toBe(200);
    expect((await rowOf(w.assistant))?.availability).toBe('anywhere');

    const listed = await asCaller(w.admin, false).get(`/applications/${w.clarity}/agents`);
    expect(listed.status).toBe(200);
    expect(listed.body.agents).toEqual([
      expect.objectContaining({ agentAccountId: w.assistant, availability: 'anywhere' }),
    ]);
  });

  it('an application owner who is not staff is refused, and nothing is written', async () => {
    const w = await world();
    const refused = await asCaller(w.admin, false).put(
      `/applications/${w.clarity}/agents/${w.assistant}`,
      { availability: 'own_application' },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe('This operation requires Oxy platform staff privileges');
    expect(await rowOf(w.assistant)).toBeUndefined();

    await asCaller(w.staff, true).put(`/applications/${w.clarity}/agents/${w.assistant}`, {
      availability: 'own_application',
    });
    const removal = await asCaller(w.admin, false).delete(
      `/applications/${w.clarity}/agents/${w.assistant}`,
    );
    expect(removal.status).toBe(403);
    expect(await rowOf(w.assistant)).toBeDefined();
  });

  it('staff who may not update the application are refused', async () => {
    const w = await world();
    const refused = await asCaller(w.outsiderStaff, true).put(
      `/applications/${w.clarity}/agents/${w.assistant}`,
      { availability: 'own_application' },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe('You do not have access to this application');
    expect(await rowOf(w.assistant)).toBeUndefined();
  });

  it('an availability outside the two is refused', async () => {
    const w = await world();
    const refused = await asCaller(w.staff, true).put(
      `/applications/${w.clarity}/agents/${w.assistant}`,
      { availability: 'everywhere' },
    );
    expect(refused.status).toBe(400);
    expect(await rowOf(w.assistant)).toBeUndefined();
  });

  it('the agent must be an active bot', async () => {
    const w = await world();
    const staff = asCaller(w.staff, true);
    for (const notABot of [w.stranger, w.project, w.archivedBot, randomUUID()]) {
      const refused = await staff.put(`/applications/${w.clarity}/agents/${notABot}`, {
        availability: 'own_application',
      });
      expect(refused.status).toBe(400);
      expect(refused.body.details).toEqual({ reason: 'agent_must_be_active_bot_account' });
    }
  });

  it('the bot must be under an account the application owner operates', async () => {
    const w = await world();
    const staff = asCaller(w.staff, true);
    const refused = await staff.put(`/applications/${w.clarity}/agents/${w.strangerBot}`, {
      availability: 'own_application',
    });
    expect(refused.status).toBe(400);
    expect(refused.body.details).toEqual({ reason: 'agent_not_under_application_owner' });
    expect(await rowOf(w.strangerBot)).toBeUndefined();

    // The owner itself, and a project in its subtree, are both accounts it operates.
    for (const bot of [w.orgBot, w.assistant]) {
      const written = await staff.put(`/applications/${w.clarity}/agents/${bot}`, {
        availability: 'own_application',
      });
      expect(written.status).toBe(200);
    }
  });

  it("an agent is one application's", async () => {
    const w = await world();
    const staff = asCaller(w.staff, true);
    await staff.put(`/applications/${w.clarity}/agents/${w.assistant}`, {
      availability: 'own_application',
    });
    const refused = await staff.put(`/applications/${w.otherApp}/agents/${w.assistant}`, {
      availability: 'anywhere',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.details).toEqual({ reason: 'agent_belongs_to_another_application' });
    expect(await rowOf(w.assistant)).toMatchObject({
      applicationId: w.clarity,
      availability: 'own_application',
    });
  });

  it('removing the row makes the agent available anywhere again', async () => {
    const w = await world();
    const staff = asCaller(w.staff, true);
    await staff.put(`/applications/${w.clarity}/agents/${w.assistant}`, {
      availability: 'own_application',
    });
    expect((await staff.delete(`/applications/${w.otherApp}/agents/${w.assistant}`)).status).toBe(
      404,
    );
    expect((await staff.delete(`/applications/${w.clarity}/agents/${w.assistant}`)).status).toBe(
      204,
    );
    expect(await rowOf(w.assistant)).toBeUndefined();
  });
});

describe('GET /capabilities/agent-availability/:agentAccountId', () => {
  it('a confined agent lists its application; an unconfined or unknown one is anywhere', async () => {
    const w = await world();
    const staff = asCaller(w.staff, true);
    await staff.put(`/applications/${w.clarity}/agents/${w.assistant}`, {
      availability: 'own_application',
    });
    await staff.put(`/applications/${w.clarity}/agents/${w.orgBot}`, { availability: 'anywhere' });
    const ask = await coordinator(w.org);

    const confined = await ask(w.assistant);
    expect(confined.status).toBe(200);
    expect(confined.body).toEqual({ anywhere: false, applicationIds: [w.clarity] });
    expect((await ask(w.orgBot)).body).toEqual({ anywhere: true });
    expect((await ask(w.strangerBot)).body).toEqual({ anywhere: true });
    expect((await ask(randomUUID())).body).toEqual({ anywhere: true });
  });

  it('answers only the coordinator lane', async () => {
    const w = await world();
    const withoutCoordination = await coordinator(w.org, []);
    const refused = await withoutCoordination(w.assistant);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      error: 'missing_application_capability',
      requiredCapability: 'agency:coordinate',
    });
    expect(
      (await request(server).get(`/capabilities/agent-availability/${w.assistant}`)).status,
    ).toBe(401);
  });
});
