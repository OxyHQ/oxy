import path from 'node:path';
import { buildRenderContext, type ResolvedConfig } from './context';
import { renderTree } from './render';

/** The template directories, beside `dist/` in the published package. */
export const TEMPLATES_ROOT = path.resolve(__dirname, '..', 'templates');

type LayerConfig = Pick<ResolvedConfig, 'backend' | 'deploy' | 'demo' | 'language'>;

/**
 * The template directories an app is rendered from, in order: `base` (what every
 * app shares), then its frontend, `jsx` (React components styled with
 * NativeWind) or `language` (the Bloom language, no NativeWind), then the
 * optional backend, deploy workflow and the JSX example screen. The language
 * frontend ships its own example screens, so `demo` is the JSX template's only.
 */
export function templateLayers(config: LayerConfig): string[] {
  return [
    'base',
    config.language ? 'language' : 'jsx',
    ...(config.backend ? ['backend'] : []),
    ...(config.deploy ? ['deploy'] : []),
    ...(config.demo && !config.language ? ['demo'] : []),
  ];
}

/**
 * Renders the app's layers into `config.targetDir` and returns the written
 * paths. Each output file has one owner: two layers that write the same file
 * are an error, so no template depends on the order layers overwrite in.
 */
export async function renderApp(
  config: ResolvedConfig,
  templatesRoot: string = TEMPLATES_ROOT,
): Promise<string[]> {
  const ctx = buildRenderContext(config);
  const owners = new Map<string, string>();
  for (const layer of templateLayers(config)) {
    for (const file of await renderTree(path.join(templatesRoot, layer), config.targetDir, ctx)) {
      const owner = owners.get(file);
      if (owner !== undefined) {
        const relative = path.relative(config.targetDir, file);
        throw new Error(`Template layers "${owner}" and "${layer}" both write ${relative}`);
      }
      owners.set(file, layer);
    }
  }
  return [...owners.keys()];
}
