import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ResolvedConfig } from '../context';

const CONSOLE_URL = 'https://console.oxy.so';

function manualInstructions(config: ResolvedConfig): void {
  p.log.warn(
    `${pc.yellow('Register your Oxy client to finish setup.')}\n`
      + `Register ${config.name} at ${pc.cyan(CONSOLE_URL)}:\n`
      + `  1. Create an Application, then a public credential (client_id `
      + `${pc.dim('oxy_dk_…')}).\n`
      + `  2. Put it in ${pc.cyan('packages/frontend/.env')} as `
      + `${pc.bold('EXPO_PUBLIC_OXY_CLIENT_ID')}.`,
  );
}

/**
 * Point the developer at the Console to register an Oxy client + public
 * credential for the new app.
 *
 * The CLI does not sign in on the developer's behalf: registering a client is
 * a quick one-time step in the Console, where the developer is already signed
 * in.
 */
export async function registerOxyClient(config: ResolvedConfig): Promise<void> {
  if (!config.register) {
    return;
  }
  manualInstructions(config);
}
