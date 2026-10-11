# Cloudflare web activity (keyless)

oxy-api reads the request counts of every Cloudflare-hosted Oxy web app
(Workers and Pages front ends) from Cloudflare's own analytics and publishes
them into the ecosystem activity collector behind oxy.so/dashboard. The web
apps hold **no secret and run no activity code**. It replaces the retired
`edge` credential lane, which would have given every Worker/Pages project its
own Oxy key pair (`OXY_EDGE_ACTIVITY_API_KEY/SECRET`). That lane was never run.

Code: `packages/api/src/services/cloudflareWebActivity.service.ts`. Reviewed
host map: `packages/api/src/config/cloudflareWebActivityHosts.ts`.

## What the dashboard receives

Each closed one-minute window yields Cloudflare's `httpRequestsAdaptiveGroups`
count of visitor requests (`requestSource: "eyeball"`). Counts are grouped by
the **exact** HTTP host and the serving PoP, and attributed through the
reviewed map. There is no suffix or fuzzy matching, and an unlisted host is not
measured. Each (service, PoP) pair becomes one flow:
`scope: external`, `direction: inbound`, `region`/`targetRegion: edge-<pop>`,
`targetService: <service>`.

This is the same shape the retired edge observer would have produced. The PoP is
infrastructure, not the visitor's location, so no visitor arc is drawn. No
outbound flow is sent, because a request count says nothing about responses.

| Field | Meaning |
|---|---|
| `requests` | Cloudflare's sample-adjusted estimate for the window |
| `windowStartedAt` / `windowEndedAt` | The real counted window. `windowEndedAt` is additive; older readers ignore it |
| `emittedAt` | When oxy-api published the flow |

The data is **about three minutes old**: a window is read only after
`SETTLE_DELAY_MS`, because Cloudflare's analytics arrive late. Rows Cloudflare
records after that point are not counted. The result can under-count, but never
counts twice.

Flows are capped at 200 per window. The long tail is folded per service into
region `unknown`, so totals stay exact.

**Mention is deliberately absent.** `mention.earth` is proxied to the Mention
backend on AWS, which serves the web app and already reports that traffic itself.
API hosts are never listed either: they are DNS-only, and their backends
self-report. The unit test enforces both rules.

## Exactly once across tasks

Every oxy-api task runs the 30-second timer. One Redis key,
`platform-activity:cloudflare-web:cursor`, records the end of the last
claimed window.

1. A task claims `[cursor, settledEnd)` by compare-and-set. Only the winner
   queries Cloudflare and publishes.
2. If the query fails, the winner restores the cursor, so the next tick retries
   the same window.

Failure and gap behaviour:

- **Task dies between claim and publish:** that one window is lost. Delivery is
  deliberately at most once: the stream is a live pulse with no store, and a gap
  under-reports where a duplicate would overstate.
- **Downtime under 30 minutes:** covered by one aggregate on the next claim.
- **Downtime over 30 minutes:** the older part is skipped and logged with its
  exact range.
- **First run:** starts from now, with no backfill.
- **No `REDIS_URL`:** the poller does not run, because it cannot coordinate
  tasks.

## Enabling it

The poller is disabled unless `CLOUDFLARE_ANALYTICS_API_TOKEN` is set. When
disabled it logs one line: `Cloudflare web activity is disabled: ...`.

### The Cloudflare token

Create **one** custom API token in the Oxy Cloudflare account (My Profile →
API Tokens, or an account-owned token). All of its permissions are read-only:

| Scope | Permission | Why |
|---|---|---|
| Account | **Account Analytics: Read** | GraphQL Analytics API access |
| Zone | **Analytics: Read** | `httpRequestsAdaptiveGroups` on each zone |
| Zone | **Zone: Read** | Resolve each zone name in the map to its zone id |

Zone resources: **Include** these specific zones:

- `oxy.so`
- `alia.onl`
- `allo.you`
- `clarity.surf`
- `homiio.com`
- `mercaria.co`
- `moovo.now`
- `nilo.so`
- `peable.to`
- `syra.fm`
- `tnp.network`
- `fairco.in`

This is the exact set of `zone` values in the host map; its test lists them.
"All zones from an account" also works, but is wider than needed.

Do not grant any Edit permission, Workers, Pages, DNS, or account-settings
scope. A zone outside the token's reach is logged once per hour
(`zones not visible to the analytics token`) and skipped, never guessed.

### oxy-infra changes (not made here)

1. **SSM:** create the SecureString `/oxy/oxy-api/CLOUDFLARE_ANALYTICS_API_TOKEN`
   holding the token.
2. **oxy-api task definition** (`terraform-uswest2/app-services.tf`, the oxy-api
   `secrets` list): add
   `{ name = "CLOUDFLARE_ANALYTICS_API_TOKEN", valueFrom = "${local.ssm}/oxy/oxy-api/CLOUDFLARE_ANALYTICS_API_TOKEN" }`.
   Optionally add the plain, non-secret environment value
   `{ name = "CLOUDFLARE_ACCOUNT_ID", value = "<account id>" }` to narrow the
   zone lookup to Oxy's account.
3. **Execution role:** the fleet `ecs_execution` role must be able to run
   `ssm:GetParameters` on that parameter, and `kms:Decrypt` with
   `alias/aws/ssm`. It already reads every other `/oxy/oxy-api/*` SecureString
   in that task definition. Confirm the grant is path-wide; if it lists
   parameters one by one, add this one.
4. No task-role, IAM-user, or Oxy-credential change. oxy-api still
   authenticates only as its ECS task role (ADR 0026), and no Oxy key pair is
   minted for any web app.

### Verify after deploy

- Each oxy-api task logs `Cloudflare web activity enabled` once.
- Within a few minutes, exactly one task per window publishes. The dashboard
  shows pulses at `edge-*` PoPs for the listed services, carrying
  `windowEndedAt`.
- A `Cloudflare web activity poll failed` error names only an HTTP status:
  Cloudflare response bodies are never logged.

## Changing the host map

Add an entry only for a Cloudflare-proxied web front end whose hostname is
declared, for example a `wrangler.toml` custom-domain route or a Pages custom
domain. Use the product's existing dashboard service name.

If the entry is in a new zone, add that zone to the token's zone resources.
Without it, the entry is logged as not visible and is not measured.
