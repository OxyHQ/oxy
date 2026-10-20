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
    expect(document.querySelector('script, [onerror]')).toBeNull();
    expect(text).toContain(name);
    expect(text).toContain(address);
  });

  it('uses only Oxy assets and links, with the same content in plain text', () => {
    const { html, text, subject } = renderWelcomeEmail('Ana', 'ana@oxy.so');
    const { document } = new JSDOM(html).window;

    expect(subject).toBe('Welcome to Oxy');
    expect(document.querySelector('title')?.textContent).toBe(subject);
    expect(document.querySelector('[srcset], link, script, iframe, object')).toBeNull();
    expect(html).not.toMatch(/url\s*\(|@import|@font-face|google|gstatic|Smiles Davis/i);
    const links = [...document.querySelectorAll('a')];
    expect(links.length).toBeGreaterThanOrEqual(6);
    expect(links.some((link) => new URL(link.href).hostname === 'inbox.oxy.so')).toBe(false);
    const images = [...document.querySelectorAll('img')];
    expect(images.filter((image) => image.alt === 'Oxy')).toHaveLength(2);
    for (const image of images) {
      expect(new URL(image.src).origin).toBe('https://oxy.so');
      expect(image.src).not.toContain('?');
    }
    for (const link of links) {
      const url = new URL(link.href);
      expect(url.protocol).toBe('https:');
      expect(url.hostname === 'oxy.so' || url.hostname.endsWith('.oxy.so')).toBe(true);
      expect(text).toContain(link.href.replace(/\/$/, ''));
    }
    for (const heading of document.querySelectorAll('h2, h3')) {
      expect(text).toContain(heading.textContent);
    }
  });

  it('helps someone already reading inside Inbox', () => {
    const { html, text } = renderWelcomeEmail('Ana', 'ana@oxy.so');
    expect(text).toContain('You are reading your first Oxy email right here in Inbox');
    expect(text).toContain('Choose Compose in Inbox');
    expect(text).toContain('this welcome email');
    expect(text).not.toContain('Open Inbox');
    const document = new JSDOM(html).window.document;
    expect(document.querySelectorAll('h2')).toHaveLength(6);
    expect(document.querySelector('[data-oxy-welcome-version="3"]')).not.toBeNull();
    expect(document.querySelector('a[href="https://accounts.oxy.so/security"]')).not.toBeNull();
    expect(document.querySelector('a[href="https://accounts.oxy.so/data"]')).not.toBeNull();
  });

  it('uses a neutral greeting when no name is available', () => {
    const { html, text } = renderWelcomeEmail('  ', 'ana@oxy.so');
    expect(new JSDOM(html).window.document.querySelector('h1')?.textContent).toBe('Hi there,');
    expect(text.startsWith('Hi there,')).toBe(true);
  });
});
