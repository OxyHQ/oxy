import { JSDOM } from 'jsdom';
import { renderWelcomeEmail } from '../welcomeEmail';

describe('Oxy welcome email', () => {
  it('renders identity as text even when it contains HTML', () => {
    const name = '<img src="https://example.com/pixel" onerror="alert(1)"> & Ana';
    const address = 'a<b>&"\'@oxy.so';
    const { html, text } = renderWelcomeEmail(name, address);
    const { document } = new JSDOM(html).window;

    expect(document.querySelector('h1')?.textContent).toBe(`Hi ${name},`);
    expect(document.querySelector('strong')?.textContent).toBe(address);
    expect(document.querySelector('img, script, [onerror]')).toBeNull();
    expect(text).toContain(name);
    expect(text).toContain(address);
  });

  it('is self-contained and only links to Oxy, with the same actions in plain text', () => {
    const { html, text, subject } = renderWelcomeEmail('Ana', 'ana@oxy.so');
    const { document } = new JSDOM(html).window;

    expect(subject).toBe('Welcome to Oxy');
    expect(document.querySelector('title')?.textContent).toBe(subject);
    expect(document.querySelector('[src], [srcset], link, script, iframe, object')).toBeNull();
    expect(html).not.toMatch(/url\s*\(|@import|@font-face|google|gstatic|Smiles Davis/i);
    const links = [...document.querySelectorAll('a')];
    expect(links).toHaveLength(5);
    for (const link of links) {
      const url = new URL(link.href);
      expect(url.protocol).toBe('https:');
      expect(url.hostname === 'oxy.so' || url.hostname.endsWith('.oxy.so')).toBe(true);
      expect(text).toContain(link.href.replace(/\/$/, ''));
    }
    for (const heading of document.querySelectorAll('h2')) {
      expect(text).toContain(heading.textContent);
    }
  });

  it('uses a neutral greeting when no name is available', () => {
    const { html, text } = renderWelcomeEmail('  ', 'ana@oxy.so');
    expect(new JSDOM(html).window.document.querySelector('h1')?.textContent).toBe('Hi there,');
    expect(text.startsWith('Hi there,')).toBe(true);
  });
});
