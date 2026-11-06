/**
 * `req.params` for every route this API declares with named segments
 * (`/:id`), which is all of them but the recording-ingest wildcard.
 *
 * Express 5 always yields a named segment as a string. `@types/express` 5 can
 * only prove that when it infers the params from a route literal, so a handler
 * whose `req` is annotated (every `AuthRequest` handler, and every controller
 * mounted from another file) gets `string | string[]` for each key — the array
 * being what a wildcard (`/*path`) yields. The request types here are declared
 * with these params so a named segment reads as the string it is; a wildcard
 * route types its own.
 */
export type NamedRouteParams = Record<string, string>;
