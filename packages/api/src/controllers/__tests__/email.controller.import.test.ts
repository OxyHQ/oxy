/**
 * `POST /email/import` — `req.files` must be narrowed, not cast.
 *
 * The handler used to bind `req.files as Express.Multer.File[] | undefined`.
 * Express types that property as `File[] | Record<string, File[]>`, and the
 * record arm is the one multer populates under `.fields()` / `.any()` — so the
 * cast erased a shape the type system was explicitly reporting. On a record,
 * `.length` is `undefined`: the emptiness guard passed and the `for…of` below
 * it threw a raw `TypeError: files is not iterable`, surfacing to the caller as
 * a 500 rather than the 400 this route means.
 *
 * The route mounts `.array()` today, so this is a guard against the route
 * changing out from under the handler — which is exactly the refactor that
 * would otherwise reintroduce it silently.
 */

const mockImportMessages = jest.fn();

jest.mock('../../services/email.service', () => ({
  emailService: {
    importMessages: (...args: unknown[]) => mockImportMessages(...args),
  },
}));
jest.mock('../../services/smtp.outbound', () => ({ smtpOutbound: {} }));
jest.mock('../../services/assetServiceSingleton', () => ({ assetService: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { importMessages } from '../email.controller';
import { BadRequestError } from '../../utils/error';

const USER_ID = randomUUID();

/** A single in-memory .eml upload, shaped as multer leaves it. */
function emlFile(originalname: string): Express.Multer.File {
  return {
    fieldname: 'files',
    originalname,
    encoding: '7bit',
    mimetype: 'message/rfc822',
    size: 4,
    buffer: Buffer.from('eml\n', 'utf8'),
  } as Express.Multer.File;
}

/** Run the handler over a given `req.files` value and capture the response. */
async function runImport(files: unknown): Promise<{ status: number; payload: unknown }> {
  let status = 200;
  let payload: unknown;
  const res = {
    status: (code: number) => { status = code; return res; },
    json: (body: unknown) => { payload = body; return res; },
  } as unknown as Response;

  const req = { user: { id: USER_ID }, files } as unknown as Parameters<typeof importMessages>[0];
  await importMessages(req, res);
  return { status, payload };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('importMessages req.files shape', () => {
  it('rejects multer\'s field-keyed record shape as a bad request, not an iteration crash', async () => {
    const files: Record<string, Express.Multer.File[]> = { files: [emlFile('one.eml')] };

    // BadRequestError, specifically. Without the narrowing this rejects too —
    // with a `TypeError: files is not iterable` out of the `for…of`, which the
    // error handler renders as a 500.
    await expect(runImport(files)).rejects.toBeInstanceOf(BadRequestError);
    await expect(runImport(files)).rejects.toThrow('At least one .eml file is required');
    expect(mockImportMessages).not.toHaveBeenCalled();
  });

  it('rejects a missing req.files', async () => {
    await expect(runImport(undefined)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockImportMessages).not.toHaveBeenCalled();
  });

  it('rejects an empty array', async () => {
    await expect(runImport([])).rejects.toBeInstanceOf(BadRequestError);
    expect(mockImportMessages).not.toHaveBeenCalled();
  });

  it('still imports the array shape multer\'s .array() actually assigns', async () => {
    mockImportMessages.mockResolvedValueOnce(2);

    // The vacuity floor: a guard that rejected every shape would satisfy every
    // assertion above.
    const { payload } = await runImport([emlFile('one.eml'), emlFile('two.eml')]);

    expect(mockImportMessages).toHaveBeenCalledTimes(1);
    expect(mockImportMessages).toHaveBeenCalledWith(USER_ID, [
      { buffer: expect.any(Buffer), originalname: 'one.eml' },
      { buffer: expect.any(Buffer), originalname: 'two.eml' },
    ]);
    expect(payload).toEqual({ data: { imported: 2, total: 2 } });
  });

  it('still rejects a non-.eml filename', async () => {
    await expect(runImport([emlFile('payload.exe')])).rejects.toBeInstanceOf(BadRequestError);
    expect(mockImportMessages).not.toHaveBeenCalled();
  });
});
