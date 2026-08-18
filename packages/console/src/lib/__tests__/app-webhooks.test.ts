import { describe, expect, it } from 'vitest';
import {
  hasWebhookChanges,
  rotatesSigningSecret,
  storedWebhookEndpoints,
  webhookPatch,
} from '@/lib/app-webhooks';

/**
 * The server behaviour these assertions are written against, read from
 * `packages/api/src/routes/applications.ts` (`PATCH /applications/:appId`) and
 * `packages/api/src/schemas/application.schemas.ts`:
 *
 *   - `updateApplicationSchema` is `.strict()`; `webhookUrl` and `devWebhookUrl`
 *     are `z.string().url()` OR the literal `''`. There is no `null` arm for
 *     `webhookUrl`.
 *   - `updates.devWebhookUrl = body.devWebhookUrl || null` — `''` clears.
 *   - `if (body.webhookUrl !== undefined && body.webhookUrl !== stored.webhookUrl)`
 *     then the URL is written AND `webhookSecret` is regenerated (or nulled when
 *     the URL is cleared). Equality with the stored value writes nothing.
 *   - An empty `updates` object writes nothing at all, `updatedAt` included.
 *
 * So the three states this module distinguishes — absent, `''`, a URL — are the
 * server's own three, and the rotation trigger is a comparison the client must
 * predict exactly rather than approximately.
 */
const STORED = storedWebhookEndpoints({
  webhookUrl: 'https://example.com/webhooks/oxy',
  devWebhookUrl: 'https://localhost:3000/webhooks/oxy',
});

describe('storedWebhookEndpoints', () => {
  /**
   * An application that has never configured an endpoint carries no key at all
   * (`serializeApplication` maps the NULL column to `undefined`, and
   * `JSON.stringify` drops it). The form needs a string, and the empty string is
   * also what the route reads as "clear" — so the two directions agree.
   */
  it('reads an unset endpoint as the empty string the form and the route share', () => {
    expect(storedWebhookEndpoints({})).toEqual({ webhookUrl: '', devWebhookUrl: '' });
  });
});

describe('webhookPatch', () => {
  it('sends nothing when neither endpoint changed', () => {
    const patch = webhookPatch(STORED, { ...STORED }, true);
    expect(patch).toEqual({});
    expect(hasWebhookChanges(patch)).toBe(false);
  });

  /**
   * The operation `value.trim() || undefined` would delete: an empty production
   * URL is how delivery is turned off, and an absent key means "leave it alone".
   * A patch that collapsed the two would report success while the endpoint kept
   * receiving events.
   */
  it('sends an empty string — not an absent key — to clear an endpoint', () => {
    const patch = webhookPatch(STORED, { webhookUrl: '', devWebhookUrl: STORED.devWebhookUrl }, true);
    expect(patch).toEqual({ webhookUrl: '' });
    expect('webhookUrl' in patch).toBe(true);
    expect(patch.webhookUrl).toBe('');
  });

  /** The untouched field keeps its key ABSENT, so the route never rewrites it. */
  it('omits the endpoint that did not change', () => {
    const patch = webhookPatch(
      STORED,
      { webhookUrl: STORED.webhookUrl, devWebhookUrl: 'https://staging.example.com/oxy' },
      true
    );
    expect(patch).toEqual({ devWebhookUrl: 'https://staging.example.com/oxy' });
    expect('webhookUrl' in patch).toBe(false);
  });

  /**
   * The rotation hazard. Whitespace around an otherwise unchanged URL must not
   * reach the server: `' https://…' !== 'https://…'` there, so it would rotate a
   * signing secret that no endpoint ever returns — every signature the
   * customer's receiver verifies would start failing, caused by a space.
   */
  it('does not send a URL that differs from the stored one only by whitespace', () => {
    const patch = webhookPatch(
      STORED,
      { webhookUrl: `  ${STORED.webhookUrl}  `, devWebhookUrl: `\t${STORED.devWebhookUrl}` },
      true
    );
    expect(patch).toEqual({});
    expect(rotatesSigningSecret(patch)).toBe(false);
  });

  /** And the trimmed value is what is sent when it IS a change. */
  it('sends the trimmed value, so the comparison and the request agree', () => {
    const patch = webhookPatch(
      STORED,
      { webhookUrl: '  https://new.example.com/oxy  ', devWebhookUrl: STORED.devWebhookUrl },
      true
    );
    expect(patch).toEqual({ webhookUrl: 'https://new.example.com/oxy' });
  });

  /**
   * `webhooks:update` answers to `apps:update` by containment. Without it the
   * form's inputs are disabled, but a stale render must not be able to ship a
   * field the caller may not write — the payload decision is where that is
   * enforced, not the `disabled` attribute.
   */
  it('sends nothing at all when the caller may not edit webhooks', () => {
    const patch = webhookPatch(STORED, { webhookUrl: 'https://evil.example.com/oxy', devWebhookUrl: '' }, false);
    expect(patch).toEqual({});
    expect(hasWebhookChanges(patch)).toBe(false);
  });
});

describe('rotatesSigningSecret', () => {
  /**
   * Any difference in the production URL regenerates the secret server-side —
   * including CLEARING it, which sets it to null. The warning the form shows is
   * read from the patch, so it cannot claim a rotation the request does not
   * cause, or stay silent about one it does.
   */
  it('is true for every production change, clearing included', () => {
    expect(
      rotatesSigningSecret(webhookPatch(STORED, { ...STORED, webhookUrl: '' }, true))
    ).toBe(true);
    expect(
      rotatesSigningSecret(
        webhookPatch(STORED, { ...STORED, webhookUrl: 'https://new.example.com/oxy' }, true)
      )
    ).toBe(true);
  });

  /** The development endpoint has no secret of its own and rotates nothing. */
  it('is false when only the development endpoint changed', () => {
    const patch = webhookPatch(STORED, { ...STORED, devWebhookUrl: '' }, true);
    expect(hasWebhookChanges(patch)).toBe(true);
    expect(rotatesSigningSecret(patch)).toBe(false);
  });
});
