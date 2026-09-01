/**
 * System labels are constants, not rows in `labels`.
 *
 * The risk that comes with that: any code path that validates a label by
 * looking it up in the collection now rejects the eight built-in ones, because
 * they have no row to find. These tests pin the paths where that would be
 * user-visible.
 *
 * Covered:
 *   1. Applying a built-in label to a message succeeds without a row.
 *   2. A genuinely unknown label is still rejected.
 *   3. A built-in and a user-made label can be applied in the same call.
 */

const mockLabelFind = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageUpdateOne = jest.fn();

jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));
jest.mock('../../models/User', () => ({ __esModule: true, default: {} }));
jest.mock('../../models/Mailbox', () => ({ Mailbox: {} }));
jest.mock('../../models/Message', () => ({
  Message: {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
    updateOne: (...args: unknown[]) => mockMessageUpdateOne(...args),
  },
}));
jest.mock('../../models/Label', () => ({
  Label: { find: (...args: unknown[]) => mockLabelFind(...args) },
}));
jest.mock('../../models/Bundle', () => ({ Bundle: {} }));
jest.mock('../../models/Reminder', () => ({ Reminder: {} }));
jest.mock('../../models/Contact', () => ({ Contact: {} }));
jest.mock('../../models/EmailTemplate', () => ({ EmailTemplate: {} }));
jest.mock('../../models/EmailFilter', () => ({ EmailFilter: {} }));
jest.mock('../senderAvatar.service', () => ({ getAvatarPathsBatch: jest.fn() }));
jest.mock('../aiLabeling.service', () => ({ aiLabelingService: {} }));
jest.mock('../cardExtraction.service', () => ({ cardExtractionService: {} }));
jest.mock('../smtp.outbound', () => ({ __esModule: true, smtpOutbound: { send: jest.fn() }, default: {} }));
jest.mock('../push.service', () => ({ pushService: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { emailService } from '../email.service';

const USER_ID = '507f1f77bcf86cd799439011';
const MESSAGE_ID = '507f1f77bcf86cd799439012';

/** `Label.find(...).select(...).lean()` resolving to `rows`. */
function labelRows(rows: Array<{ name: string }>) {
  return { select: () => ({ lean: () => Promise.resolve(rows) }) };
}

/** `Message.findOne(...).select(...).lean()` / `.lean({virtuals})`. */
function messageDoc(doc: unknown) {
  return {
    select: () => ({ lean: () => Promise.resolve(doc) }),
    lean: () => Promise.resolve(doc),
  };
}

describe('emailService.updateMessageLabels — system labels have no row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageFindOne.mockReturnValue(messageDoc({ _id: MESSAGE_ID }));
    mockMessageUpdateOne.mockResolvedValue({});
    mockLabelFind.mockReturnValue(labelRows([]));
  });

  it('applies a built-in label without looking for a row', async () => {
    await expect(
      emailService.updateMessageLabels(USER_ID, MESSAGE_ID, ['Work'], []),
    ).resolves.toBeDefined();

    // No lookup at all: every name was a system label.
    expect(mockLabelFind).not.toHaveBeenCalled();
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: MESSAGE_ID }),
      { $addToSet: { labels: { $each: ['Work'] } } },
    );
  });

  it('still rejects a label that exists neither as a constant nor as a row', async () => {
    await expect(
      emailService.updateMessageLabels(USER_ID, MESSAGE_ID, ['Nonexistent'], []),
    ).rejects.toThrow(/Labels not found: Nonexistent/);

    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
  });

  it('accepts a built-in and a user-made label together, looking up only the latter', async () => {
    mockLabelFind.mockReturnValue(labelRows([{ name: 'Recipes' }]));

    await expect(
      emailService.updateMessageLabels(USER_ID, MESSAGE_ID, ['Work', 'Recipes'], []),
    ).resolves.toBeDefined();

    expect(mockLabelFind).toHaveBeenCalledWith(
      expect.objectContaining({ name: { $in: ['Recipes'] } }),
    );
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: MESSAGE_ID }),
      { $addToSet: { labels: { $each: ['Work', 'Recipes'] } } },
    );
  });
});
