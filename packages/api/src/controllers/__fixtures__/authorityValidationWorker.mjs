// An independent process with its own real sessionCache and database pool.
// Only the API listener/socket module is stubbed: importing the controller
// must not boot a production server during a disposable Postgres fixture.
import { mock } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
import { createInterface } from 'node:readline';
mock.module(resolve(fixtureDirectory, '../../server.ts'), () => ({ emitSessionUpdate() {} }));
(async () => {
  const { connectPostgres, getDb, closePostgres } = await import('../../config/postgres.ts');
  const { sessions } = await import('../../db/schema/sessions.ts');
  const { accountMembers } = await import('../../db/schema/accountMembers.ts');
  const { eq, and } = await import('drizzle-orm');
  const { default: service } = await import('../../services/session.service.ts');
  const { SessionController } = await import('../session.controller.ts');
  await connectPostgres();
  process.stdout.write('RESULT:' + JSON.stringify({ ready: true }) + '\n');
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    try {
      const message = JSON.parse(line);
      if (message.action === 'close') { await closePostgres(); process.exit(0); }
      let result;
      if (message.action === 'warm') {
        result = Boolean(await service.validateSessionById(message.sessionId, true));
      } else if (message.action === 'revoke') {
        await getDb().update(sessions).set({ isActive: false }).where(eq(sessions.sessionId, message.sessionId));
        result = true;
      } else if (message.action === 'remove-member') {
        await getDb().delete(accountMembers).where(and(eq(accountMembers.accountId, message.accountId),
          eq(accountMembers.memberUserId, message.operatorId)));
        result = true;
      } else {
        let status = 200;
        const response = { status(code) { status = code; return this; },
          json(body) { result = { status, valid: body.valid === true }; return this; } };
        const request = { params: { sessionId: message.sessionId }, header() { return undefined; } };
        await SessionController[message.action === 'validate-header' ? 'validateSessionFromHeader' : 'validateSession'](request, response);
      }
      process.stdout.write('RESULT:' + JSON.stringify({ id: message.id, result }) + '\n');
    } catch (error) {
      process.stdout.write('RESULT:' + JSON.stringify({ error: String(error) }) + '\n');
    }
  }
})().catch(error => { process.stderr.write(String(error)); process.exit(1); });
