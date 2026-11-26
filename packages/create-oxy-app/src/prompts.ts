import path from 'node:path';
import * as p from '@clack/prompts';
import { deriveDefaults, toScheme, toSlug, type ResolvedConfig } from './context';

/** Parsed CLI arguments (before interactive prompts fill any gaps). */
export interface CliArgs {
  dir?: string;
  name?: string;
  slug?: string;
  scheme?: string;
  bundleId?: string;
  domain?: string;
  backend: boolean;
  deploy: boolean;
  minimal: boolean;
  /** `--language` (true), `--jsx` (false), or unsaid (asked, else JSX). */
  language?: boolean;
  install: boolean;
  git: boolean;
  register: boolean;
  yes: boolean;
}

function bail(): never {
  p.cancel('Scaffolding cancelled.');
  process.exit(1);
}

function unwrap<T>(value: T | typeof p.CANCEL_SYMBOL): T {
  if (p.isCancel(value)) {
    bail();
  }
  return value as T;
}

/** Merges CLI args with interactive prompts into a fully-resolved config. */
export async function resolveConfig(args: CliArgs): Promise<ResolvedConfig> {
  const interactive = !args.yes && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

  const nameFromDir = args.dir ? path.basename(path.resolve(args.dir)) : undefined;

  let name = args.name ?? nameFromDir;
  if (!name && interactive) {
    name = unwrap(
      await p.text({
        message: 'What is your app called?',
        placeholder: 'My Oxy App',
        validate: (value) => (value?.trim() ? undefined : 'Name is required'),
      }),
    );
  }
  name = (name ?? 'oxy-app').trim();

  const defaults = deriveDefaults(name);

  let slug = args.slug ? toSlug(args.slug) : defaults.slug;
  let scheme = args.scheme ? toScheme(args.scheme) : defaults.scheme;
  let bundleId = args.bundleId ?? defaults.bundleId;
  let domain = args.domain ?? defaults.domain;
  let backend = args.backend;
  let deploy = args.deploy;
  let language = args.language ?? false;

  if (interactive) {
    const answers = await p.group(
      {
        slug: () => p.text({ message: 'Package slug (workspace scope)', initialValue: slug }),
        scheme: () => p.text({ message: 'App URL scheme', initialValue: scheme }),
        bundleId: () =>
          p.text({ message: 'iOS/Android bundle identifier', initialValue: bundleId }),
        domain: () => p.text({ message: 'Backend API domain', initialValue: domain }),
        backend: () =>
          p.confirm({ message: 'Include an Express + Socket.IO backend?', initialValue: backend }),
        deploy: () =>
          p.confirm({ message: 'Include the AWS deploy workflow?', initialValue: deploy }),
        language: () =>
          args.language === undefined
            ? p.select({
                message: 'How is the frontend written?',
                initialValue: 'jsx',
                options: [
                  { value: 'jsx', label: 'JSX', hint: 'React components, NativeWind' },
                  {
                    value: 'language',
                    label: 'Bloom language',
                    hint: 'views as functions, modifier chains, no NativeWind',
                  },
                ],
              })
            : Promise.resolve(language ? 'language' : 'jsx'),
      },
      { onCancel: bail },
    );
    slug = toSlug(answers.slug);
    scheme = toScheme(answers.scheme);
    bundleId = answers.bundleId.trim();
    domain = answers.domain.trim();
    backend = answers.backend;
    deploy = answers.deploy;
    language = answers.language === 'language';
  }

  // The deploy workflow only makes sense alongside the backend it deploys.
  if (!backend) {
    deploy = false;
  }

  const targetDir = path.resolve(process.cwd(), args.dir ?? slug);

  return {
    targetDir,
    name,
    slug,
    scheme,
    bundleId,
    domain,
    backend,
    deploy,
    demo: !args.minimal,
    language,
    install: args.install,
    git: args.git,
    register: args.register,
  };
}
