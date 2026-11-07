/**
 * Rotating a personal key strands every Peable coin received under it: the
 * wallet seed is derived from the identity key (`KeyManager.deriveScopedSeed`),
 * and after the rotation this device keeps only the new key (Peable ADR 0002).
 * So the confirm step, which both proof paths ("rotate with this device" and
 * "my device key is lost") end on, refuses to rotate until the person
 * acknowledges it, exactly as the organization flow does (ADR 0061 D7), and the
 * copy never claims the current phrase becomes useless.
 */
import type React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {},
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock('@/components/ui', () => {
  const R = require('react');
  const Box = ({ children, title }: { children?: React.ReactNode; title?: string }) =>
    R.createElement('div', null, title, children);
  return {
    Screen: Box,
    StackHeader: ({ title, subtitle }: { title: string; subtitle?: string }) =>
      R.createElement('div', null, title, subtitle),
    ImportantBanner: Box,
  };
});
jest.mock('@/lib/biometricAuth', () => ({
  authenticate: jest.fn(async () => ({ success: true })),
}));

const PENDING = { words: ['a'], privateKey: '11'.repeat(32), publicKey: `04${'aa'.repeat(64)}` };
const mockFlow = {
  proof: 'device' as 'device' | 'phrase',
  currentPhraseRef: { current: null as string | null },
  pendingIdentityRef: { current: null as typeof PENDING | null },
  reset: jest.fn(),
};
jest.mock('@/contexts/rotate-key-flow-context', () => ({
  useRotateKeyFlow: () => mockFlow,
}));

import { __setOxyState } from '@oxy.so/services';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import RotateKeyConfirmScreen from '@/app/(tabs)/(settings)/rotate-key/confirm';

const LOCALES_DIR = path.resolve(__dirname, '../../lib/i18n/locales');
const rotateKey = jest.fn(async () => ({ localPersistFailed: false }));

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <LocaleProvider>
        <RotateKeyConfirmScreen />
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFlow.pendingIdentityRef.current = PENDING;
  mockFlow.currentPhraseRef.current = null;
  __setOxyState({ oxyServices: { rotateKey } });
});

describe.each(['device', 'phrase'] as const)('rotating with proof %s', (proof) => {
  beforeEach(() => {
    mockFlow.proof = proof;
    if (proof === 'phrase') mockFlow.currentPhraseRef.current = 'current phrase words';
  });

  it('does not rotate until the funds acknowledgement is ticked', async () => {
    const { getByTestId, container } = renderScreen();

    expect(container.textContent).toContain('Your current key stays with your Peable funds');
    const commit = getByTestId('rotate-key-commit') as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    fireEvent.click(commit);
    expect(rotateKey).not.toHaveBeenCalled();

    fireEvent.click(getByTestId('rotate-key-funds-ack'));
    await waitFor(() =>
      expect((getByTestId('rotate-key-commit') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('rotate-key-commit'));

    await waitFor(() => expect(rotateKey).toHaveBeenCalledTimes(1));
    expect(rotateKey).toHaveBeenCalledWith(
      expect.objectContaining({ proof, pendingIdentity: PENDING }),
    );
  });
});

describe("a person who DELETED their encrypted backup (owner's decision, 2026-11-07)", () => {
  const backupStatus = jest.fn();

  beforeEach(() => {
    mockFlow.proof = 'device';
    backupStatus.mockResolvedValue({ exists: false, optedOut: true });
    __setOxyState({ oxyServices: { rotateKey, backupStatus } });
  });

  it('is told before the swap that there is no backup and only the phrase recovers the previous key', async () => {
    const { findByTestId, getByTestId, container } = renderScreen();
    await findByTestId('rotate-key-no-backup');
    expect(container.textContent).toContain('You have no encrypted backup');
    expect(container.textContent).toContain(
      'can be recovered only with its recovery phrase (your current one), so keep it',
    );
    // The opt-in choice, unticked.
    expect(getByTestId('rotate-key-create-backup')).toBeTruthy();
  });

  it('rotates without a backup unless they choose one', async () => {
    const { findByTestId, getByTestId } = renderScreen();
    await findByTestId('rotate-key-create-backup');
    fireEvent.click(getByTestId('rotate-key-funds-ack'));
    await waitFor(() =>
      expect((getByTestId('rotate-key-commit') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('rotate-key-commit'));
    await waitFor(() => expect(rotateKey).toHaveBeenCalledTimes(1));
    expect(rotateKey).toHaveBeenCalledWith(expect.objectContaining({ createBackup: false }));
  });

  it('their explicit choice is passed to the rotation', async () => {
    const { findByTestId, getByTestId } = renderScreen();
    fireEvent.click(await findByTestId('rotate-key-create-backup'));
    fireEvent.click(getByTestId('rotate-key-funds-ack'));
    await waitFor(() =>
      expect((getByTestId('rotate-key-commit') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('rotate-key-commit'));
    await waitFor(() => expect(rotateKey).toHaveBeenCalledTimes(1));
    expect(rotateKey).toHaveBeenCalledWith(expect.objectContaining({ createBackup: true }));
  });

  it('after the rotation, says again that the previous key is on this phone only', async () => {
    rotateKey.mockResolvedValueOnce({ localPersistFailed: false, backupOptedOut: true } as never);
    const { findByTestId, getByTestId, container } = renderScreen();
    await findByTestId('rotate-key-no-backup');
    fireEvent.click(getByTestId('rotate-key-funds-ack'));
    await waitFor(() =>
      expect((getByTestId('rotate-key-commit') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('rotate-key-commit'));
    await waitFor(() =>
      expect(container.textContent).toContain('Your previous key is on this phone only'),
    );
  });

  it('a person with none on record is shown the choice, ticked, and can decline it', async () => {
    backupStatus.mockResolvedValue({ exists: false });
    const { findByTestId, getByTestId, container } = renderScreen();
    await findByTestId('rotate-key-no-backup');
    expect(container.textContent).toContain('unless you untick it below');
    fireEvent.click(getByTestId('rotate-key-funds-ack'));
    await waitFor(() =>
      expect((getByTestId('rotate-key-commit') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('rotate-key-commit'));
    await waitFor(() => expect(rotateKey).toHaveBeenCalledTimes(1));
    expect(rotateKey).toHaveBeenLastCalledWith(expect.objectContaining({ createBackup: true }));
  });

  it('declining it (unticking) is passed to the rotation', async () => {
    backupStatus.mockResolvedValue({ exists: false });
    const { findByTestId, getByTestId } = renderScreen();
    fireEvent.click(await findByTestId('rotate-key-create-backup'));
    fireEvent.click(getByTestId('rotate-key-funds-ack'));
    await waitFor(() =>
      expect((getByTestId('rotate-key-commit') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('rotate-key-commit'));
    await waitFor(() => expect(rotateKey).toHaveBeenCalledTimes(1));
    expect(rotateKey).toHaveBeenLastCalledWith(expect.objectContaining({ createBackup: false }));
  });

  it('a person who has a backup sees neither the notice nor the choice', async () => {
    backupStatus.mockResolvedValue({ exists: true });
    const { queryByTestId, getByTestId } = renderScreen();
    await waitFor(() => expect(backupStatus).toHaveBeenCalled());
    expect(queryByTestId('rotate-key-no-backup')).toBeNull();
    expect(queryByTestId('rotate-key-create-backup')).toBeNull();
    fireEvent.click(getByTestId('rotate-key-funds-ack'));
    await waitFor(() =>
      expect((getByTestId('rotate-key-commit') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('rotate-key-commit'));
    await waitFor(() => expect(rotateKey).toHaveBeenCalledTimes(1));
    expect(rotateKey).toHaveBeenCalledWith(
      expect.not.objectContaining({ createBackup: expect.anything() }),
    );
  });
});

describe('rotation copy', () => {
  const load = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8')) as {
      rotateKey: { warning: string; confirm: Record<string, string> };
    };

  it('never tells the person the current phrase stops working', () => {
    const en = load('en.json');
    expect(en.rotateKey.warning).not.toMatch(/stop working/i);
    expect(en.rotateKey.warning).toMatch(/Peable/);
    expect(en.rotateKey.warning).toMatch(/keep your current phrase/i);
    const es = load('es.json');
    expect(es.rotateKey.warning).not.toMatch(/dejan de funcionar/i);
    expect(es.rotateKey.warning).toMatch(/Peable/);
  });

  it('says, in every locale, that without a backup only the phrase recovers a previous key', () => {
    for (const file of ['en.json', 'es.json']) {
      const { confirm } = load(file).rotateKey;
      for (const key of [
        'noBackupTitle',
        'noBackupBody',
        'noBackupOnRecordBody',
        'createBackup',
        'successNoBackup',
      ]) {
        expect(confirm[key]).toBeTruthy();
      }
      expect(confirm.noBackupBody).toMatch(/FairCoin/);
    }
  });

  it('says what is stranded and what to keep in every locale', () => {
    for (const file of ['en.json', 'es.json']) {
      const { confirm } = load(file).rotateKey;
      expect(confirm.fundsTitle).toMatch(/Peable/);
      expect(confirm.fundsBody).toMatch(/FairCoin/);
      expect(confirm.fundsConfirm).toBeTruthy();
    }
  });

  it('says the current key is kept for spending, and that a compromise means moving at once', () => {
    const en = load('en.json');
    expect(en.rotateKey.warning).toMatch(/previous key/i);
    expect(en.rotateKey.confirm.fundsBody).toMatch(/previous key/i);
    expect(en.rotateKey.confirm.fundsBody).toMatch(/compromised/i);
    for (const file of ['en.json', 'es.json']) {
      const { warning, confirm } = load(file).rotateKey;
      expect(`${warning} ${confirm.fundsBody}`).not.toMatch(/outside (this wallet|Peable)/i);
      expect(`${warning} ${confirm.fundsBody}`).not.toMatch(/keeps only the new key/i);
    }
  });
});
