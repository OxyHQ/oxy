import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const live = process.env.OXY_QA_LIVE === '1';

test('real Console dialog preserves account isolation through A → B → A and both sign-outs', {
  skip: !live,
  timeout: 180000,
}, async () => {
  const { readIdentity, signedApproval, directory } = await import('./qa.mjs');
  const a = await readIdentity('a');
  const b = await readIdentity('b');
  assert.notEqual(a.accountId, b.accountId);
  const receipt = {
    observedAt: new Date().toISOString(),
    origin: 'https://console.oxy.so',
    identities: [a.accountId, b.accountId],
    checks: [],
  };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const pending = new Map();
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (
      url.origin !== 'https://api.oxy.so' ||
      url.pathname !== '/auth/session/create' ||
      !response.ok()
    )
      return;
    try {
      const envelope = await response.json();
      const result = envelope.data ?? envelope;
      if (typeof result.authorizeCode === 'string') pending.set('code', result.authorizeCode);
    } catch {
      /* Navigation may dispose a response; the bounded wait below still fails. */
    }
  });
  const accountVisible = async (identity) => {
    await page.getByText(`@${identity.username}`, { exact: true }).waitFor({ timeout: 30000 });
    await page
      .getByText(`Activity in ${identity.username} at a glance.`, { exact: true })
      .waitFor();
  };
  const approve = async (slot) => {
    const deadline = Date.now() + 20000;
    while (!pending.has('code') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(pending.has('code'), 'The mounted dialog must create its own authorization request');
    const code = pending.get('code');
    pending.delete('code');
    await signedApproval(slot, code, 'https://console.oxy.so');
  };
  try {
    await page.goto('https://console.oxy.so', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Sign in with Oxy', exact: true }).click();
    await approve('a');
    await accountVisible(a);
    receipt.checks.push('dialog-A-claimed-session');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Manage Oxy account', exact: true }).click();
    await page.getByText('Sign-in & security', { exact: true }).waitFor();
    await page.getByText('Manage third-party app access', { exact: true }).waitFor();
    receipt.checks.push('authenticated-settings-rendered');
    await page.goto('https://console.oxy.so', { waitUntil: 'domcontentloaded' });
    await accountVisible(a);
    await page.getByText(`@${a.username}`, { exact: true }).click();
    await page.getByRole('button', { name: 'Add user', exact: true }).click();
    await approve('b');
    await accountVisible(b);
    receipt.checks.push('dialog-B-independent-account');
    await page.getByText(`@${b.username}`, { exact: true }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('button', { name: 'Switch account', exact: true }).click();
    await page.getByRole('button', { name: a.username, exact: true }).click();
    await accountVisible(a);
    assert.equal(
      await page.getByText(`Activity in ${b.username} at a glance.`, { exact: true }).count(),
      0,
    );
    receipt.checks.push('switch-back-A-no-B-dashboard');
    await page.getByText(`@${a.username}`, { exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await accountVisible(b);
    receipt.checks.push('sign-out-A-retains-B');
    await page.getByText(`@${b.username}`, { exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with Oxy', exact: true }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Sign in with Oxy', exact: true }).waitFor();
    receipt.checks.push('sign-out-B-and-reload-remain-anonymous');
    assert.equal((await context.cookies()).length, 0);
    receipt.checks.push('zero-cookies');
    receipt.success = true;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await fs.writeFile(
      path.join(directory, `console-browser-${Date.now()}.json`),
      JSON.stringify(receipt, null, 2),
      { mode: 0o600, flag: 'wx' },
    );
    await context.close();
    await browser.close();
  }
});
