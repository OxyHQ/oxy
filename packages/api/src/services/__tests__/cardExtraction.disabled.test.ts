/** The disabled gate must stop before reading protected email content or inference. */

const mockGetDb = jest.fn(() => {
  throw new Error('database must not be touched while card extraction is disabled');
});
const mockExecuteInference = jest.fn();

jest.mock('../../config/email.config', () => ({
  CARD_EXTRACTION_CONFIG: { enabled: false },
}));
jest.mock('../../config/postgres', () => ({ getDb: () => mockGetDb() }));
jest.mock('@oxy.so/db', () => ({ qualified: jest.fn() }), { virtual: true });
jest.mock('../../db/schema/messages', () => ({
  MESSAGE_CARD_TYPES: ['trip', 'purchase', 'event', 'bill', 'package'],
  messages: {},
}));
jest.mock('../../db/schema/messageAttachments', () => ({ messageAttachments: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../inboxInference.service', () => ({
  executeInboxPointInference: (...args: unknown[]) => mockExecuteInference(...args),
  inboxCompletionText: jest.fn(),
}));

import { cardExtractionService } from '../cardExtraction.service';

it('does no work when explicit card extraction is disabled', async () => {
  await expect(cardExtractionService.extractAndUpdate('user-id', 'message-id')).resolves.toBeUndefined();
  expect(mockGetDb).not.toHaveBeenCalled();
  expect(mockExecuteInference).not.toHaveBeenCalled();
});
