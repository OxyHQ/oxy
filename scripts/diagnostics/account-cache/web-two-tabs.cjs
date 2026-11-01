const assert = require('node:assert/strict');
const http = require('node:http');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const path = require('node:path');
(async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'web-entry.cjs')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
    nodePaths: require('node:module').globalPaths,
    external: ['@react-native-async-storage/async-storage'],
    logLevel: 'silent',
  });
  const bundle = result.outputFiles[0].text;
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(bundle);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><script src="/bundle.js"></script>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.argv[2] || undefined,
    });
    const ctx = await browser.newContext();
    const p1 = await ctx.newPage(),
      p2 = await ctx.newPage();
    const url = `http://127.0.0.1:${server.address().port}/`;
    await Promise.all([p1.goto(url), p2.goto(url)]);
    await p1.evaluate(async () => {
      await audit.attach();
      audit.set('synthetic-legacy');
      audit.detach();
    });
    await p1.waitForFunction(() => audit.has());
    await Promise.all([p1.evaluate(() => audit.attach()), p2.evaluate(() => audit.attach())]);
    await p1.evaluate(() => audit.signOut());
    await p1.waitForFunction(() => !audit.has());
    await p2.evaluate(() => audit.detach());
    await p1.waitForFunction(() => audit.has());
    assert.match(await p1.evaluate(() => audit.read()), /synthetic-legacy/);
    console.log(
      JSON.stringify({
        browser: 'Chromium',
        tabs: 2,
        sameOrigin: true,
        realWebStorageAdapter: true,
        realServicesPersister: true,
        lateWriterRestoresAfterSignout: true,
        providerAndSession: 'simulated',
        data: 'synthetic',
      }),
    );
    await ctx.close();
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
