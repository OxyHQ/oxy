import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Application, CallerAccess } from '@/hooks/use-applications';
import en from '@/lib/i18n/locales/en';
import { CredentialAccessSettings } from '../CredentialAccessSettings';
import { CreateCredentialDialog } from '../CreateCredentialDialog';
import { GeneralForm } from '../GeneralForm';

type Children = { children?: ReactNode };
const mockUpdate = jest.fn();
const mockCreate = jest.fn();
// DOM stand-ins for Bloom/React Native exercise actual form state and API payloads.
jest.mock('react-native', () => ({ View: ({ children }: Children) => <div>{children}</div> }));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ oxyServices: {} }) }), {
  virtual: true,
});
jest.mock('@/hooks/use-applications', () => ({
  useUpdateApplication: () => ({ mutateAsync: mockUpdate, isPending: false }),
  useCreateCredential: () => ({ mutateAsync: mockCreate, isPending: false }),
}));
jest.mock(
  '@oxy.so/bloom/card',
  () => {
    const Box = ({ children }: Children) => <div>{children}</div>;
    return { Card: Box, CardBody: Box, CardDescription: Box, CardHeader: Box, CardTitle: Box };
  },
  { virtual: true },
);
jest.mock(
  '@oxy.so/bloom/button',
  () => ({
    Button: ({
      children,
      onPress,
      disabled,
    }: Children & { onPress?: () => void; disabled?: boolean }) => (
      <button type="button" disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
  }),
  { virtual: true },
);
jest.mock(
  '@oxy.so/bloom/field',
  () => ({ Field: ({ children }: Children) => <div>{children}</div> }),
  { virtual: true },
);
jest.mock(
  '@oxy.so/bloom/admonition',
  () => ({ Admonition: ({ children }: Children) => <div>{children}</div> }),
  { virtual: true },
);
jest.mock(
  '@oxy.so/bloom/typography',
  () => ({ Text: ({ children }: Children) => <span>{children}</span> }),
  { virtual: true },
);
jest.mock(
  '@oxy.so/bloom/text-field',
  () => ({
    TextFieldInput: ({
      label,
      value,
      onChangeText,
      disabled,
    }: {
      label: string;
      value: string;
      onChangeText: (value: string) => void;
      disabled?: boolean;
    }) => (
      <input
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChangeText(event.target.value)}
      />
    ),
  }),
  { virtual: true },
);
jest.mock('@oxy.so/bloom/textarea', () => ({ Textarea: () => null }), { virtual: true });
jest.mock('@oxy.so/bloom/tag-field', () => ({ TagField: () => null }), { virtual: true });
jest.mock('@oxy.so/bloom/icons/RiDeleteBinLine', () => ({ RiDeleteBinLine: () => null }), {
  virtual: true,
});
jest.mock('@oxy.so/bloom/icons/RiFileCopyLine', () => ({ RiFileCopyLine: () => null }), {
  virtual: true,
});
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }), {
  virtual: true,
});
jest.mock(
  '@oxy.so/bloom/grouped-section',
  () => ({
    GroupedSection: ({
      children,
      title,
      footer,
    }: Children & { title?: string; footer?: string }) => (
      <section>
        <h2>{title}</h2>
        {children}
        <p>{footer}</p>
      </section>
    ),
    GroupedSectionItem: ({ title, rightElement }: { title: string; rightElement?: ReactNode }) => (
      <div>
        {title}
        {rightElement}
      </div>
    ),
  }),
  { virtual: true },
);
jest.mock(
  '@oxy.so/bloom/switch',
  () => ({
    Switch: ({
      checked,
      disabled,
      onCheckedChange,
      accessibilityLabel,
    }: {
      checked: boolean;
      disabled?: boolean;
      onCheckedChange: (value: boolean) => void;
      accessibilityLabel: string;
    }) => (
      <input
        type="checkbox"
        aria-label={accessibilityLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  }),
  { virtual: true },
);
jest.mock(
  '@oxy.so/bloom/radio',
  () => ({
    RadioGroup: ({
      label,
      value,
      onValueChange,
      options,
    }: {
      label: string;
      value: string;
      onValueChange: (value: string) => void;
      options: Array<{ value: string; label: string }>;
    }) => (
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  }),
  { virtual: true },
);
jest.mock(
  '@oxy.so/bloom/dialog',
  () => ({
    Dialog: ({
      children,
      open,
      actions,
    }: Children & {
      open: boolean;
      actions: Array<{ label: string; disabled?: boolean; onPress?: () => void }>;
    }) =>
      open ? (
        <div>
          {children}
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              onClick={action.onPress}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null,
  }),
  { virtual: true },
);
jest.mock('../LogoField', () => ({ LogoField: () => null }));
jest.mock('../DeleteApplicationDialog', () => ({ DeleteApplicationDialog: () => null }));
jest.mock('../ApplicationStatusBadge', () => ({ ApplicationStatusBadge: () => null }));
jest.mock('@/lib/clipboard', () => ({ copyText: jest.fn() }));
jest.mock('@/lib/image-upload', () => ({
  stripSensitiveImageUrlQueryParams: (url: string) => url,
}));
jest.mock('@/lib/i18n', () => ({ useTranslation: () => ({ t: (key: string) => lookup(key) }) }));
function lookup(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
  return typeof value === 'string' ? value : key;
}
const application = {
  _id: 'own-app',
  name: 'Alia',
  type: 'first_party',
  isOfficial: true,
  isInternal: false,
  status: 'active',
  redirectUris: [],
  scopes: ['user:read', 'inference:invoke', 'payments:read'],
} as unknown as Application;
const external = {
  ...application,
  _id: 'external-app',
  type: 'third_party',
  isOfficial: false,
} as Application;
const access = { can: () => true } as unknown as CallerAccess;
const readonly = { can: () => false } as unknown as CallerAccess;
beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue(application);
  mockCreate.mockReset().mockResolvedValue({ credential: { _id: 'new' }, secret: null });
});
afterEach(cleanup);
function renderCreate(app: Application = application) {
  const props = { application: app, open: true, onClose: jest.fn(), onCreated: jest.fn() };
  const rendered = render(<CreateCredentialDialog {...props} />);
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'API caller' } });
  return { ...rendered, props };
}
function choose(type: string) {
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: type } });
}
function createButton() {
  return screen.getByRole('button', { name: 'Create credential' }) as HTMLButtonElement;
}

describe('workload identity and external credential boundaries', () => {
  it.each([application, external])('General never mutates scopes ($type)', async (app) => {
    render(<GeneralForm application={app} access={access} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      appId: app._id,
      data: { name: 'Renamed' },
    });
    expect(mockUpdate.mock.calls[0][0].data).not.toHaveProperty('scopes');
  });
  it('separates own workload audience from editable external ceiling and preserves partial grants', async () => {
    render(<CredentialAccessSettings application={application} access={access} />);
    expect(screen.getByText('Oxy backend identity')).toBeTruthy();
    expect(screen.getByText('oxy-service:own-app')).toBeTruthy();
    expect(screen.getByText('External API products')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('payments:write'));
    fireEvent.click(screen.getByRole('button', { name: 'Save external API products' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0][0]).toEqual({
      appId: 'own-app',
      data: {
        scopes: ['user:read', 'inference:invoke', 'payments:read', 'payments:write'],
      },
    });
  });
  it('does not offer workload identity to an external app and preserves account RBAC', () => {
    render(<CredentialAccessSettings application={external} access={readonly} />);
    expect(screen.queryByText('Oxy backend identity')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save external API products' })).toBeNull();
    for (const control of screen.getAllByRole('checkbox'))
      expect((control as HTMLInputElement).disabled).toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
  it.each(['service', 'machine'])(
    'requires explicit scopes on an official app %s credential',
    async (type) => {
      renderCreate();
      choose(type);
      expect(createButton().disabled).toBe(true);
      fireEvent.click(createButton());
      expect(mockCreate).not.toHaveBeenCalled();
      fireEvent.click(screen.getByLabelText('inference:invoke'));
      fireEvent.click(createButton());
      await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
      expect(mockCreate.mock.calls[0][0]).toEqual({
        appId: 'own-app',
        data: {
          name: 'API caller',
          type,
          environment: 'development',
          scopes: ['inference:invoke'],
        },
      });
    },
  );
  it('limits third-party service credentials to self-service scopes including app files', async () => {
    renderCreate({ ...external, scopes: ['inference:invoke', 'payments:read', 'files:app:write'] });
    choose('service');
    expect(screen.queryByLabelText('inference:invoke')).toBeNull();
    expect(screen.getByLabelText('payments:read')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('files:app:write'));
    fireEvent.click(createButton());
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0].data.scopes).toEqual(['files:app:write']);
  });
  it('clears selected scopes when changing credential type', () => {
    renderCreate();
    choose('machine');
    fireEvent.click(screen.getByLabelText('inference:invoke'));
    expect(createButton().disabled).toBe(false);
    choose('service');
    expect(createButton().disabled).toBe(true);
  });
  it('blocks stale scope selections after the application ceiling changes', () => {
    const { rerender, props } = renderCreate();
    choose('machine');
    fireEvent.click(screen.getByLabelText('inference:invoke'));
    rerender(<CreateCredentialDialog {...props} application={{ ...application, scopes: [] }} />);
    expect(createButton().disabled).toBe(true);
    fireEvent.click(createButton());
    expect(mockCreate).not.toHaveBeenCalled();
  });
  it.each(['public', 'confidential'])(
    'preserves %s OAuth registration without service scopes',
    async (type) => {
      renderCreate(external);
      choose(type);
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      fireEvent.click(createButton());
      await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
      expect(mockCreate.mock.calls[0][0].data).toEqual({
        name: 'API caller',
        type,
        environment: 'development',
      });
    },
  );
});
