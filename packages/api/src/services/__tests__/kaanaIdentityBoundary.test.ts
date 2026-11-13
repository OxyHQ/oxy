/** Identity lookups must stay usable independently of inference admission. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = (relative: string) =>
  readFileSync(path.resolve(__dirname, '../..', relative), 'utf8');

it.each([
  'routes/internalKaanaIdentity.ts',
  'services/kaanaIdentity.service.ts',
  'services/inferenceCallerIdentity.service.ts',
  'middleware/kaanaControlWorkload.ts',
])('%s does not depend on financial or inference routing authority', (file) => {
  const imports = [...source(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  expect(imports).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /(?:inferenceEdge|inferenceLedger|inferenceEconomicPolicy|inferenceRoutingPolicy|inferenceInternalPilot|kaanaGrant\.service|productSessionPrincipal)/,
      ),
    ]),
  );
});

it('mounts the bounded raw identity parser before JSON so signatures bind the original bytes', () => {
  const server = source('server.ts');
  const parser = server.indexOf("'/internal/kaana/v1/identities'");
  expect(parser).toBeGreaterThan(0);
  expect(parser).toBeLessThan(server.indexOf('const jsonParser = express.json('));
  expect(server.slice(parser, parser + 160)).toContain('limit: MAX_IDENTITY_REQUEST_BYTES');
  const identityRoute = server.indexOf(
    "platform.use('/internal/kaana/v1', internalKaanaIdentityRoutes)",
  );
  const economicRoute = server.indexOf("platform.use('/internal/kaana/v1', internalKaanaRoutes)");
  expect(identityRoute).toBeGreaterThan(0);
  expect(identityRoute).toBeLessThan(economicRoute);
});
