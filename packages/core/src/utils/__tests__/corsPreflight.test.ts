import { requiresCorsPreflight } from '../corsPreflight';

describe('requiresCorsPreflight', () => {
  it('treats a GET with only Accept as simple', () => {
    expect(requiresCorsPreflight('GET', [['Accept', 'application/json']])).toBe(false);
    expect(requiresCorsPreflight('head', [])).toBe(false);
  });

  it('treats a POST with a safelisted content type as simple', () => {
    expect(requiresCorsPreflight('POST', [['Content-Type', 'text/plain;charset=UTF-8']])).toBe(
      false,
    );
    expect(
      requiresCorsPreflight('POST', [
        ['content-type', 'application/x-www-form-urlencoded;charset=UTF-8'],
      ]),
    ).toBe(false);
  });

  it('flags a JSON content type, even on a GET', () => {
    expect(requiresCorsPreflight('GET', [['Content-Type', 'application/json']])).toBe(true);
  });

  it('flags Authorization and any custom header', () => {
    expect(requiresCorsPreflight('GET', [['Authorization', 'Bearer t']])).toBe(true);
    expect(requiresCorsPreflight('GET', [['X-Oxy-Activity-Id', 'abc']])).toBe(true);
  });

  it('flags a non-safelisted method', () => {
    expect(requiresCorsPreflight('DELETE', [])).toBe(true);
    expect(requiresCorsPreflight('PATCH', [])).toBe(true);
  });
});
