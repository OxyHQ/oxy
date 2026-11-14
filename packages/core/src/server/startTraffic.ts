import { canAttestWorkloadIdentity } from './workloadIdentity';
import {
  createEcosystemTraffic,
  type EcosystemTraffic,
  type EcosystemTrafficOptions,
} from './traffic';

export interface StartEcosystemTrafficOptions
  extends Pick<
    EcosystemTrafficOptions,
    'service' | 'baseURL' | 'workloadCredentials' | 'location' | 'onError' | 'onRecover'
  > {
  /** Read on every heartbeat (10 s): whether this instance shows as online. */
  ready: () => boolean;
  /**
   * Start by default only on a host that can attest its own workload identity
   * (an ECS task), instead of wherever an AWS region is configured. A process
   * with `OXY_ECOSYSTEM_ACTIVITY_ENABLED=true` starts either way.
   */
  deployedOnly?: boolean;
  /** The environment to read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const OFF: EcosystemTraffic = {
  middleware: (_request, _response, next) => next(),
  observeHttp: (_request, _response, next) => next(),
  record: () => undefined,
  wrapFetch: (fetcher) => fetcher,
  installFetch: () => undefined,
  observeSocket: () => () => undefined,
  observeWebSocket: () => () => undefined,
  stop: () => Promise.resolve(),
};

/**
 * The one bootstrap of a service's ecosystem activity: decide from the
 * environment whether this process publishes, start the publisher, and install
 * the outbound `fetch`/`http` observation. Call it once, at process bootstrap
 * (never while constructing an app in a test), and `await traffic.stop()` on
 * shutdown.
 *
 * It always returns a handle. When the process does not publish, the handle
 * does nothing (`observeHttp` calls `next()`, `stop()` resolves), so callers
 * hold no `undefined` to guard.
 *
 * Whether it publishes:
 * - `OXY_ECOSYSTEM_ACTIVITY_ENABLED` is `true` or `false` when set (anything
 *   else throws) and wins over everything below;
 * - unset, it publishes where an AWS region (`AWS_REGION`, else
 *   `AWS_DEFAULT_REGION`) is configured, or with `deployedOnly`, where the
 *   process can attest its workload identity;
 * - once it should publish, a missing region throws: the dashboard has no
 *   location to show.
 *
 * Credentials: pass `workloadCredentials` (typically
 * `createAwsWorkloadCredentialProvider()` from `@oxy.so/core/server/aws`, which
 * also reaches temporary roles on a development host); without it the shared
 * client uses the ECS task role. There is no API-key fallback.
 */
export function startEcosystemTraffic(options: StartEcosystemTrafficOptions): EcosystemTraffic {
  const env = options.env ?? process.env;
  const flag = env.OXY_ECOSYSTEM_ACTIVITY_ENABLED;
  if (flag !== undefined && flag !== 'true' && flag !== 'false') {
    throw new Error('OXY_ECOSYSTEM_ACTIVITY_ENABLED must be true or false');
  }
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  const wanted =
    flag !== undefined
      ? flag === 'true'
      : options.deployedOnly
        ? canAttestWorkloadIdentity(env)
        : Boolean(region);
  if (!wanted) return OFF;
  if (!region) {
    throw new Error(`Ecosystem activity for ${options.service} requires AWS_REGION`);
  }
  const traffic = createEcosystemTraffic({
    service: options.service,
    ready: options.ready,
    baseURL: options.baseURL,
    workloadCredentials: options.workloadCredentials,
    location: options.location,
    onError: options.onError,
    onRecover: options.onRecover,
    region,
  });
  traffic.installFetch();
  return traffic;
}
