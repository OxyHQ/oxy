/**
 * `parseInboundMime` on real MIME, through the real mailparser.
 *
 * The Ramp fixture is the shape that put a file named "attachment" under every
 * transactional mail: `multipart/alternative` with text, HTML and an AMP part.
 */

import { isAlternativeBody, parseInboundMime } from '../inboundMime';

const CRLF = '\r\n';
const mime = (lines: string[]) => Buffer.from(lines.join(CRLF));

const RAMP = mime([
  'From: Ramp <communications@ramp.com>',
  'To: nate@oxy.so',
  'Subject: 977687 is your Ramp sign-in code',
  'Message-ID: <UpV8Z1ogS0K5NN1sJAILiA@geopod-ismtpd-9>',
  'Date: Sun, 27 Sep 2026 05:56:22 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '977687',
  '--alt',
  'Content-Type: text/x-amp-html; charset=utf-8',
  '',
  '<!doctype html><html ⚡4email><body>977687</body></html>',
  '--alt',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>977687</p>',
  '--alt--',
  '',
]);

const INLINE_IMAGE = mime([
  'From: Ada <ada@example.com>',
  'To: nate@oxy.so',
  'Subject: Logo',
  'Message-ID: <logo@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<img src="cid:logo@example.com">',
  '--rel',
  'Content-Type: image/png',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <logo@example.com>',
  '',
  Buffer.from('png-bytes').toString('base64'),
  '--rel--',
  '',
]);

const PDF = mime([
  'From: Ada <ada@example.com>',
  'To: nate@oxy.so, Bob <bob@example.com>',
  'Cc: carol@example.com',
  'Subject: Invoice',
  'Message-ID: <invoice@example.com>',
  'In-Reply-To: <parent@example.com>',
  'References: <root@example.com> <parent@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mix"',
  '',
  '--mix',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'See attached.',
  '--mix',
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4').toString('base64'),
  '--mix--',
  '',
]);

describe('parseInboundMime', () => {
  it('keeps the AMP alternative out of the attachments and uses text and HTML as the body', async () => {
    const parsed = await parseInboundMime(RAMP);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.text?.trim()).toBe('977687');
    expect(parsed.html).toContain('<p>977687</p>');
    expect(parsed.messageId).toBe('<UpV8Z1ogS0K5NN1sJAILiA@geopod-ismtpd-9>');
    expect(parsed.from).toEqual({ name: 'Ramp', address: 'communications@ramp.com' });
  });

  it('marks a multipart/related image referenced by Content-ID as inline', async () => {
    const parsed = await parseInboundMime(INLINE_IMAGE);
    expect(parsed.attachments).toEqual([
      expect.objectContaining({ contentType: 'image/png', contentId: '<logo@example.com>', isInline: true }),
    ]);
  });

  it('keeps an ordinary attachment, with threading headers and addressees', async () => {
    const parsed = await parseInboundMime(PDF);
    expect(parsed.attachments).toEqual([
      expect.objectContaining({ filename: 'invoice.pdf', contentType: 'application/pdf', isInline: false, size: 8 }),
    ]);
    expect(parsed.attachments[0]).not.toHaveProperty('contentId');
    expect(parsed.inReplyTo).toBe('<parent@example.com>');
    expect(parsed.references).toEqual(['<root@example.com>', '<parent@example.com>']);
    expect(parsed.to).toEqual([
      { name: '', address: 'nate@oxy.so' },
      { name: 'Bob', address: 'bob@example.com' },
    ]);
    expect(parsed.cc).toEqual([{ name: '', address: 'carol@example.com' }]);
  });
});

describe('Reply-To', () => {
  it('is kept, so a reply goes where the sender asked', async () => {
    const parsed = await parseInboundMime(
      mime([
        'From: Acme Support <no-reply@acme.example>',
        'Reply-To: Ticket 42 <ticket-42@support.acme.example>',
        'To: nate@oxy.so',
        'Subject: Your ticket',
        '',
        'Hello',
      ]),
    );
    expect(parsed.replyTo).toEqual({ name: 'Ticket 42', address: 'ticket-42@support.acme.example' });
  });

  it('is null when the sender set none', async () => {
    expect((await parseInboundMime(RAMP)).replyTo).toBeNull();
  });
});

describe('isAlternativeBody', () => {
  it('keeps an AMP part the sender deliberately attached as a file', () => {
    expect(isAlternativeBody({ contentType: 'text/x-amp-html', filename: 'email.amp.html', contentDisposition: 'attachment' })).toBe(false);
    expect(isAlternativeBody({ contentType: 'text/x-amp-html', filename: undefined, contentDisposition: 'attachment' })).toBe(false);
  });

  it('drops the unnamed AMP and Apple Watch renderings', () => {
    expect(isAlternativeBody({ contentType: 'text/x-amp-html', filename: undefined, contentDisposition: undefined })).toBe(true);
    expect(isAlternativeBody({ contentType: 'TEXT/WATCH-HTML', filename: undefined, contentDisposition: undefined })).toBe(true);
  });

  it('never drops an ordinary file', () => {
    expect(isAlternativeBody({ contentType: 'text/calendar', filename: undefined, contentDisposition: undefined })).toBe(false);
  });
});
