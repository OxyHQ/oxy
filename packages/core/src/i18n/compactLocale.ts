import shared from './compactLocaleValues.generated';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

/** Reconstruct a complete independent dictionary from generated data. */
export function restoreCompactLocale(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value[0] === -1) return clone(value[1]);
    const index: unknown = value[0];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new Error('Invalid compact locale reference');
    }
    const literal: unknown = shared[index];
    if (typeof literal !== 'string') throw new Error('Invalid compact locale reference');
    return literal;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, restoreCompactLocale(child)]),
    );
  }
  return value;
}
