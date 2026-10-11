import { BUN_VERSION, VERSIONS } from './versions';
import type { RenderContext } from './render';

/** Fully-resolved scaffold configuration (flags + prompts merged). */
export interface ResolvedConfig {
  targetDir: string;
  name: string;
  slug: string;
  scheme: string;
  bundleId: string;
  domain: string;
  backend: boolean;
  deploy: boolean;
  demo: boolean;
  install: boolean;
  git: boolean;
  register: boolean;
}

/** kebab-cases an app name into a workspace/package slug. */
export function toSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-') || 'oxy-app'
  );
}

/** Derives an Expo URL scheme (letters + digits only) from a slug. */
export function toScheme(slug: string): string {
  return slug.replace(/[^a-z0-9]/g, '') || 'oxyapp';
}

/** Sensible defaults derived from the app name, overridable by flags/prompts. */
export function deriveDefaults(
  name: string,
): Pick<ResolvedConfig, 'slug' | 'scheme' | 'bundleId' | 'domain'> {
  const slug = toSlug(name);
  const scheme = toScheme(slug);
  return {
    slug,
    scheme,
    bundleId: `com.example.${scheme}`,
    domain: `api.${slug}.example.com`,
  };
}

/** Builds the token + flag maps consumed by the template engine. */
export function buildRenderContext(config: ResolvedConfig): RenderContext {
  const tokens: Record<string, string> = {
    APP_NAME: config.name,
    APP_SLUG: config.slug,
    APP_SCHEME: config.scheme,
    BUNDLE_ID: config.bundleId,
    API_DOMAIN: config.domain,
    BUN_VERSION,
  };

  for (const [key, value] of Object.entries(VERSIONS)) {
    tokens[`v.${key}`] = value;
  }

  return {
    tokens,
    flags: {
      backend: config.backend,
      deploy: config.deploy,
      demo: config.demo,
    },
  };
}
