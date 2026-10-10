import type { GrantLimit } from './agency';

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(record).sort()) sorted[key] = canonicalValue(record[key]);
  return sorted;
}

/** Registry-compatible JSON: sorted keys, omitted undefined object properties. */
export function canonicalCapabilityJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function valuesAtPath(input: Record<string, unknown>, path: string): unknown[] {
  let current: unknown[] = [input];
  for (const segment of path.split('.')) {
    const next: unknown[] = [];
    for (const value of current) {
      const records = Array.isArray(value) ? value : [value];
      for (const record of records) {
        if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
        if (Object.prototype.hasOwnProperty.call(record, segment)) {
          next.push((record as Record<string, unknown>)[segment]);
        }
      }
    }
    if (next.length === 0) return [];
    current = next;
  }
  return current.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

/** Enforces the signed per-action bounds before a domain handler runs. */
export function inputSatisfiesCapabilityLimits(
  tool: string,
  input: Record<string, unknown>,
  limits: readonly GrantLimit[],
): boolean {
  for (const limit of limits) {
    if (limit.tool !== tool) return false;
    const actualValues = valuesAtPath(input, limit.key);
    if (actualValues.length === 0) return false;
    if (typeof limit.value === 'number') {
      const maximum = limit.value;
      if (
        !actualValues.every(
          (actual) => typeof actual === 'number' && Number.isFinite(actual) && actual <= maximum,
        )
      )
        return false;
      continue;
    }
    if (!actualValues.every((actual) => actual === limit.value)) return false;
  }
  return true;
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}
