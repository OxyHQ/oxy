import type React from 'react';
import { render } from '@testing-library/react';
import type { PublicCard } from '@oxyhq/contracts';
import { LocaleProvider } from '@/lib/i18n/locale-context';

interface MockAction {
  label: string;
  color?: string;
  loading?: boolean;
  disabled?: boolean;
  shouldCloseOnPress?: boolean;
  onPress?: () => void;
}

interface MockDialogProps {
  actions?: MockAction[];
  children?: React.ReactNode;
}

let mockDialogProps: MockDialogProps | null = null;
let mockDialogControl: { open: jest.Mock; close: jest.Mock } | null = null;
const mockRegenerate = jest.fn();
let mockAttestQrState = {
  state: 'error' as 'error' | 'loading' | 'ready',
  payload: null as string | null,
  exp: null as number | null,
  regenerate: mockRegenerate,
};

jest.mock('@oxyhq/bloom/dialog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  return {
    useDialogControl: () => {
      const controlRef = R.useRef<{ open: jest.Mock; close: jest.Mock } | null>(null);
      if (!controlRef.current) {
        controlRef.current = { open: jest.fn(), close: jest.fn() };
      }
      mockDialogControl = controlRef.current;
      return controlRef.current;
    },
    Dialog: (props: MockDialogProps) => {
      mockDialogProps = props;
      return R.createElement('div', null, props.children);
    },
  };
});

jest.mock('@/hooks/useAttestQr', () => ({
  useAttestQr: () => mockAttestQrState,
}));

jest.mock('react-native-qrcode-svg', () => () => null);

// Imported after the mocks so both sheets bind to the captured Dialog contract.
// eslint-disable-next-line import/first
import { AttestQrSheet } from '@/components/civic/AttestQrSheet';
// eslint-disable-next-line import/first
import { AttestReviewSheet } from '@/components/civic/AttestReviewSheet';

const CARD = {
  did: 'did:oxy:alice',
  name: 'Alice',
  username: 'alice',
  trustTier: 'new',
} as unknown as PublicCard;

function action(label: string): MockAction {
  const found = mockDialogProps?.actions?.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`Missing dialog action: ${label}`);
  return found;
}

describe('civic bottom-sheet action contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDialogProps = null;
    mockDialogControl = null;
    mockAttestQrState = {
      state: 'error',
      payload: null,
      exp: null,
      regenerate: mockRegenerate,
    };
  });

  it('puts QR regeneration in the Bloom Dialog action row', () => {
    render(
      <LocaleProvider>
        <AttestQrSheet onClose={jest.fn()} />
      </LocaleProvider>,
    );

    expect(mockDialogControl?.open).toHaveBeenCalledTimes(1);
    expect(mockDialogProps?.actions?.map(({ label }) => label)).toEqual([
      'Generate a new code',
    ]);
    expect(action('Generate a new code').shouldCloseOnPress).toBe(false);
  });

  it('puts review confirmation and cancellation in the Bloom Dialog action row', () => {
    render(
      <LocaleProvider>
        <AttestReviewSheet
          status="reviewing"
          card={CARD}
          verified
          subjectFailed={false}
          result={null}
          errorCode={null}
          onConfirm={jest.fn()}
          confirming
          onClose={jest.fn()}
        />
      </LocaleProvider>,
    );

    expect(mockDialogControl?.open).toHaveBeenCalledTimes(1);
    expect(mockDialogProps?.actions?.map(({ label }) => label)).toEqual([
      'Confirm we met',
      'Cancel',
    ]);
    expect(action('Confirm we met').loading).toBe(true);
    expect(action('Cancel').disabled).toBe(true);
    expect(action('Cancel').color).toBe('cancel');
  });

  it('uses the Dialog close action for terminal review errors', () => {
    render(
      <LocaleProvider>
        <AttestReviewSheet
          status="error"
          card={null}
          verified={false}
          subjectFailed={false}
          result={null}
          errorCode="generic"
          onConfirm={jest.fn()}
          onClose={jest.fn()}
        />
      </LocaleProvider>,
    );

    expect(mockDialogProps?.actions?.map(({ label }) => label)).toEqual(['Close']);
    expect(action('Close').color).toBe('cancel');
  });
});
