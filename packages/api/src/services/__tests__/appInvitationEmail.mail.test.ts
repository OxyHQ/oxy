import { renderAppInvitationEmail } from '../appInvitationEmail.mail';

const base = {
  inviterName: 'Ada',
  inviterHandle: 'ada',
  resourceName: 'Product team',
  applicationName: 'Nilo',
  acceptUrl: 'https://nilo.so/invite/abc?x=1&y=2',
  locale: 'en' as const,
};

describe('the invitation template', () => {
  it('says who invited whom to what, on which application, and where the link goes', () => {
    const { subject, text, html } = renderAppInvitationEmail(base);
    expect(subject).toBe('Ada invited you to Product team on Nilo');
    expect(text).toContain('Ada (@ada) invited you to join Product team on Nilo.');
    expect(text).toContain('Accept invitation: https://nilo.so/invite/abc?x=1&y=2');
    expect(text).toContain('This invitation opens nilo.so.');
    expect(html).toContain('href="https://nilo.so/invite/abc?x=1&#38;y=2"');
  });

  it('escapes every caller- and user-chosen value in the HTML part', () => {
    const { html } = renderAppInvitationEmail({
      ...base,
      inviterName: '<img src=x onerror=alert(1)>',
      resourceName: '"><script>alert(1)</script>',
      applicationName: 'A&B',
    });
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;');
    expect(html).toContain('&#34;&#62;&#60;script&#62;');
    expect(html).toContain('A&#38;B');
  });

  it('carries no image, no stylesheet and no link but the accept URL', () => {
    const { html } = renderAppInvitationEmail(base);
    expect(html).not.toMatch(/<img|<link|url\(/);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      'https://nilo.so/invite/abc?x=1&#38;y=2',
      'https://nilo.so/invite/abc?x=1&#38;y=2',
    ]);
  });

  it('is written in Spanish, and names an inviter without a handle by name alone', () => {
    const { subject, text, html } = renderAppInvitationEmail({
      ...base,
      inviterHandle: null,
      locale: 'es',
    });
    expect(subject).toBe('Ada te ha invitado a Product team en Nilo');
    expect(text).toContain('Ada te ha invitado a unirte a Product team en Nilo.');
    expect(text).toContain('Aceptar invitación: https://nilo.so/invite/abc?x=1&y=2');
    expect(text).not.toContain('(@');
    expect(html).toContain('<html lang="es">');
  });
});
