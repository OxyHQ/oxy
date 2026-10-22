/**
 * The canonical model-reference FORMS, as documentation placeholders.
 *
 * Every code sample in Console needs a `model` value, and there is no honest one
 * to write: the catalogue is empty (issue #972, workstream 5), and no routing
 * profile is published either. The four names that used to sit here —
 * `alia-lite`, `alia-v1`, `alia-v1-pro`, `alia-v1-pro-max` — were product tiers
 * wearing model names, and ADR 0008 retires them as identities rather than
 * renaming them, because an alias for a name that never identified a model
 * preserves the exact ambiguity being removed.
 *
 * So the samples carry the SHAPE and nothing else. `<publisher>/<model>` is not
 * a model id and cannot be mistaken for one, which is the point: a reader learns
 * the form, copies a runnable template, and gets the concrete value from the
 * Models page rather than from a string somebody invented for a screenshot.
 *
 * Defined once so that when the catalogue is seeded, one edit updates every
 * sample instead of twenty-eight — which is how the retired names spread across
 * five files in the first place.
 */

/** A model line, resolved to a revision by policy. */
export const MODEL_ID_PLACEHOLDER = '<publisher>/<model>';

/** An immutable pin: served exactly, or refused — never substituted. */
export const MODEL_REVISION_PLACEHOLDER = '<publisher>/<model>@<revision>';
