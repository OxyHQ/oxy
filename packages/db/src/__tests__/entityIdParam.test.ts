import { uuidv7 } from '../columns';
import { entityIdParam } from '../ids';

function run(
  middleware: ReturnType<typeof entityIdParam>,
  params: Record<string, string | undefined>,
) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const next = jest.fn();
  middleware({ params }, { status }, next);
  return { json, status, next };
}

describe('entityIdParam', () => {
  it('passes both live id shapes through', () => {
    for (const id of [uuidv7(), '507f1f77bcf86cd799439011']) {
      const { next, status } = run(entityIdParam(), { id });
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
    }
  });

  it('answers 400 bad_request by default and does not call next', () => {
    const { next, status, json } = run(entityIdParam(), { id: 'nope' });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: { code: 'bad_request', message: 'Invalid id' } });
  });

  it('answers 404 not_found when asked, and for a missing param', () => {
    const { status, json } = run(entityIdParam('postId', { status: 404 }), {});
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: { code: 'not_found', message: 'Invalid postId' } });
  });

  it('checks every named param', () => {
    const { status } = run(entityIdParam(['a', 'b']), { a: uuidv7(), b: 'x' });
    expect(status).toHaveBeenCalledWith(400);
  });
});
