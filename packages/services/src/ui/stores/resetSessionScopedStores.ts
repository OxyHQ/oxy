/**
 * Nothing is left to reset: follow state lives in each account's bloom-data
 * store (`data/follow.ts`), and a switch opens the next account's store rather
 * than clearing one. This empty function stays only until the infra step of
 * the bloom-data move removes its two callers (`OxyContext` and
 * `OxyHostedContext`, `handleSubjectChange`), then goes with them.
 */
export function resetSessionScopedStores(): void {}
