import { parseArgs } from './args';
import {
  publishCommand,
  rollbackCommand,
  rollbackToEmbeddedCommand,
  promoteCommand,
  channelListCommand,
  updateListCommand,
} from './commands';

const USAGE = `oxy-ship — publish Expo OTA updates to Oxy Updates

Usage:
  oxy-ship publish --channel <name> [--platform ios|android|all] [--rollout N]
                   [--message "..."] [--runtime-version X] [--dist-dir dir]
                   [--project-dir dir] [--skip-export] [--dry-run] [--json]
  oxy-ship rollback --channel <name> --runtime-version X --platform ios|android
  oxy-ship rollback-to-embedded --channel <name> --runtime-version X --platform ios|android
  oxy-ship promote --update-id <uuid> --to-channel <name> [--rollout N]
  oxy-ship channel:list [--json]
  oxy-ship update:list [--channel <name>] [--runtime-version X] [--platform ios|android] [--limit N] [--json]

Auth: GitHub Actions OIDC (trusted publishing), no secret. Run inside a job
with \`permissions: id-token: write\` whose repository is a registered trusted
publisher of the application.
  --client-id   OXY_SHIP_CLIENT_ID    the application's public client id (oxy_dk_…)
  --url         OXY_API_URL           API origin (default https://api.oxy.so)
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (!command || flags.help) {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case 'publish':
      await publishCommand(flags);
      break;
    case 'rollback':
      await rollbackCommand(flags);
      break;
    case 'rollback-to-embedded':
      await rollbackToEmbeddedCommand(flags);
      break;
    case 'promote':
      await promoteCommand(flags);
      break;
    case 'channel:list':
      await channelListCommand(flags);
      break;
    case 'update:list':
      await updateListCommand(flags);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`oxy-ship: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
