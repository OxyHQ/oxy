/**
 * What a claim's URL names (ADR 0041 D10), by its shape alone: an Oxy file by
 * id on the CDN or the API, a stored object by its key, or nothing Oxy can
 * resolve without a person (a page of an app). And the preview token that
 * lets a reviewer see a claimed file: bound to its claim, target, file and
 * reviewer, and short-lived.
 */

import { contentUrlShape } from '../contentClaims/contentClaimUrls';
import {
  CLAIM_PREVIEW_TOKEN_TTL_SECONDS,
  signClaimPreviewToken,
  verifyClaimPreviewToken,
} from '../contentClaims/claimPreviewToken';
import { newClaimReference } from '../contentClaims/contentClaim.service';
import { renderContentClaimMail } from '../contentClaims/contentClaim.mail';

const LEGACY_ID = '64f1a2b3c4d5e6f708192a3b';
const UUID_ID = '0192f0c4-8b3a-7c1d-9e2f-0a1b2c3d4e5f';
const SHA = 'ab'.repeat(32);
const options = { apiHosts: ['api.oxy.so', 'localhost:3001'], cdnHost: 'cloud.oxy.so' };

describe('contentUrlShape', () => {
  it.each([
    [`https://cloud.oxy.so/${LEGACY_ID}`, { kind: 'fileId', fileId: LEGACY_ID }],
    [`https://cloud.oxy.so/${UUID_ID}?variant=thumb`, { kind: 'fileId', fileId: UUID_ID }],
    [`https://api.oxy.so/cdn/${LEGACY_ID}`, { kind: 'fileId', fileId: LEGACY_ID }],
    [`https://api.oxy.so/assets/${LEGACY_ID}`, { kind: 'fileId', fileId: LEGACY_ID }],
    [`https://API.oxy.so/assets/${UUID_ID}/stream?mt=x`, { kind: 'fileId', fileId: UUID_ID }],
    [`https://api.oxy.so/api/assets/${LEGACY_ID}/download`, { kind: 'fileId', fileId: LEGACY_ID }],
    [`https://api.oxy.so/assets/${LEGACY_ID}/url`, { kind: 'fileId', fileId: LEGACY_ID }],
    [`http://localhost:3001/assets/${LEGACY_ID}/stream`, { kind: 'fileId', fileId: LEGACY_ID }],
    [
      `https://cloud.oxy.so/content/2026/10/ab/${SHA}.png`,
      { kind: 'storageKey', key: `content/2026/10/ab/${SHA}.png`, sha256: SHA },
    ],
    [
      `https://cloud.oxy.so/variants/2026/10/ab/${SHA}/w320.webp`,
      { kind: 'storageKey', key: `variants/2026/10/ab/${SHA}/w320.webp`, sha256: SHA },
    ],
  ])('%s names an Oxy file', (url, shape) => {
    expect(contentUrlShape(url, options)).toEqual(shape);
  });

  it.each([
    'https://mention.earth/@ada/posts/123',
    'https://mercaria.co/products/42',
    `https://evil.example/assets/${LEGACY_ID}/stream`,
    `https://api.oxy.so/assets/${LEGACY_ID}/links`,
    'https://api.oxy.so/assets/not-an-id/stream',
    'https://cloud.oxy.so/not-an-id',
    'https://cloud.oxy.so/',
    'not a url',
  ])('%s needs a person', (url) => {
    expect(contentUrlShape(url, options)).toEqual({ kind: 'other' });
  });
});

describe('the preview token', () => {
  const grant = { claimId: 'c1', targetId: 't1', fileId: 'f1', userId: 'u1' };
  beforeAll(() => {
    process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  });

  it('opens exactly its claim and target, for its lifetime', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    const { token, expiresAt } = signClaimPreviewToken(grant, now);
    expect(expiresAt.getTime() - now.getTime()).toBe(CLAIM_PREVIEW_TOKEN_TTL_SECONDS * 1000);
    expect(verifyClaimPreviewToken(token, { claimId: 'c1', targetId: 't1' }, now)).toEqual({
      fileId: 'f1',
      userId: 'u1',
    });
    expect(verifyClaimPreviewToken(token, { claimId: 'c2', targetId: 't1' }, now)).toBeNull();
    expect(verifyClaimPreviewToken(token, { claimId: 'c1', targetId: 't2' }, now)).toBeNull();
    expect(verifyClaimPreviewToken(token, { claimId: 'c1', targetId: 't1' }, expiresAt)).toBeNull();
  });

  it('refuses anything not minted here', () => {
    const { token } = signClaimPreviewToken(grant);
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ c: 'c1', t: 't1', f: 'someone-elses-file', u: 'u1', e: 9_999_999_999 }),
    ).toString('base64url');
    for (const candidate of [
      `${forged}.${signature}`,
      `${payload}.${signature.slice(0, -2)}AA`,
      payload,
      `${token}.extra`,
      '',
    ]) {
      expect(verifyClaimPreviewToken(candidate, { claimId: 'c1', targetId: 't1' })).toBeNull();
    }
  });
});

describe('references and emails', () => {
  it('mints readable references', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const reference = newClaimReference();
      expect(reference).toMatch(/^OXY-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      seen.add(reference);
    }
    expect(seen.size).toBeGreaterThan(195);
  });

  it('tells an owner what was removed and how to dispute it, never who complained', () => {
    const mail = renderContentClaimMail('content_blocked', {
      reference: 'OXY-AAAA-BBBB',
      claimKind: 'copyright',
      greetingName: '@ada',
      note: null,
      fileNames: Array.from({ length: 22 }, (_, i) => `photo-${i}.png`),
      targetCount: 0,
    });
    expect(mail.subject).toBe('Some of your content on Oxy was removed');
    expect(mail.text).toContain('Hi @ada,');
    expect(mail.text).toContain('a copyright claim (reference OXY-AAAA-BBBB)');
    expect(mail.text).toContain('- photo-19.png');
    expect(mail.text).not.toContain('photo-20.png');
    expect(mail.text).toContain('- and 2 more');
    expect(mail.text).toContain('legal@oxy.so');
    expect(mail.html).toContain('<p style="margin:0 0 16px">- photo-0.png</p>');
  });

  it('escapes what staff wrote in the HTML part', () => {
    const mail = renderContentClaimMail('claim_rejected', {
      reference: 'OXY-AAAA-BBBB',
      claimKind: 'other',
      greetingName: 'Ada <script>',
      note: 'Not <b>ours</b>',
      fileNames: [],
      targetCount: 1,
    });
    expect(mail.text).toContain('Why: Not <b>ours</b>');
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).not.toContain('<script>');
  });
});
