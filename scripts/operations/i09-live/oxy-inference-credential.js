/**
 * The Oxy service-token exchange — epic #139 workstream 2, *"Configure
 * short-lived Oxy service-token exchange through `@oxy.so/core`."*
 *
 * ## What this module is
 *
 * The adapter between an Oxy ApplicationCredential in the environment and the
 * published {@link OxyInferenceCredential} accepted by
 * {@link import('@oxy.so/core').OxyInferenceClient}. The credential is presented
 * only to Oxy; Oxy resolves the authenticated application identity and is the
 * only component that calls Kaana.
 *
 * ## What this module deliberately does NOT do
 *
 * **It mints nothing at import.** `createOxyInferenceCredential` is a function,
 * not a module-level constant, so importing this file opens no socket and reads
 * no credential. That is what lets `oxy-inference-boot-check.ts` depend on the variable
 * NAMES without putting a token exchange on the boot path.
 *
 * **It implements no caching, no refresh and no expiry arithmetic.** All three
 * live in `@oxy.so/core` (`getServiceToken` / `invalidateServiceToken`), which
 * caches per `(apiKey, apiSecret)` pair, refreshes 60 seconds BEFORE the token
 * expires, deduplicates concurrent callers onto one in-flight request, and
 * verifies the secret in constant time on every cache hit. Re-implementing any
 * of that here would be a second session mechanism in a consuming app, which is
 * exactly what the ecosystem rule forbids — and it would be a WORSE one, since
 * the token's real lifetime is the one the Oxy edge returns in `expiresIn` and
 * only the code that read that response knows it.
 *
 * `__tests__/oxy-inference.test.ts` therefore asserts the composition against
 * a real `OxyServices` and a real `/auth/service-token` round trip rather than
 * against a fake: "the token is short-lived" is a property of what this hands
 * back, not of any line in this file.
 *
 * ## Why a dedicated `OxyServer` instance
 *
 * `middleware/auth.ts` constructs the API's own `OxyServer` for VERIFYING
 * inbound user tokens, and it never configures service credentials. Arming a
 * service credential on that instance would arm `serviceRequest`
 * everywhere else in the process as a side effect of wiring Kaana, and would
 * make the inference layer import the Express middleware graph. One instance per
 * purpose is also what the SDK's per-credential cache is designed for.
 */
import { OxyServer, canAttestWorkloadIdentity } from '@oxy.so/core/server';
/**
 * The ApplicationCredential this deployment presents to mint service tokens.
 *
 * These two values describe one Oxy ApplicationCredential. The identifier and
 * account are resolved by Oxy from the minted service token; Alia neither
 * configures nor asserts them on an inference request.
 *
 * Separate credentials per environment are `#139` §2's own row, *"Create
 * separate development, staging and production ApplicationCredentials"*: these
 * variables are how a deployment carries whichever one it was issued.
 *
 * These names are coordinated with the task definition and repository secrets.
 * No former spelling is read; a partial rollout is a boot refusal.
 *
 * ## A deployed Alia sets neither
 *
 * Under oxy ADR 0026 a first-party service proves what it IS — a signed
 * `GetCallerIdentity` for its ECS task role, which Oxy replays to AWS — and gets
 * back the same short-lived service token these two used to buy. `@oxy.so/core`
 * >= 1.6.1 takes that path inside `getServiceToken()` whenever no pair was
 * configured, so a task definition carrying neither variable mints exactly as
 * before. They remain the way a CHECKOUT, which can attest nothing, borrows
 * Alia's identity.
 */
export const OXY_INFERENCE_CREDENTIAL_ENV = {
    apiKey: 'OXY_SERVICE_API_KEY',
    apiSecret: 'OXY_SERVICE_API_SECRET',
};
/**
 * Where the token is minted.
 *
 * Not a Kaana variable and not new: this is the Oxy identity API the whole
 * process already talks to (`middleware/auth.ts`, `lib/tools/oxy-services.ts`),
 * and the token exchange is one more endpoint on it. Required rather than
 * defaulted here — inventing a base URL for a credential exchange is how a
 * staging deployment mints production tokens.
 */
export const OXY_API_URL_ENV = 'OXY_API_URL';
/**
 * Every variable the exchange needs on a machine that cannot attest.
 *
 * Kept as the full list, and deliberately not narrowed to what a deployment
 * carries: it describes a CHECKOUT, which is the only environment where all
 * three are still required, and `.env.example` and the runbooks name the same
 * three. What a deployed task actually needs is
 * {@link unsetOxyInferenceCredentialVariables} evaluated against its own
 * environment, which is a different question with a different answer.
 */
export const OXY_INFERENCE_CREDENTIAL_REQUIRED_ENV = [
    OXY_INFERENCE_CREDENTIAL_ENV.apiKey,
    OXY_INFERENCE_CREDENTIAL_ENV.apiSecret,
    OXY_API_URL_ENV,
];
/**
 * Whether this process can mint an Oxy service token at all.
 *
 * Two ways, and a deployment has one of them without anybody configuring it: in
 * ECS the task role attests (oxy ADR 0026 — no secret anywhere) and elsewhere
 * the key pair does. A local checkout has neither, which is the honest answer to
 * "can this talk to Oxy as Alia".
 *
 * Both or neither for the pair. One alone is not half an identity — it REPLACES
 * the attestation path with a credential that cannot mint, so it reads here as
 * no pair at all and the deployment falls back to what it can prove.
 */
function canMintOxyServiceToken(env) {
    if (canAttestWorkloadIdentity(env))
        return true;
    return ((env[OXY_INFERENCE_CREDENTIAL_ENV.apiKey] ?? '').trim().length > 0 &&
        (env[OXY_INFERENCE_CREDENTIAL_ENV.apiSecret] ?? '').trim().length > 0);
}
/**
 * What this environment is missing before it can exchange a credential, if
 * anything.
 *
 * Presence only. Whether the credential is ACCEPTED is a question for the Oxy
 * edge and is answered on the first exchange — a check that tried to answer it
 * would either mint a token before the process serves anything or guess at a
 * format, and the format of an `oxy_dk_` key is the control plane's business,
 * not this deployment's.
 *
 * ## Why the pair is conditional and the origin is not
 *
 * This is the function that would have refused to start a deployment that could
 * mint perfectly well. It used to name the two credential variables whenever
 * they were unset, and `runBootGuards` turns anything it returns into
 * `process.exit(1)` before the socket opens — so removing the pair from the task
 * definition, which is the whole of the ADR 0026 migration, would have killed
 * the API at boot, been rolled back by the ECS circuit breaker, and left an
 * operator looking at a stable service and a failed deploy with nothing naming
 * the cause.
 *
 * `OXY_API_URL` stays unconditional: attestation says what this process IS, not
 * where Oxy is, and a token with nowhere to present it is worth nothing. A
 * checkout that can attest nothing still gets an accurate refusal naming all
 * three, because setting all three is still the thing to do there.
 *
 * Returned as a LIST rather than as a sentence because
 * `oxyInferenceBootConfigurationFailure` folds it into the one message that names every
 * unset Oxy inference variable at once. Two messages would send an operator round the
 * deploy loop twice: once for the principal, once for the credential.
 */
export function unsetOxyInferenceCredentialVariables(env) {
    const unset = (variable) => (env[variable] ?? '').trim().length === 0;
    const missing = [];
    if (unset(OXY_API_URL_ENV))
        missing.push(OXY_API_URL_ENV);
    if (canMintOxyServiceToken(env))
        return missing;
    missing.push(OXY_INFERENCE_CREDENTIAL_ENV.apiKey, OXY_INFERENCE_CREDENTIAL_ENV.apiSecret);
    return missing;
}
/**
 * The credential the Oxy inference client authenticates every call with.
 *
 * Throws when the environment cannot configure one, naming the variables that
 * are unset. A factory that returned a credential which failed on first use
 * instead would turn a deployment mistake into one `authentication_failed` per
 * user request, which is the failure {@link unsetOxyInferenceCredentialVariables}
 * exists to move to boot.
 *
 * The returned function delegates token minting and refresh to `OxyServices`,
 * retaining the SDK's cache and concurrent-call deduplication instead of
 * reimplementing either in Alia.
 */
export function createOxyInferenceCredential(env = process.env) {
    const unset = unsetOxyInferenceCredentialVariables(env);
    if (unset.length > 0) {
        throw new Error(`the Oxy inference service-token exchange has no credential: ${[...unset].sort().join(', ')} not set`);
    }
    // Trimmed, and by the same expression the presence check uses. A secret that
    // reached the environment from a file carries the file's trailing newline, and
    // a credential that differs from the one the operator set by one invisible
    // character fails with a 401 that names nothing.
    const read = (variable) => (env[variable] ?? '').trim();
    /**
     * Armed only with a COMPLETE pair, and left unconfigured otherwise on purpose.
     *
     * `serviceToken()` falls back to attesting this task role when nothing was
     * configured, so not calling this is what takes the ADR 0026 path. Calling it
     * with half a pair would replace that path with a credential that cannot mint
     * and turn a working deployment into one `authentication_failed` per request —
     * which is why the check is both values rather than either.
     */
    const apiKey = read(OXY_INFERENCE_CREDENTIAL_ENV.apiKey);
    const apiSecret = read(OXY_INFERENCE_CREDENTIAL_ENV.apiSecret);
    const oxy = new OxyServer({
        baseURL: read(OXY_API_URL_ENV),
        ...(apiKey !== '' && apiSecret !== '' ? { serviceAuth: { apiKey, apiSecret } } : {}),
    });
    return () => oxy.serviceToken();
}
