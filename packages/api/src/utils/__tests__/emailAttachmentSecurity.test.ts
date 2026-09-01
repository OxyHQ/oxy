import { assertSafeOutboundAttachment } from '../emailAttachmentSecurity';

describe('outbound attachment policy', () => {
  it('allows ordinary documents and images', () => {
    expect(() => assertSafeOutboundAttachment('invoice.pdf', 'application/pdf')).not.toThrow();
    expect(() => assertSafeOutboundAttachment('screenshot.png', 'image/png')).not.toThrow();
  });

  it.each([
    ['installer.exe', 'application/octet-stream'],
    ['macro.js', 'text/javascript'],
    ['script.bin', 'application/x-executable'],
  ])('rejects executable-looking attachment %s', (name, contentType) => {
    expect(() => assertSafeOutboundAttachment(name, contentType)).toThrow(
      'Executable attachments cannot be sent by Inbox',
    );
  });
});
