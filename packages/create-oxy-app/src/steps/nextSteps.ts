import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ResolvedConfig } from '../context';

/** Prints the post-scaffold checklist (dev, deploy prerequisites, registration). */
export function printNextSteps(config: ResolvedConfig, installed: boolean): void {
  const rel = path.relative(process.cwd(), config.targetDir) || '.';
  const lines: string[] = [];

  lines.push(pc.bold('Get started:'));
  lines.push(`  ${pc.cyan(`cd ${rel}`)}`);
  if (!installed) {
    lines.push(`  ${pc.cyan('bun install')}`);
  }
  lines.push(`  ${pc.cyan('bun run dev:frontend')}   ${pc.dim('# Expo dev server')}`);
  if (config.backend) {
    lines.push('');
    lines.push(pc.bold('Database (Postgres):'));
    lines.push(
      `  ${pc.cyan('docker compose -f docker-compose.postgres.yml up -d postgres')}`,
    );
    lines.push(
      `  ${pc.cyan(`bun run --cwd packages/backend db:migrate -- --target-database=${config.slug}_dev`)}`,
    );
    lines.push('');
    lines.push(`  ${pc.cyan('bun run dev:backend')}    ${pc.dim('# Express + Socket.IO API')}`);
  }

  if (config.register) {
    lines.push('');
    lines.push(pc.bold('Oxy client:'));
    lines.push(`  Ensure ${pc.cyan('packages/frontend/.env')} has ${pc.bold('EXPO_PUBLIC_OXY_CLIENT_ID')}`);
    lines.push(`  (register at ${pc.cyan('https://console.oxy.so')} if you skipped it).`);
  }

  if (config.deploy) {
    lines.push('');
    lines.push(pc.bold('Before your first AWS deploy:'));
    lines.push(`  1. Create the ECR repository ${pc.cyan(`oxy/${config.slug}`)}.`);
    lines.push(`  2. Add GitHub Actions secrets (${pc.dim('DATABASE_URL, OXY_SERVICE_* , …')}).`);
    lines.push(`  3. Point ${pc.cyan(config.domain)} at the shared ALB and provision the ECS service.`);
  }

  p.note(lines.join('\n'), 'Next steps');
  p.outro(pc.green(`${config.name} is ready. Happy building!`));
}
