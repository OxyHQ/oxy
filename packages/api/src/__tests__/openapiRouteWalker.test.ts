import { readFileSync } from 'node:fs';
import path from 'node:path';
import { blankComments, parseRoutesFromFile } from '../../scripts/generate-openapi';
import { INBOX_CAPABILITY_CATALOG } from '../capabilities/inbox.catalog';

/**
 * The route walker decides which credential the PUBLISHED contract says each
 * endpoint needs, and it decides it by scanning source text with regexes. Two
 * measured failures of that approach are what this file exists to hold shut, and
 * both of them are wrong in the direction that matters: they invent or misname a
 * credential requirement rather than erroring.
 *
 * 1. A comment that merely QUOTES a gate was read as the gate.
 *    `src/routes/accounts.ts:81` and `:114` both contain the literal text
 *    `router.use(authMiddleware)` inside prose explaining why the routes above
 *    the real gate at `:314` are deliberately unauthenticated. Scanning raw
 *    source produced two phantom router-level gates at those offsets.
 *
 * 2. Prose inside a handler body derailed the argument reader, which then read
 *    ACROSS route boundaries. `readCallArgs` tracks string literals so it can
 *    skip parens inside them, and an apostrophe in ordinary English ("doesn't")
 *    opens a string that never closes until the next apostrophe — hundreds of
 *    lines later, swallowing whatever gates it passed. Measured on `main`:
 *    `GET /users/me/export` (`routes/users.ts:1319`, gated by `authMiddleware`
 *    at `:1320`) was published as `serviceTokenAuth`, picked up from a
 *    `serviceAuthMiddleware` 450 lines below it at `:1772`.
 *
 * Both are fixed by scanning a comment-blanked copy of the source. A test that
 * asserted only the happy path would pass with either bug present, so every case
 * below pairs the hazard with the control that shows the walker still works.
 */
describe('blankComments', () => {
  it('preserves length exactly, so an offset into the copy is an offset into the original', () => {
    const source = "const a = 1; // a comment\n/* block\n   comment */ const b = 'x';\n";
    expect(blankComments(source)).toHaveLength(source.length);
  });

  it('keeps newlines, so line structure survives', () => {
    const source = '/* one\ntwo\nthree */\n';
    const blanked = blankComments(source);
    expect(blanked.split('\n')).toHaveLength(source.split('\n').length);
    expect(blanked.trim()).toBe('');
  });

  it('blanks comment content and leaves code untouched', () => {
    const blanked = blankComments('keep(1); // drop\nkeep(2);');
    expect(blanked).toContain('keep(1);');
    expect(blanked).toContain('keep(2);');
    expect(blanked).not.toContain('drop');
  });

  it('does NOT treat // inside a string literal as a comment', () => {
    // The control that stops the blanker from eating real code: every route file
    // that builds a URL contains this shape.
    const source = "const url = 'https://api.oxy.so/v1'; const after = 1;";
    expect(blankComments(source)).toBe(source);
  });

  it('does NOT treat /* inside a string literal as a comment', () => {
    const source = 'const glob = "src/**/*.ts"; const after = 1;';
    expect(blankComments(source)).toBe(source);
  });
});

describe('the walker reads code, not prose', () => {
  it('does not treat a router.use quoted in a comment as a gate', () => {
    // Reproduces routes/accounts.ts: prose above a deliberately public route
    // explaining the real gate that comes later.
    const routes = parseRoutesFromFile(`
      const router = Router();
      // These must be registered above the \`router.use(authMiddleware)\` below.
      router.get('/public', asyncHandler(async (req, res) => { res.json({}); }));
    `);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.pathSuffix).toBe('/public');
    expect(routes[0]?.middlewares).not.toContain('authMiddleware');
  });

  it('does not treat a router.use quoted in a BLOCK comment as a gate', () => {
    const routes = parseRoutesFromFile(`
      const router = Router();
      /**
       * Registered before \`router.use(authMiddleware)\` on purpose.
       */
      router.get('/public', asyncHandler(async (req, res) => { res.json({}); }));
    `);

    expect(routes[0]?.middlewares).not.toContain('authMiddleware');
  });

  it('STILL applies a real router-level gate, and only to what follows it', () => {
    // The control for the two cases above: if the blanking were too aggressive,
    // or the gate scan dropped, this is what would go quiet.
    const routes = parseRoutesFromFile(`
      const router = Router();
      router.post('/before', serviceAuthMiddleware, handler);
      router.use(authMiddleware);
      router.get('/after', handler);
    `);

    const before = routes.find((route) => route.pathSuffix === '/before');
    const after = routes.find((route) => route.pathSuffix === '/after');
    expect(before?.middlewares).not.toContain('authMiddleware');
    expect(before?.middlewares).toContain('serviceAuthMiddleware');
    expect(after?.middlewares).toContain('authMiddleware');
  });

  it('recognises the Inbox dual-lane capability gate at router level', () => {
    const routes = parseRoutesFromFile(`
      const router = Router();
      router.use(emailCapabilityAuth);
      router.get('/messages', handler);
    `);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.middlewares).toContain('emailCapabilityAuth');
  });

  it('does not apply a PATH-SCOPED router.use, which gates a subtree it cannot resolve', () => {
    const routes = parseRoutesFromFile(`
      const router = Router();
      router.use('/webauthn', webauthnRouter);
      router.get('/after', handler);
    `);

    expect(routes.find((route) => route.pathSuffix === '/after')?.middlewares).toHaveLength(0);
  });

  it('does not let an apostrophe in a comment carry one route’s middleware into the next', () => {
    // The `/users/me/export` class. Without blanking, the apostrophe in "doesn't"
    // opens a string literal that runs to the one in "isn't", so the first
    // route's argument list swallows the second route's gate.
    const routes = parseRoutesFromFile(`
      const router = Router();
      router.get(
        '/first',
        asyncHandler(async (req, res) => {
          // This doesn't need a credential.
          res.json({});
        })
      );
      router.get(
        '/second',
        serviceAuthMiddleware,
        asyncHandler(async (req, res) => {
          // Which isn't true of this one.
          res.json({});
        })
      );
    `);

    expect(routes.map((route) => route.pathSuffix)).toEqual(['/first', '/second']);
    expect(routes[0]?.middlewares).not.toContain('serviceAuthMiddleware');
    expect(routes[1]?.middlewares).toContain('serviceAuthMiddleware');
  });

  it('still reads the JSDoc above a route, which lives in the ORIGINAL source', () => {
    // Blanking is why this can regress: the summary comes from the comments the
    // code scan deliberately cannot see.
    const routes = parseRoutesFromFile(`
      const router = Router();
      /**
       * Lists the things.
       */
      router.get('/things', handler);
    `);

    expect(routes[0]?.jsdoc).toContain('Lists the things.');
  });
});

describe('the generated Inbox contract preserves both authentication lanes', () => {
  const document = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../openapi.json'), 'utf8'),
  ) as {
    paths: Record<string, Record<string, { security?: Array<Record<string, string[]>> }>>;
  };

  it('publishes only the two explicit email ingress/proxy operations as public', () => {
    const capabilityOperations = new Set(
      INBOX_CAPABILITY_CATALOG.tools.map(
        (tool) => `${tool.invocation.method.toLowerCase()} ${tool.invocation.path}`,
      ),
    );
    const operations = Object.entries(document.paths)
      .filter(([route]) => route.startsWith('/email'))
      .flatMap(([route, methods]) =>
        Object.entries(methods).map(([method, operation]) => ({ route, method, operation })),
      );

    expect(operations.length).toBeGreaterThan(0);
    const deliberatelyPublic = new Set(['post /email/inbound', 'get /email/proxy']);
    for (const { route, method, operation } of operations) {
      const operationKey = `${method} ${route}`;
      expect({ route, method, security: operation.security }).toEqual({
        route,
        method,
        security: capabilityOperations.has(operationKey)
          ? [{ capabilityTicketAuth: [] }, { bearerAuth: [] }]
          : deliberatelyPublic.has(operationKey)
            ? [{}]
            : [{ bearerAuth: [] }],
      });
    }
  });
});
