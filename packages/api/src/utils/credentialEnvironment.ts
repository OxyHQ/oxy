/**
 * Which `ApplicationCredential.environment` THIS deployment accepts
 * (issue #972 §2.3).
 *
 * A credential carries the environment it was minted for. Until machine
 * credentials that field described intent and nothing enforced it — an OAuth
 * client id works wherever it is sent. A bearer API key is different: a
 * `development` key that happens to work against `api.oxy.so` is how a laptop
 * ends up spending a production balance, so the machine lane compares the two
 * and refuses a mismatch.
 *
 * ## Resolution order, and why the override exists
 *
 * `OXY_CREDENTIAL_ENVIRONMENT` wins when it names one of the three known
 * environments; otherwise `NODE_ENV === 'production'` decides between
 * `production` and `development`.
 *
 * The override is not decoration. Without it `staging` would be a value Console
 * offers, the schema accepts, and no deployment ever matches — a credential that
 * can be created and can never authenticate, failing silently at the worst
 * moment. A staging deployment sets the variable; every other deployment
 * ignores it.
 *
 * Read per call rather than captured at module load, so a test can set the
 * variable around a case and so a container that has it injected late is not
 * frozen at whatever the value was when the first module imported this.
 */

import { isProduction } from '../config/env';
import {
  APPLICATION_CREDENTIAL_ENVIRONMENTS,
  type ApplicationCredentialEnvironment,
} from '../db/schema/applicationCredentials';

/** The variable a non-production, non-development deployment sets. */
export const CREDENTIAL_ENVIRONMENT_VAR = 'OXY_CREDENTIAL_ENVIRONMENT';

const KNOWN_ENVIRONMENTS: ReadonlySet<string> = new Set<string>(
  APPLICATION_CREDENTIAL_ENVIRONMENTS
);

/**
 * The environment a credential must declare to authenticate here.
 *
 * An unrecognised `OXY_CREDENTIAL_ENVIRONMENT` is IGNORED rather than fatal:
 * this runs on the authentication path, and a typo in an optional variable must
 * not decide between "every key works" and "the process refuses to serve". It
 * falls back to the `NODE_ENV` rule, which is the conservative answer in
 * production.
 */
export function deploymentCredentialEnvironment(): ApplicationCredentialEnvironment {
  const configured = process.env[CREDENTIAL_ENVIRONMENT_VAR];
  if (configured && KNOWN_ENVIRONMENTS.has(configured)) {
    return configured as ApplicationCredentialEnvironment;
  }
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

/**
 * The environment an ATTESTED service token is minted into, and re-read with.
 *
 * A credential carries an environment because a human chose one when they
 * issued it. An attestation carries none — a workload proves what it IS, never
 * which environment it means — so the only honest answer is where this API is
 * running, and taking it from the request would let a caller mint itself a
 * production token from staging.
 *
 * ## Why this is not {@link deploymentCredentialEnvironment}
 *
 * That function answers a different question: which environment a presented
 * CREDENTIAL must declare to authenticate here, and it honours
 * `OXY_CREDENTIAL_ENVIRONMENT` so a staging deployment can accept `staging`
 * keys. There are no `staging` workload tokens to accept: `exchangeWorkloadAttestation`
 * has always written one of two values, and widening that here would change
 * what a minted token says. The two rules are kept apart deliberately rather
 * than merged into one that is right for neither.
 *
 * It lives beside that rule, with the same read-per-call discipline, because it
 * has TWO readers that must agree exactly: the mint
 * (`services/workloadIdentity.service.ts`), which decides what an attested
 * token carries, and `resolveServiceTokenPrincipal`
 * (`services/attribution.service.ts`), which decides what environment an
 * attested request is metered and charged in. Two copies would agree the day
 * they were written; the drift would be a receipt filed under an environment
 * the token never named.
 */
export function workloadTokenEnvironment(): ApplicationCredentialEnvironment {
  return isProduction() ? 'production' : 'development';
}
