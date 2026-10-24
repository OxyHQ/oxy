/** Drizzle needs a nonempty tuple; Zod 4 exposes its enum values as an array.
 * Keep database CHECKs sourced from the contract without widening the column type.
 */
export function enumValues<Value extends string>(values: readonly Value[]): [Value, ...Value[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('A database enum requires at least one contract value');
  return [first, ...rest];
}
