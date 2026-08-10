import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderString, targetSegment, renderTree, type RenderContext } from '../render';

const ctx: RenderContext = {
  tokens: { APP_NAME: 'My App', APP_SLUG: 'my-app', 'v.expo': '^57.0.4' },
  flags: { backend: true, deploy: false, demo: true },
};

describe('renderString', () => {
  test('substitutes known tokens', () => {
    expect(renderString('name={{APP_NAME}} slug={{APP_SLUG}}', ctx)).toBe('name=My App slug=my-app');
  });

  test('substitutes dotted version tokens', () => {
    expect(renderString('"expo": "{{v.expo}}"', ctx)).toBe('"expo": "^57.0.4"');
  });

  test('throws on an unknown token', () => {
    expect(() => renderString('{{NOPE}}', ctx)).toThrow(/Unknown template token/);
  });

  test('keeps a truthy #section and drops its markers', () => {
    expect(renderString('a{{#backend}}B{{/backend}}c', ctx)).toBe('aBc');
  });

  test('removes a falsy #section entirely', () => {
    expect(renderString('a{{#deploy}}B{{/deploy}}c', ctx)).toBe('ac');
  });

  test('inverted ^section keeps content when the flag is falsy', () => {
    expect(renderString('a{{^deploy}}B{{/deploy}}c', ctx)).toBe('aBc');
  });

  test('inverted ^section drops content when the flag is truthy', () => {
    expect(renderString('a{{^backend}}B{{/backend}}c', ctx)).toBe('ac');
  });

  test('a dropped section leaves valid JSON (comma inside the block)', () => {
    const tpl = '["a","b"{{#deploy}},"c"{{/deploy}}]';
    expect(JSON.parse(renderString(tpl, ctx))).toEqual(['a', 'b']);
  });

  test('leaves GitHub Actions ${{ }} expressions untouched', () => {
    const yaml = 'app: {{APP_SLUG}}\nregion: ${{ env.AWS_REGION }}\nsha: ${{ github.sha }}';
    expect(renderString(yaml, ctx)).toBe('app: my-app\nregion: ${{ env.AWS_REGION }}\nsha: ${{ github.sha }}');
  });
});

describe('targetSegment', () => {
  test('rewrites DOT_ prefix to a dot', () => {
    expect(targetSegment('DOT_gitignore', true)).toBe('.gitignore');
    expect(targetSegment('DOT_github', false)).toBe('.github');
  });

  test('strips the .tpl suffix on files only', () => {
    expect(targetSegment('package.json.tpl', true)).toBe('package.json');
    expect(targetSegment('somedir.tpl', false)).toBe('somedir.tpl');
  });

  test('combines DOT_ and .tpl', () => {
    expect(targetSegment('DOT_env.example', true)).toBe('.env.example');
  });
});

describe('renderTree', () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'coa-'));
    srcDir = path.join(base, 'src');
    destDir = path.join(base, 'dest');
    await fs.mkdir(path.join(srcDir, 'packages'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(srcDir), { recursive: true, force: true });
  });

  test('renders names + content and applies overlays without residual tokens', async () => {
    await fs.writeFile(path.join(srcDir, 'package.json.tpl'), '{"name":"{{APP_SLUG}}"}');
    await fs.writeFile(path.join(srcDir, 'DOT_gitignore'), 'node_modules\n');
    await fs.writeFile(
      path.join(srcDir, 'packages', 'readme.md'),
      '# {{APP_NAME}}{{#backend}} with backend{{/backend}}',
    );

    const written = await renderTree(srcDir, destDir, ctx);
    expect(written.length).toBe(3);

    const pkg = await fs.readFile(path.join(destDir, 'package.json'), 'utf8');
    expect(JSON.parse(pkg)).toEqual({ name: 'my-app' });

    const ignore = await fs.readFile(path.join(destDir, '.gitignore'), 'utf8');
    expect(ignore).toBe('node_modules\n');

    const readme = await fs.readFile(path.join(destDir, 'packages', 'readme.md'), 'utf8');
    expect(readme).toBe('# My App with backend');

    // No unresolved template token (not counting any GHA ${{ }} expressions).
    for (const file of written) {
      const content = await fs.readFile(file, 'utf8');
      expect(content).not.toMatch(/(?<!\$)\{\{[A-Za-z0-9_.#/^]+\}\}/);
    }
  });
});

describe('base template bunfig.toml', () => {
  // A literal `bunfig.toml` is stripped from bun/npm publish tarballs (treated
  // as a local config file, like `.npmrc`), so the base template ships it as
  // `bunfig.toml.tpl`; render maps the `.tpl` suffix back to the real filename.
  // This guards against a rename back to the packer-stripped name and against
  // dropping the hoisted linker (isolated linker breaks the scaffold's install).
  test('ships as bunfig.toml.tpl and renders a hoisted-linker bunfig.toml', async () => {
    const templateFile = path.join(__dirname, '..', '..', 'templates', 'base', 'bunfig.toml.tpl');
    const raw = await fs.readFile(templateFile, 'utf8');
    expect(targetSegment('bunfig.toml.tpl', true)).toBe('bunfig.toml');
    expect(renderString(raw, ctx, 'bunfig.toml.tpl')).toContain('linker = "hoisted"');
  });
});

describe('AWS deploy template', () => {
  test('uses an app-specific role and cannot overwrite shared secrets', async () => {
    const templateFile = path.join(
      __dirname,
      '..',
      '..',
      'templates',
      'deploy',
      'DOT_github',
      'workflows',
      'deploy-aws.yml',
    );
    const rendered = renderString(await fs.readFile(templateFile, 'utf8'), ctx, templateFile);

    expect(rendered).toContain('role/oxy-my-app-github-deploy');
    expect(rendered).not.toContain('role/oxy-github-deploy');
    expect(rendered).not.toContain('/oxy/_shared/');
    expect(rendered).not.toContain('AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY');
    expect(rendered).toContain('path="/oxy/$APP/$k"');
  });
});
