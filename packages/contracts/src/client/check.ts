/**
 * Structural checks for contract values, without Zod.
 *
 * The Zod schemas in this package are the contract, and the API parses with
 * them. A client only needs to know that a response has the shape its type
 * promises, and Zod's object schemas pull Zod's whole runtime into every app
 * that bundles the SDK (~120 KB before compression, evaluated at startup). The
 * checks here give the client the same answers in plain TypeScript.
 *
 * Every check mirrors one Zod 3 schema in this package, and
 * `__tests__/clientChecks.parity.test.ts` runs both over the same inputs and
 * requires the same verdict, the same output and the same failing path. The
 * rules follow Zod 3 exactly:
 *
 *   string(...rules)      a string; `trim`/`toLowerCase` rewrite it, the other
 *                         rules test it, in the order given
 *   number(...rules)      a number that is not NaN (Infinity passes, as in Zod)
 *   literal(v) / oneOf    `===` one value / one of a fixed set of strings
 *   optional(c)           `undefined` (or an absent key) passes; `null` does not
 *   nullable(c)           `null` passes and is kept
 *   withDefault(c, v)     `undefined` becomes `v`, which is then checked
 *   array(c, ...rules)    the size rules first, then every element in order
 *   object(shape)         unknown keys are DROPPED (Zod's default "strip")
 *   strictObject(shape)   unknown keys FAIL (`.strict()`)
 *   looseObject(shape)    unknown keys are KEPT (`.passthrough()`)
 *   refine(c, test)       a further condition, run once `c` passes
 *   union / discriminatedUnion   as Zod 3 reports them
 *
 * A failure carries the first issue Zod would report and whether Zod would have
 * stopped there (`fatal`: the type was wrong) or kept checking (`fatal: false`:
 * only a rule failed). Only `union` reads the difference, because Zod reports a
 * union through its first "rule failed" option.
 *
 * This module, and everything under `src/client/`, must never import `zod`
 * (`__tests__/clientEntryGraph.test.ts` walks the graph).
 */

/** Where in the value a check failed. */
export type CheckPath = (string | number)[];

/** Zod 3's issue codes, for the ones these checks can report. */
export type CheckIssueCode =
  | 'invalid_type'
  | 'invalid_literal'
  | 'invalid_enum_value'
  | 'invalid_string'
  | 'too_small'
  | 'too_big'
  | 'unrecognized_keys'
  | 'invalid_union'
  | 'invalid_union_discriminator'
  | 'custom';

/**
 * The first problem found, in the order Zod reports its issues, with Zod's
 * code and message. `expected`/`received` name TYPES (`'number'`, `'string'`)
 * on an `invalid_type`, never values, so they are safe to log.
 */
export interface CheckIssue {
  path: CheckPath;
  code: CheckIssueCode;
  message: string;
  expected?: string;
  received?: string;
}

/** An issue before it knows where it happened. */
type Problem = Omit<CheckIssue, 'path'>;

export type CheckResult<T> =
  | { ok: true; value: T }
  | { ok: false; issue: CheckIssue; fatal: boolean };

/** Checks one value at `path`. */
export type Check<T> = (input: unknown, path: CheckPath) => CheckResult<T>;

/** The value type a check produces. */
export type CheckOutput<C> = C extends Check<infer T> ? T : never;

function ok<T>(value: T): CheckResult<T> {
  return { ok: true, value };
}

function fail(path: CheckPath, problem: Problem, fatal: boolean): CheckResult<never> {
  return { ok: false, issue: { path, ...problem }, fatal };
}

function describe(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'array';
  if (typeof input === 'number' && Number.isNaN(input)) return 'nan';
  return typeof input;
}

/** Zod's wording for a value of the wrong type. */
function wrongType(path: CheckPath, expected: string, input: unknown): CheckResult<never> {
  const received = describe(input);
  const message = input === undefined ? 'Required' : `Expected ${expected}, received ${received}`;
  return fail(path, { code: 'invalid_type', message, expected, received }, true);
}

/** `'a' | 'b'` — how Zod lists allowed values. */
function listValues(values: readonly unknown[], separator = ' | '): string {
  return values
    .map((value) => (typeof value === 'string' ? `'${value}'` : String(value)))
    .join(separator);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/* -------------------------------------------------------------------------- */
/*  Strings                                                                   */
/* -------------------------------------------------------------------------- */

/** One step of a string check: rewrite the value, or test it. */
export type StringRule =
  | { rewrite: (value: string) => string }
  | { test: (value: string) => boolean; code: CheckIssueCode; message: string };

export const trim: StringRule = { rewrite: (value) => value.trim() };
export const toLowerCase: StringRule = { rewrite: (value) => value.toLowerCase() };

export function minLength(min: number, message?: string): StringRule {
  return {
    test: (value) => value.length >= min,
    code: 'too_small',
    message: message ?? `String must contain at least ${min} character(s)`,
  };
}

export function maxLength(max: number, message?: string): StringRule {
  return {
    test: (value) => value.length <= max,
    code: 'too_big',
    message: message ?? `String must contain at most ${max} character(s)`,
  };
}

export function pattern(regex: RegExp, message?: string): StringRule {
  return {
    test: (value) => {
      regex.lastIndex = 0;
      return regex.test(value);
    },
    code: 'invalid_string',
    message: message ?? 'Invalid',
  };
}

export function startsWith(prefix: string): StringRule {
  return {
    test: (value) => value.startsWith(prefix),
    code: 'invalid_string',
    message: `Invalid input: must start with "${prefix}"`,
  };
}

/** Zod 3's `.email()`. */
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;
export const email: StringRule = pattern(EMAIL, 'Invalid email');

/** Zod 3's `.url()`: anything `new URL()` accepts. */
export const url: StringRule = {
  test: (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
  code: 'invalid_string',
  message: 'Invalid url',
};

/** Zod 3's `.datetime()`: ISO 8601 in UTC (`Z`), any sub-second precision, leap days checked. */
const DATETIME = new RegExp(
  '^((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))' +
    'T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?(Z)$',
);
export const datetime: StringRule = pattern(DATETIME, 'Invalid datetime');

export function string(...rules: StringRule[]): Check<string> {
  return (input, path) => {
    if (typeof input !== 'string') return wrongType(path, 'string', input);
    let value = input;
    let firstFailure: Problem | null = null;
    for (const rule of rules) {
      if ('rewrite' in rule) value = rule.rewrite(value);
      else if (firstFailure === null && !rule.test(value)) {
        firstFailure = { code: rule.code, message: rule.message };
      }
    }
    return firstFailure === null ? ok(value) : fail(path, firstFailure, false);
  };
}

/* -------------------------------------------------------------------------- */
/*  Numbers, booleans, literals                                               */
/* -------------------------------------------------------------------------- */

/** A test on a number; `undefined` when it passes, else Zod's issue. */
export type NumberRule = (value: number) => Problem | undefined;

/** Zod's `.int()` — reported, as Zod does, as an `invalid_type` that does not stop the parse. */
export const int: NumberRule = (value) =>
  Number.isInteger(value)
    ? undefined
    : {
        code: 'invalid_type',
        message: 'Expected integer, received float',
        expected: 'integer',
        received: 'float',
      };

export function atLeast(min: number): NumberRule {
  return (value) =>
    value >= min
      ? undefined
      : { code: 'too_small', message: `Number must be greater than or equal to ${min}` };
}

export function atMost(max: number): NumberRule {
  return (value) =>
    value <= max
      ? undefined
      : { code: 'too_big', message: `Number must be less than or equal to ${max}` };
}

/** Zod's `.positive()`. */
export const positive: NumberRule = (value) =>
  value > 0 ? undefined : { code: 'too_small', message: 'Number must be greater than 0' };
/** Zod's `.nonnegative()` (and `.min(0)`). */
export const nonnegative: NumberRule = atLeast(0);
/** Zod's `.safe()`: both bounds, low first. */
export const safe: NumberRule = (value) =>
  atLeast(Number.MIN_SAFE_INTEGER)(value) ?? atMost(Number.MAX_SAFE_INTEGER)(value);

export function number(...rules: NumberRule[]): Check<number> {
  return (input, path) => {
    if (typeof input !== 'number' || Number.isNaN(input)) return wrongType(path, 'number', input);
    for (const rule of rules) {
      const problem = rule(input);
      if (problem) return fail(path, problem, false);
    }
    return ok(input);
  };
}

export const boolean: Check<boolean> = (input, path) =>
  typeof input === 'boolean' ? ok(input) : wrongType(path, 'boolean', input);

export function literal<const T extends string | number | boolean>(expected: T): Check<T> {
  return (input, path) =>
    input === expected
      ? ok(expected)
      : fail(
          path,
          {
            code: 'invalid_literal',
            message: `Invalid literal value, expected ${JSON.stringify(expected)}`,
          },
          true,
        );
}

/** One of a fixed set of strings — Zod's `z.enum`. */
export function oneOf<const T extends readonly [string, ...string[]]>(values: T): Check<T[number]> {
  return (input, path) => {
    if (typeof input !== 'string') return wrongType(path, listValues(values), input);
    return values.includes(input)
      ? ok(input as T[number])
      : fail(
          path,
          {
            code: 'invalid_enum_value',
            message: `Invalid enum value. Expected ${listValues(values)}, received '${input}'`,
          },
          true,
        );
  };
}

/* -------------------------------------------------------------------------- */
/*  Wrappers                                                                  */
/* -------------------------------------------------------------------------- */

export function optional<T>(inner: Check<T>): Check<T | undefined> {
  return (input, path) => (input === undefined ? ok(undefined) : inner(input, path));
}

export function nullable<T>(inner: Check<T>): Check<T | null> {
  return (input, path) => (input === null ? ok(null) : inner(input, path));
}

export function withDefault<T>(inner: Check<T>, fallback: T): Check<T> {
  return (input, path) => inner(input === undefined ? fallback : input, path);
}

/** A further condition on a value `inner` accepted. */
export function refine<T>(inner: Check<T>, test: (value: T) => boolean, message: string): Check<T> {
  return (input, path) => {
    const checked = inner(input, path);
    if (!checked.ok) return checked;
    return test(checked.value) ? checked : fail(path, { code: 'custom', message }, false);
  };
}

/**
 * Zod's `.superRefine()` for the one-issue case: `test` returns the first
 * problem (its path relative to the value) or `undefined`.
 */
export function refineAt<T>(
  inner: Check<T>,
  test: (value: T) => { path: CheckPath; message: string } | undefined,
): Check<T> {
  return (input, path) => {
    const checked = inner(input, path);
    if (!checked.ok) return checked;
    const problem = test(checked.value);
    return problem
      ? fail([...path, ...problem.path], { code: 'custom', message: problem.message }, false)
      : checked;
  };
}

/** Narrows a checked value to a branded contract type (Zod's `.brand()`). */
export function branded<T extends B, B>(inner: Check<B>): Check<T> {
  return inner as Check<T>;
}

/**
 * The issues of a container, as Zod 3 orders them: the first one is reported,
 * and the container is fatal when any part of it was.
 */
class Failures {
  private first: CheckIssue | null;
  private fatal = false;

  constructor(first: CheckIssue | null) {
    this.first = first;
  }

  add(failure: { issue: CheckIssue; fatal: boolean }): void {
    this.first ??= failure.issue;
    this.fatal ||= failure.fatal;
  }

  result(): CheckResult<never> | null {
    return this.first ? { ok: false, issue: this.first, fatal: this.fatal } : null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Arrays                                                                    */
/* -------------------------------------------------------------------------- */

export interface ArrayRule {
  test: (length: number) => boolean;
  code: CheckIssueCode;
  message: string;
}

export function minItems(min: number): ArrayRule {
  return {
    test: (length) => length >= min,
    code: 'too_small',
    message: `Array must contain at least ${min} element(s)`,
  };
}

export function maxItems(max: number): ArrayRule {
  return {
    test: (length) => length <= max,
    code: 'too_big',
    message: `Array must contain at most ${max} element(s)`,
  };
}

/** Zod's `.length(n)`: `too_big` or `too_small`, by which side it missed. */
export function exactItems(count: number): ArrayRule[] {
  const message = `Array must contain exactly ${count} element(s)`;
  return [
    { test: (length) => length <= count, code: 'too_big', message },
    { test: (length) => length >= count, code: 'too_small', message },
  ];
}

export function array<T>(inner: Check<T>, ...rules: (ArrayRule | ArrayRule[])[]): Check<T[]> {
  const sizeRules = rules.flat();
  return (input, path) => {
    if (!Array.isArray(input)) return wrongType(path, 'array', input);
    // Zod reports the size before any element, then every element in order.
    const size = sizeRules.find((rule) => !rule.test(input.length));
    const failures = new Failures(size ? { path, code: size.code, message: size.message } : null);
    const out: T[] = [];
    for (let index = 0; index < input.length; index++) {
      const checked = inner(input[index], [...path, index]);
      if (checked.ok) out.push(checked.value);
      else failures.add(checked);
    }
    return failures.result() ?? ok(out);
  };
}

/* -------------------------------------------------------------------------- */
/*  Objects                                                                   */
/* -------------------------------------------------------------------------- */

/** One check per key. */
export type Shape = Record<string, Check<unknown>>;

type Flatten<T> = { [K in keyof T]: T[K] };
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: undefined extends CheckOutput<S[K]> ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

/** What Zod 3 infers for `z.object(shape)`: keys that admit `undefined` become optional. */
export type ShapeOutput<S extends Shape> = Flatten<
  { [K in RequiredKeys<S>]: CheckOutput<S[K]> } & { [K in OptionalKeys<S>]?: CheckOutput<S[K]> }
>;

type UnknownKeys = 'strip' | 'strict' | 'passthrough';

function objectWith<S extends Shape, T>(shape: S, unknownKeys: UnknownKeys): Check<T> {
  const keys = Object.keys(shape);
  return (input, path) => {
    if (!isRecord(input)) return wrongType(path, 'object', input);
    const failures = new Failures(null);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const checked = shape[key](input[key], [...path, key]);
      if (!checked.ok) failures.add(checked);
      // An optional key the input did not send stays absent rather than
      // appearing as `key: undefined` — what Zod does, and what `in` sees.
      else if (key !== '__proto__' && (checked.value !== undefined || key in input)) {
        out[key] = checked.value;
      }
    }
    if (unknownKeys !== 'strip') {
      const unknown: string[] = [];
      for (const key in input) {
        if (keys.includes(key)) continue;
        unknown.push(key);
        if (unknownKeys === 'passthrough' && key !== '__proto__' && input[key] !== undefined) {
          out[key] = input[key];
        }
      }
      if (unknownKeys === 'strict' && unknown.length > 0) {
        const message = `Unrecognized key(s) in object: ${listValues(unknown, ', ')}`;
        failures.add({ issue: { path, code: 'unrecognized_keys', message }, fatal: false });
      }
    }
    return failures.result() ?? ok(out as T);
  };
}

/** Unknown keys are dropped — Zod's `z.object(shape)`. */
export function object<S extends Shape>(shape: S): Check<ShapeOutput<S>> {
  return objectWith(shape, 'strip');
}

/** Unknown keys fail — Zod's `z.object(shape).strict()`. */
export function strictObject<S extends Shape>(shape: S): Check<ShapeOutput<S>> {
  return objectWith(shape, 'strict');
}

/** Unknown keys are kept as sent — Zod's `z.object(shape).passthrough()`. */
export function looseObject<S extends Shape>(
  shape: S,
): Check<Flatten<ShapeOutput<S> & { [key: string]: unknown }>> {
  return objectWith(shape, 'passthrough');
}

/** Any object, every value kept — Zod's `z.record(z.unknown())`. */
export const unknownRecord: Check<Record<string, unknown>> = (input, path) => {
  if (!isRecord(input)) return wrongType(path, 'object', input);
  const out: Record<string, unknown> = {};
  for (const key in input) if (key !== '__proto__') out[key] = input[key];
  return ok(out);
};

/* -------------------------------------------------------------------------- */
/*  Unions                                                                    */
/* -------------------------------------------------------------------------- */

/** The first option that passes; else Zod 3's report (the first option that only failed a rule). */
export function union<const C extends readonly Check<unknown>[]>(
  ...options: C
): Check<CheckOutput<C[number]>> {
  return (input, path) => {
    let ruleFailure: CheckResult<never> | null = null;
    for (const option of options) {
      const checked = option(input, path);
      if (checked.ok) return checked as CheckResult<CheckOutput<C[number]>>;
      if (!checked.fatal) ruleFailure ??= checked;
    }
    return ruleFailure ?? fail(path, { code: 'invalid_union', message: 'Invalid input' }, true);
  };
}

/** Zod 3's `z.discriminatedUnion(key, options)`, with the options keyed by their tag. */
export function discriminatedUnion<K extends string, M extends Record<string, Check<unknown>>>(
  key: K,
  options: M,
): Check<CheckOutput<M[keyof M]>> {
  return (input, path) => {
    if (!isRecord(input)) return wrongType(path, 'object', input);
    const tag = input[key];
    const option =
      typeof tag === 'string' && Object.prototype.hasOwnProperty.call(options, tag)
        ? options[tag]
        : undefined;
    if (!option) {
      const message = `Invalid discriminator value. Expected ${listValues(Object.keys(options))}`;
      return fail([...path, key], { code: 'invalid_union_discriminator', message }, true);
    }
    return option(input, path) as CheckResult<CheckOutput<M[keyof M]>>;
  };
}

/* -------------------------------------------------------------------------- */
/*  Using a check                                                             */
/* -------------------------------------------------------------------------- */

/** `a.b[0].c` — for messages. */
export function formatCheckPath(path: CheckPath): string {
  let out = '';
  for (const part of path) {
    out += typeof part === 'number' ? `[${part}]` : out ? `.${part}` : part;
  }
  return out || '(root)';
}

/**
 * A value did not have the shape its contract requires. Thrown where a Zod
 * schema's `.parse()` used to throw a `ZodError`; `issues` keeps that error's
 * issue shape (`code`, `path`, `message`), holding the first issue Zod reports.
 */
export class ContractCheckError extends Error {
  readonly issues: CheckIssue[];

  constructor(issue: CheckIssue, context?: string) {
    const where = formatCheckPath(issue.path);
    super(`${context ? `${context}: ` : ''}${where}: ${issue.message}`);
    this.name = 'ContractCheckError';
    this.issues = [issue];
    Object.setPrototypeOf(this, ContractCheckError.prototype);
  }
}

/** The checked value, or `null` — the twin of `safeParseContract`. */
export function checkContract<T>(check: Check<T>, input: unknown): T | null {
  const checked = check(input, []);
  return checked.ok ? checked.value : null;
}

/** The checked value; throws {@link ContractCheckError} — the twin of a schema's `.parse()`. */
export function parseContract<T>(check: Check<T>, input: unknown, context?: string): T {
  const checked = check(input, []);
  if (!checked.ok) throw new ContractCheckError(checked.issue, context);
  return checked.value;
}

/* -------------------------------------------------------------------------- */
/*  Tying a check to its contract type                                        */
/* -------------------------------------------------------------------------- */

/** `true` when `A` and `B` are the same type (not merely assignable either way). */
export type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

/**
 * `exact<DeviceSessionState>()(check)` compiles only when `check` produces
 * exactly `DeviceSessionState` — every key, every optional mark, every literal
 * — so a contract type that changes without its check is a type error here.
 */
export function exact<T>() {
  return <C extends Check<unknown>>(
    check: C &
      (Equal<CheckOutput<C>, T> extends true
        ? unknown
        : {
            mismatch: 'the check does not produce the contract type';
            check: CheckOutput<C>;
            contract: T;
          }),
  ): Check<T> => check as unknown as Check<T>;
}
