import assert from 'node:assert/strict';
import { OAUTH_POPUP_HTML, OAUTH_MISMATCH_POPUP_HTML } from './isolated-oauth-popup-html.mjs';

const { chromium } = await import(process.env.OXY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  for (const mismatch of [false, true]) {
    const context = await browser.newContext();
    const errors = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    await context.route('https://fixture.example.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><p>Fixture opener</p>',
      }),
    );
    await context.route('https://auth.oxy.so/authorize**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: mismatch ? OAUTH_MISMATCH_POPUP_HTML : OAUTH_POPUP_HTML,
      }),
    );
    const page = await context.newPage();
    await page.goto('https://fixture.example.test/');
    const payload =
      '</script><script>window.injected = true; window.opener.injected = true;</script>';
    const url = new URL('https://auth.oxy.so/authorize');
    url.searchParams.set('state', payload);
    url.searchParams.set('redirect_uri', 'https://fixture.example.test/');
    await page.evaluate(() => {
      window.fixtureMessage = new Promise((resolve) =>
        window.addEventListener(
          'message',
          (event) => resolve({ data: event.data, origin: event.origin }),
          { once: true },
        ),
      );
    });
    const opened = context.waitForEvent('page');
    await page.evaluate((target) => {
      window.open(target);
    }, url.href);
    const popup = await opened;
    const message = await page.evaluate(() => window.fixtureMessage);
    assert.deepEqual(message, {
      data: {
        type: 'oxy:oauth:code',
        code: 'fixture-code',
        state: mismatch ? 'mismatched-state' : payload,
      },
      origin: 'https://auth.oxy.so',
    });
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await popup.evaluate(() => window.injected), undefined);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        mismatch,
        terminatorPayloadPreserved: !mismatch,
        injectedScriptExecuted: false,
        result: 'PASS',
      }),
    );
    await context.close();
  }
} finally {
  await browser.close();
}
