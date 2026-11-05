import { z } from 'zod';

/** Integer validation does not add a safe-number ceiling unless the contract requests one. */
export function integerCheck(message?: string | { message?: string }) {
  const check = z.check<number>((context) => {
    if (Number.isInteger(context.value)) return;
    context.issues.push({
      code: 'invalid_type',
      expected: 'int',
      input: context.value,
      continue: true,
      ...(message ? { message: typeof message === 'string' ? message : message.message } : {}),
    });
  });
  check._zod.onattach.push((schema) => {
    schema._zod.bag.format = 'integer';
  });
  return check;
}

/** Existing `.safe()` contracts bound a number independently of integer validation. */
export function safeNumberCheck(message?: string | { message?: string }) {
  const check = z.check<number>((context) => {
    const common = {
      origin: 'number' as const,
      input: context.value,
      inclusive: true,
      continue: true,
      ...(message ? { message: typeof message === 'string' ? message : message.message } : {}),
    };
    if (context.value < Number.MIN_SAFE_INTEGER)
      context.issues.push({ ...common, code: 'too_small', minimum: Number.MIN_SAFE_INTEGER });
    if (context.value > Number.MAX_SAFE_INTEGER)
      context.issues.push({ ...common, code: 'too_big', maximum: Number.MAX_SAFE_INTEGER });
  });
  check._zod.onattach.push((schema) => {
    const bag = schema._zod.bag;
    bag.minimum = Math.max(
      typeof bag.minimum === 'number' ? bag.minimum : -Infinity,
      Number.MIN_SAFE_INTEGER,
    );
    bag.maximum = Math.min(
      typeof bag.maximum === 'number' ? bag.maximum : Infinity,
      Number.MAX_SAFE_INTEGER,
    );
  });
  return check;
}
