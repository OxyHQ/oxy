/**
 * Slash trimming without a regex. `/\/+$/` backtracks polynomially on a long
 * run of slashes (CodeQL js/polynomial-redos); a scan from the end is linear.
 */

/** `value` without its trailing `/`s. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/** `value` without its leading `/`s. */
export function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start++;
  return value.slice(start);
}
