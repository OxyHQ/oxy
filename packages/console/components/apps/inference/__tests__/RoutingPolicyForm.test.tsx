import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RoutingProfile } from '@oxy.so/contracts';
import en from '@/lib/i18n/locales/en';
import type { RoutingPolicyControls } from '@/lib/routing-policy';
import { defaultRoutingPolicyControls } from '@/lib/routing-policy';
import { RoutingPolicyForm } from '../RoutingPolicyForm';

/**
 * The form is react-native + Bloom, which Jest here (ts-jest on jsdom) cannot
 * load. These stand-ins render the few props the assertions read as plain DOM, so
 * the test exercises the form's own logic: ladder order, the allowed list, the
 * default-outside-allowed guard and the save payload.
 */
type Children = { children?: ReactNode };

jest.mock('react-native', () => ({
  View: ({ children, role }: Children & { role?: string }) => <div role={role}>{children}</div>,
  Text: ({ children, role }: Children & { role?: string }) => <span role={role}>{children}</span>,
}));

jest.mock(
  '@oxy.so/bloom/button',
  () => ({
    Button: ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
    }: Children & { onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) => (
      <button type="button" onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>
        {children}
      </button>
    ),
  }),
  { virtual: true },
);

jest.mock(
  '@oxy.so/bloom/checkbox',
  () => ({
    Checkbox: ({
      nativeID,
      checked,
      onCheckedChange,
      label,
      description,
    }: {
      nativeID?: string;
      checked?: boolean;
      onCheckedChange?: (checked: boolean) => void;
      label?: string;
      description?: string;
    }) => (
      <label htmlFor={nativeID}>
        <input
          id={nativeID}
          type="checkbox"
          checked={checked}
          onChange={(event) => onCheckedChange?.(event.target.checked)}
        />
        {label}
        {description ? <span>{description}</span> : null}
      </label>
    ),
  }),
  { virtual: true },
);

jest.mock(
  '@oxy.so/bloom/chip',
  () => ({
    Chip: ({ children, onPress }: Children & { onPress?: () => void }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
  }),
  { virtual: true },
);

jest.mock(
  '@oxy.so/bloom/switch',
  () => ({
    Switch: ({
      checked,
      accessibilityLabel,
    }: {
      checked?: boolean;
      accessibilityLabel?: string;
    }) => <input type="checkbox" checked={checked} aria-label={accessibilityLabel} readOnly />,
  }),
  { virtual: true },
);

jest.mock('@oxy.so/bloom/icons/RiAddLine', () => ({ RiAddLine: () => null }), { virtual: true });
jest.mock('@oxy.so/bloom/icons/RiCloseLine', () => ({ RiCloseLine: () => null }), {
  virtual: true,
});

jest.mock(
  '@oxy.so/bloom/admonition',
  () => ({
    Admonition: ({ children }: Children) => <div>{children}</div>,
  }),
  { virtual: true },
);

jest.mock(
  '@oxy.so/bloom/field',
  () => ({
    Field: ({ children, error }: Children & { error?: string | null }) => (
      <div>
        {children}
        {error ? <span role="alert">{error}</span> : null}
      </div>
    ),
  }),
  { virtual: true },
);

jest.mock(
  '@oxy.so/bloom/grouped-section',
  () => ({
    GroupedSection: ({ children }: Children) => <section>{children}</section>,
    GroupedSectionItem: ({ rightElement }: { rightElement?: ReactNode }) => (
      <div>{rightElement}</div>
    ),
  }),
  { virtual: true },
);

jest.mock(
  '@oxy.so/bloom/select',
  () => {
    const Passthrough = ({ children }: Children) => <div>{children}</div>;
    return {
      Select: Passthrough,
      SelectContent: () => null,
      SelectIcon: () => null,
      SelectItem: Passthrough,
      SelectItemIndicator: () => null,
      SelectItemText: Passthrough,
      SelectTrigger: Passthrough,
      SelectValue: () => null,
    };
  },
  { virtual: true },
);

jest.mock('@oxy.so/bloom/text-field', () => ({ TextFieldInput: () => <input /> }), {
  virtual: true,
});

function lookup(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
  return typeof value === 'string' ? value : key;
}

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      Object.entries(vars ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        lookup(key),
      ),
  }),
}));

afterEach(cleanup);

function profile(slug: string): RoutingProfile {
  return {
    schemaVersion: 1,
    routingProfileId: `power-${slug}`,
    slug,
    displayName: slug.charAt(0).toUpperCase() + slug.slice(1),
    optimiseFor: 'price',
    candidates: [{ modelReference: 'publisher/model', priority: 0 }],
    isProductPreset: true,
    powerLevel: slug as RoutingProfile['powerLevel'],
  };
}

// Shuffled, as the API orders by slug; the form shows the contract's ladder.
const PROFILES = ['ultra', 'auto', 'pro', 'instant', 'xhigh', 'high', 'medium'].map(profile);

const SAVE = 'Save new version';

function renderForm(initial: Partial<RoutingPolicyControls> = {}) {
  const onSubmit = jest.fn();
  render(
    <RoutingPolicyForm
      initial={{ ...defaultRoutingPolicyControls(), ...initial }}
      submitLabel={SAVE}
      isPending={false}
      catalogue={[]}
      routingProfiles={PROFILES}
      onSubmit={onSubmit}
      onCancel={() => {}}
    />,
  );
  return { onSubmit };
}

function checkbox(routingProfileId: string): HTMLInputElement {
  return document.getElementById(`routing-allowed-${routingProfileId}`) as HTMLInputElement;
}

describe('RoutingPolicyForm — power levels', () => {
  it('offers every published level, in ladder order, unticked = unrestricted', () => {
    renderForm();

    const ids = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[id^="routing-allowed-"]'),
    ).map((input) => input.id.replace('routing-allowed-', ''));
    expect(ids).toEqual([
      'power-auto',
      'power-instant',
      'power-medium',
      'power-high',
      'power-xhigh',
      'power-pro',
      'power-ultra',
    ]);
    expect(screen.getByText(/Nothing ticked means unrestricted/)).toBeTruthy();
  });

  it('writes instant-only with instant as the default (Oxy Inbox)', () => {
    const { onSubmit } = renderForm({
      defaultTarget: { kind: 'routing_profile_id', routingProfileId: 'power-instant' },
    });

    fireEvent.click(checkbox('power-instant'));
    fireEvent.click(screen.getByRole('button', { name: SAVE }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const saved = onSubmit.mock.calls[0]?.[0] as RoutingPolicyControls;
    expect(saved.allowedRoutingProfileIds).toEqual(['power-instant']);
    expect(saved.defaultTarget).toEqual({
      kind: 'routing_profile_id',
      routingProfileId: 'power-instant',
    });
  });

  it('writes every level with auto as the default (Alia), in ladder order', () => {
    const { onSubmit } = renderForm({
      defaultTarget: { kind: 'routing_profile_id', routingProfileId: 'power-auto' },
    });

    for (const slug of ['ultra', 'instant', 'auto', 'medium', 'high', 'xhigh', 'pro']) {
      fireEvent.click(checkbox(`power-${slug}`));
    }
    fireEvent.click(screen.getByRole('button', { name: SAVE }));

    const saved = onSubmit.mock.calls[0]?.[0] as RoutingPolicyControls;
    expect(saved.allowedRoutingProfileIds).toEqual([
      'power-auto',
      'power-instant',
      'power-medium',
      'power-high',
      'power-xhigh',
      'power-pro',
      'power-ultra',
    ]);
  });

  it('refuses to save a default outside the allowed list, naming why', () => {
    const { onSubmit } = renderForm({
      defaultTarget: { kind: 'routing_profile_id', routingProfileId: 'power-auto' },
    });

    fireEvent.click(checkbox('power-instant'));
    expect(screen.getByRole('alert').textContent).toContain('not one of the allowed power levels');
    fireEvent.click(screen.getByRole('button', { name: SAVE }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('This policy cannot be saved yet')).toBeTruthy();
  });

  it('keeps a saved level that is not currently published', () => {
    const { onSubmit } = renderForm({
      allowedRoutingProfileIds: ['power-instant', 'power-legacy'],
    });

    expect(checkbox('power-legacy').checked).toBe(true);
    expect(screen.getByText(/Not currently published/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: SAVE }));

    const saved = onSubmit.mock.calls[0]?.[0] as RoutingPolicyControls;
    expect(saved.allowedRoutingProfileIds).toEqual(['power-instant', 'power-legacy']);
  });

  it('clears back to unrestricted', () => {
    const { onSubmit } = renderForm({ allowedRoutingProfileIds: ['power-instant'] });

    fireEvent.click(screen.getByRole('button', { name: 'Clear (allow every level)' }));
    fireEvent.click(screen.getByRole('button', { name: SAVE }));

    const saved = onSubmit.mock.calls[0]?.[0] as RoutingPolicyControls;
    expect(saved.allowedRoutingProfileIds).toEqual([]);
  });
});
