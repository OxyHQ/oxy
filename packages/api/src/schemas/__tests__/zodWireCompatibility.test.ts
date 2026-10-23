import { createApplicationSchema } from '../application.schemas';
import { batchAccessSchema, playSessionParams } from '../assets.schemas';
import { closeInvoicePeriodBody } from '../accountBilling.schemas';
import { sendMessageSchema } from '../email.schemas';

it('keeps email subject limits in UTF-16 code units', () => {
  const body = { to: [{ address: 'reader@example.com' }] };
  expect(sendMessageSchema.safeParse({ ...body, subject: '😀'.repeat(499) }).success).toBe(true);
  expect(sendMessageSchema.safeParse({ ...body, subject: '😀'.repeat(500) }).success).toBe(false);
});
it('validates application URLs without silently trimming their stored value', () => {
  const websiteUrl = ' https://example.com/path ';
  expect(createApplicationSchema.parse({ name: 'Example', websiteUrl }).websiteUrl).toBe(
    websiteUrl,
  );
});
it('keeps integer validation independent from safe-integer bounds', () => {
  expect(
    batchAccessSchema.parse({ files: [{ fileId: 'file' }], expiresIn: 2 ** 53 }).expiresIn,
  ).toBe(2 ** 53);
  expect(batchAccessSchema.safeParse({ files: [{ fileId: 'file' }], expiresIn: 1.5 }).success).toBe(
    false,
  );
});
it('keeps minute-resolution UTC invoice dates and rejects invalid calendar dates', () => {
  const body = { periodStart: '2026-10-01T00:00Z', periodEnd: '2026-11-01T00:00Z' };
  expect(closeInvoicePeriodBody.safeParse(body).success).toBe(true);
  expect(
    closeInvoicePeriodBody.safeParse({ ...body, periodEnd: '2026-02-30T00:00Z' }).success,
  ).toBe(false);
});

it('keeps generic hexadecimal identifiers accepted by the existing UUID wire field', () => {
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  expect(playSessionParams.parse({ sessionId })).toEqual({ sessionId });
  expect(playSessionParams.safeParse({ sessionId: 'not-a-guid' }).success).toBe(false);
});
