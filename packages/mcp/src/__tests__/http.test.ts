import { extractBearerToken } from '../http';

describe('MCP HTTP authorization', () => {
  it('accepts exactly one case-insensitive Bearer credential', () => {
    expect(extractBearerToken({ authorization: 'bearer token-value' }))
      .toBe('token-value');
    expect(extractBearerToken({ authorization: ['Bearer token-value'] }))
      .toBe('token-value');
  });

  it('rejects empty, ambiguous and duplicate credentials', () => {
    expect(extractBearerToken({ authorization: 'Bearer' })).toBeUndefined();
    expect(extractBearerToken({ authorization: 'Bearer one two' })).toBeUndefined();
    expect(extractBearerToken({ authorization: 'Bearer one, Bearer two' })).toBeUndefined();
    expect(extractBearerToken({ authorization: ['Bearer one', 'Bearer two'] }))
      .toBeUndefined();
  });
});
