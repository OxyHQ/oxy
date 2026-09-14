# First-party web activity

Accounts (`oxy-accounts`) and Console (`oxy-console`) observe requests in Workers before the ASSETS binding. Auth (`oxy-auth`) uses root Pages directory middleware alongside its existing `/hub/*` functions. All assets and navigations are included; the original Response, headers, cookies, streams and errors remain owned by their existing handlers.

Each deployed target requires private bindings `OXY_EDGE_ACTIVITY_ENABLED=true`, `OXY_EDGE_ACTIVITY_API_KEY`, `OXY_EDGE_ACTIVITY_API_SECRET`, and optionally `OXY_EDGE_ACTIVITY_API_URL`. These credentials are separate from browser client IDs and must never be exposed through VITE_/EXPO_PUBLIC_ variables. Missing enablement keeps telemetry off. Publication runs in waitUntil and does not send URLs, cookies, IPs, IDs or payloads.

The serving Cloudflare PoP is infrastructure metadata. External activity appears as a pulse, not an invented arc to a visitor's physical location. Counts represent observed operations rather than bytes.

Commons is a native-only identity vault and has no web deployment or Cloudflare resource in this repository. Its network requests are observed by the Oxy API; there is no synthetic Commons edge producer.
