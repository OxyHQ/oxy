import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
  constraintNameOf,
  describeDriverError,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  sqlStateOf,
} from '../pgErrors';

/** How drizzle presents a postgres.js failure: the real fields live on `cause`. */
function wrapped(code: string, constraintName: string): Error {
  const driver = new Error('duplicate key value violates unique constraint');
  Reflect.set(driver, 'code', code);
  Reflect.set(driver, 'constraint_name', constraintName);
  const wrapper = new Error('Failed query');
  Reflect.set(wrapper, 'cause', driver);
  return wrapper;
}

describe('pgErrors', () => {
  it('reads the SQLSTATE through the wrapper', () => {
    expect(sqlStateOf(wrapped(UNIQUE_VIOLATION, 'sessions_token_unique'))).toBe(UNIQUE_VIOLATION);
  });

  it('reads constraint_name, the wire field, not `constraint`', () => {
    expect(constraintNameOf(wrapped(UNIQUE_VIOLATION, 'sessions_token_unique')))
      .toBe('sessions_token_unique');
  });

  it('matches a unique violation only on the NAMED constraint when one is given', () => {
    const error = wrapped(UNIQUE_VIOLATION, 'sessions_token_unique');
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, 'sessions_token_unique')).toBe(true);
    expect(isUniqueViolation(error, 'some_other_unique')).toBe(false);
  });

  it('matches a foreign-key violation only on the NAMED constraint when one is given', () => {
    // Same SQLSTATE-then-constraint-name shape as isUniqueViolation, exercised
    // with its own code so a copy-paste that reuses UNIQUE_VIOLATION, or swaps
    // it with CHECK_VIOLATION, fails here rather than passing unnoticed.
    const error = wrapped(FOREIGN_KEY_VIOLATION, 'posts_author_fkey');
    expect(isForeignKeyViolation(error)).toBe(true);
    expect(isForeignKeyViolation(error, 'posts_author_fkey')).toBe(true);
    expect(isForeignKeyViolation(error, 'some_other_fkey')).toBe(false);
    // Cross-check against the sibling predicates: a foreign-key violation is
    // not also reported as a unique or check violation.
    expect(isUniqueViolation(error)).toBe(false);
    expect(isCheckViolation(error)).toBe(false);
  });

  it('matches a check violation only on the NAMED constraint when one is given', () => {
    const error = wrapped(CHECK_VIOLATION, 'posts_body_length_check');
    expect(isCheckViolation(error)).toBe(true);
    expect(isCheckViolation(error, 'posts_body_length_check')).toBe(true);
    expect(isCheckViolation(error, 'some_other_check')).toBe(false);
    expect(isUniqueViolation(error)).toBe(false);
    expect(isForeignKeyViolation(error)).toBe(false);
  });

  it('returns undefined rather than a wrong answer for a non-driver error', () => {
    expect(sqlStateOf(new Error('nope'))).toBeUndefined();
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
  });

  it('terminates on a cyclic cause chain instead of hanging inside a catch', () => {
    const a = new Error('a');
    const b = new Error('b');
    Reflect.set(a, 'cause', b);
    Reflect.set(b, 'cause', a);
    expect(sqlStateOf(a)).toBeUndefined();
  });

  it('describes a failure without publishing the statement or its parameters', () => {
    const error = wrapped(UNIQUE_VIOLATION, 'sessions_token_unique');
    Reflect.set(Reflect.get(error, 'cause') as object, 'query', 'insert into sessions ...');
    Reflect.set(Reflect.get(error, 'cause') as object, 'params', ['secret-token']);

    const described = describeDriverError(error);

    expect(described).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'sessions_token_unique',
      kind: 'Error',
    });
    expect(JSON.stringify(described)).not.toContain('secret-token');
  });
});
