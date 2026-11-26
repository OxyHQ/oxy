/**
 * The two shapes an entity id can have in a schema built on {@link generatedId}
 * (`columns.ts`).
 *
 * A primary key is `text` holding a legacy 24-char hex id for every row that
 * predates uuid ids, and a uuid v7 for every row created since. Both can be
 * live simultaneously and permanently — a legacy row keeps its 24-hex id
 * forever.
 *
 * ## This is for a 400, and nothing else
 *
 * A guard built on this predicate exists only to dodge a malformed-input
 * failure at a documented API boundary — never as a precondition on a query.
 * Using it to gate a lookup re-introduces a fail-open bug in a new costume: it
 * answers "no" for a perfectly valid id of a shape this predicate has not been
 * taught about yet, when the query itself already answers "no such row" for
 * free.
 *
 * A `uuid` column type is deliberately not used anywhere in a schema built on
 * these helpers, so this predicate is the ONLY place either shape is spelled
 * out.
 */

/** A legacy 24-character hex id, case-insensitive. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/**
 * RFC 9562 UUID version 7, as {@link uuidv7} in `columns.ts` emits it.
 *
 * The version nibble (`7`) and variant bits (`8`/`9`/`a`/`b`) are pinned rather
 * than accepting any UUID: nothing built on these helpers generates a v4, so a
 * v4 arriving on a route is a client error worth rejecting, not an id to look
 * up.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether `value` could name a row — i.e. it is one of the two id shapes a
 * schema built on these helpers actually stores.
 *
 * `true` is NOT "this row exists"; it is only "this is not obviously
 * malformed". The existence question is the query's to answer.
 */
export function isLiveEntityId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return OBJECT_ID_HEX.test(value) || UUID_V7.test(value);
}

/** The statuses a malformed entity-id route param may answer with. */
export type EntityIdParamStatus = 400 | 404;

export interface EntityIdParamOptions {
  /**
   * `400` (default): the id is malformed input (`bad_request`). `404`: the
   * route treats an id that cannot name a row exactly like one that names no
   * row (`not_found`) — pick it where the route already answers 404 for a
   * missing entity and must not tell the two apart.
   */
  status?: EntityIdParamStatus;
}

/** The slice of an Express request {@link entityIdParam} reads. */
interface ParamRequest {
  params: Record<string, string | string[] | undefined>;
}

/** The slice of an Express response {@link entityIdParam} writes. */
interface ParamResponse {
  status(code: number): { json(body: unknown): unknown };
}

const ENTITY_ID_PARAM_CODES: Record<EntityIdParamStatus, string> = {
  400: 'bad_request',
  404: 'not_found',
};

/**
 * Express middleware refusing a request whose route param(s) cannot name a row
 * (see {@link isLiveEntityId}), so a handler never repeats the guard by hand and
 * every route answers the same status and body:
 * `{ "error": { "code", "message" } }` (`docs/api-conventions.md#errors`).
 *
 * Express-typed structurally, so `@oxy.so/db` takes no `express` dependency.
 * It is only the boundary 400/404 described on {@link isLiveEntityId}; passing
 * never means the row exists. Usage: `router.get('/:id', entityIdParam('id'), handler)`.
 *
 * @param names - The param name, or names, to check (default `'id'`).
 */
export function entityIdParam(
  names: string | readonly string[] = 'id',
  options: EntityIdParamOptions = {},
): (req: ParamRequest, res: ParamResponse, next: () => void) => void {
  const list = typeof names === 'string' ? [names] : names;
  const status = options.status ?? 400;
  const code = ENTITY_ID_PARAM_CODES[status];
  return (req, res, next) => {
    for (const name of list) {
      if (!isLiveEntityId(req.params[name])) {
        res.status(status).json({ error: { code, message: `Invalid ${name}` } });
        return;
      }
    }
    next();
  };
}
