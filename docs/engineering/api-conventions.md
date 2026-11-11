# Oxy product API conventions

Applies to every public or cross-app HTTP API an Oxy product publishes (GoWay `/api/v1`, Mercaria `/public/v1`, and any SDK built on them). Internal admin routes converge on it as they are touched.

## Contract source of truth
- One `packages/contracts` workspace per product, written in **zod 4**. It is the only definition of every request, response, error code and closed value set.
- TypeScript types are `z.infer` of those schemas. The backend validates requests with them and the SDK parses responses with them. Hand-written duplicate interfaces, backend `*Schemas.ts` copies and hand-rolled SDK parsers are not allowed.
- JSON Schema comes from `z.toJSONSchema` (pattern: [CrowdSource `packages/contracts/src/json-schema.ts`](https://github.com/OxyHQ/CrowdSource/blob/main/packages/contracts/src/json-schema.ts)). Refinements are dropped in the export; the zod schema stays the authority.
- OpenAPI 3.1 is generated from a route registry in `contracts` (method, path, params, query, body, responses → schema names), served at `<base>/openapi.json`, and committed. A CI gate fails when it is stale (pattern: [`scripts/check-openapi-fresh.mjs`](../../scripts/check-openapi-fresh.mjs)).

## Success responses
- No envelope: the body **is** the contract value. HTTP status carries success.
- `201` with the created resource for creates, `204` with no body for deletes.

## Errors
- Every non-2xx response is `{ "error": { "code", "message", "details"? } }`. The `429` from the rate limiter is included: no plain-text bodies.
- `code` is snake_case, drawn from a closed list in `contracts`, and the SDK maps it to a typed error. Renaming a code is a breaking change.
- `message` is human-readable and safe to log, but never parse it.
- `details` holds scalars only. It never holds user content or a coordinate.
- Shared codes and statuses:

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Malformed JSON, wrong type, missing field, unknown or repeated query parameter, or a cursor that belongs to another list. |
| `unauthorized` | 401 | No credentials, or credentials that did not verify. |
| `forbidden` | 403 | Authenticated, but not permitted to do this. |
| `not_found` | 404 | The resource never existed, or the caller can't see it. |
| `unknown_route` | 404 | No such route. The SDK uses this to detect that it is running against an older or newer API version. |
| `gone` | 410 | The resource existed and was withdrawn: archived, removed, restricted or closed. |
| `conflict` | 409 | The request conflicts with current state. |
| `validation_failed` | 422 | Well-formed, but the values are refused. |
| `rate_limited` | 429 | Rate limit hit; `details.retryAfterSeconds` and the `Retry-After` header are set. |
| `internal_error` | 500 | Unexpected server defect. Never carries internal detail. |
| `service_unavailable` | 503 | The service is degraded or not yet ready. |

  Products add their own domain codes (GoWay `no_route` and `provider_unavailable`, Mercaria `out_of_stock`) to their own list.

## Lists and pagination

Every list is a page: a `limit`, an optional `cursor`, and a response that says whether and where it continues.

- **Request:** `limit` has a documented default and maximum, and a value outside the range is `validation_failed`. `cursor` is the `nextCursor` of the previous page, passed back verbatim.
- **Response:** `{ "items": T[], "nextCursor": string | null }`. There are no totals and no `count(*)`. Where an API also exposes `hasMore` (Mention's feeds do), it is true exactly when `nextCursor` is present, and a page that cannot name a continuation reports `hasMore: false` rather than a cursor that repeats.
- **The last page** carries `nextCursor: null` (or omits it where the contract is optional-valued). A server must never return a cursor that equals the one it was given: clients and the SDK `iterate…` helper stop, or throw, on a repeated cursor.

### Cursors are opaque

A client treats a cursor as an opaque string, never parses it, never builds one and never stores it across a contract change. Cursors are URL-safe (base64url or a delimited token of URL-safe characters) and bounded in length (512 characters is the ceiling). Its contents are not a promise: a server may change the encoding, and must keep decoding every form it has already handed out for as long as clients may hold one.

A malformed cursor, or one that belongs to another list, is `bad_request` with `details.field = "cursor"`. Each list documents whether an unusable cursor is a 400 or restarts at page one; the default is 400, and restarting is only correct where the anchor can legitimately disappear (a deleted row), in which case the first page is the honest answer.

### Keyset cursors: the default for time-ordered lists

A list ordered by time, or by any column that changes under writes, pages with a keyset: the cursor carries the sort key of the last row served, and the next page is the rows strictly after it.

- **Order on a total key.** The ordering is the sort column followed by a unique tiebreaker (almost always the primary key): `ORDER BY created_at DESC, id DESC`. A timestamp alone is not unique (rows written in one transaction share an instant), so a cursor holding only a timestamp skips or repeats rows at the boundary.
- **Compare as a row.** Continue with `(created_at, id) < (:anchor_created_at, :anchor_id)`, not `created_at < x OR (created_at = x AND id < y)`. Over NOT NULL columns the two are equal, but only the row form is a single index range on a `(created_at, id)` index.
- **Match the index, including NULLS placement.** The `ORDER BY` and the keyset must use the same direction on both columns, and the NULLS placement of the `ORDER BY` must match the index's, or the planner sorts the whole match set instead of reading the index.
- **Keep the precision of the stored value.** A cursor that carries the timestamp at lower or higher precision than the column compares unequal to the row it came from and skips or repeats at the boundary. Carry the exact stored precision (Mention carries epoch milliseconds, which is what its columns store).
- **Flip the keyset with the direction.** A list a reader can reverse uses `>` for ascending and `<` for descending; a descending bound behind an ascending sort serves page one forever.
- **Fetch `limit + 1`.** The extra row decides `hasMore` and is never returned; `nextCursor` is built from the last returned row.
- **Bind the cursor to its list** (kind and normalized filters, see below) where the API serves several lists with one cursor format.
- **Ranked or relevance feeds** page with a keyset over their own score and a tiebreaker, and bind the cursor to the ranking version so a ranking change cannot resume a stale position.

#### Ids in a cursor must be live entity ids

The tiebreaker in a cursor is the row's own primary key, and a cursor is something the server minted. When it decodes one, the question is whether it is well-formed enough to become a keyset bound. In schemas built on `@oxy.so/db` that is `isLiveEntityId`: a legacy 24-character hex id or a UUID v7, the only place either shape is spelled out. Encoding with any other id is a programming error and throws; decoding a cursor whose id fails the check is a clean refusal, never a query with a garbage bound. Never widen it to "any string".

Never put anything but that row id in a cursor. Protocol keys, rkeys and AT URIs can be row ids in some tables, and an arbitrary external string is not a keyset bound; carry the row's own primary key and look the protocol value up through the row. `isLiveEntityId` is a boundary check that turns malformed input into a 400. It does not prove a row exists and is not a precondition for a lookup: the query already answers "no such row". The id-shape rule is in [Postgres and Drizzle](../postgres-and-drizzle.md).

Reference implementation: [Mention `packages/backend/src/utils/chronoCursor.ts`](https://github.com/OxyHQ/Mention/blob/main/packages/backend/src/utils/chronoCursor.ts). It is the one `(created_at, id)` cursor behind every chronological list: it encodes and strictly decodes the token (`encodeChronoCursor`, `decodeChronoCursor`), validates the id with `isLiveEntityId`, builds the row-comparison keyset (`chronoKeyset`) with the direction flipped for ascending lists, and keeps decoding the older token spellings clients may still hold. Its companion `chronoOrderBy` in [`mtn/feed/CursorBuilder.ts`](https://github.com/OxyHQ/Mention/blob/main/packages/backend/src/mtn/feed/CursorBuilder.ts) pairs the `ORDER BY` with the keyset. A list chooses its two columns and nothing else; new lists use this module instead of minting a token spelling of their own.

### Offset cursors: only for lists with no index to resume from

A list whose order is a computed or composed ordering that no single index can resume (a catalogue sorted by price, a collection's manual order) may use an offset cursor. The offset is an item count over a total order, so it is deterministic for unchanging data, and under concurrent writes it can shift the boundary by one; say so in the list's documentation.

- Encode a small versioned payload (`v`, the list kind, a fingerprint of kind and normalized filters, the offset) as base64url JSON.
- **Bind to the list.** The fingerprint is a digest of the kind, its scope and its normalized filters and sort. Replaying a cursor on another list or under other filters is `bad_request`. The page size is not in the fingerprint, so a caller may change `limit` between pages.
- **Bound the depth.** Offset cost grows with depth. A list ends at a documented maximum offset: the page that reaches it is cut short and carries `nextCursor: null`, and a cursor claiming a deeper offset is refused.
- Order by a total key (the ordering ends in the primary key) so pages neither overlap nor gap.

Reference implementation: [Mercaria `packages/backend/src/services/public-api/cursor.ts`](https://github.com/OxyHQ/Mercaria/blob/main/packages/backend/src/services/public-api/cursor.ts). A list that already pages by a keyset of its own can wrap that cursor in the same versioned, list-bound envelope.

## Parameters and values
- **Locale:** passed as `?locale=` with a canonical BCP 47 tag. `Accept-Language` is ignored, because a cached public response must not vary on it.
- **Timestamps:** ISO-8601 UTC strings.
- **IDs:** opaque strings, never parsed.
- **Coordinates:** `latitude` and `longitude` as WGS84 decimal degrees. A caller's precise location is transient request data: never persist it, log it or echo it.

## Cross-app references
- A product stores another product's resource as an **opaque ID with no foreign key**, and fetches current facts through that product's SDK. Copying the other product's facts into your own tables is not allowed.
- The one exception is a legally or historically frozen record, such as an order's pickup address. Freeze it at the moment it is needed and label it as a snapshot.
- Ownership of a business is an Oxy account, usually `kind=organization`. Products store its id as `oxyAccountId` and check membership with Oxy. They never keep a parallel member list.
- A user-facing edit to another product's data goes from the frontend straight to that product's API with the user's Oxy session (`aud=oxy-api`, one session per ADR 0029), and the receiving product authorizes it. Server-to-server writes wait for service-token audiences (OxyHQ/oxy#878).
