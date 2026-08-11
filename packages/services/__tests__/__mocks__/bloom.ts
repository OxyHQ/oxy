/**
 * Lightweight stub for `@oxyhq/bloom` and its subpath exports.
 *
 * Only the symbols actually touched by code under test in the services
 * package are stubbed. Tests that need to assert on toast invocations
 * can spy on the exported `toast` object directly.
 */

import { createElement, Fragment, useState, type ReactNode } from 'react';

type ToastFn = (message: string, options?: Record<string, unknown>) => void;

/**
 * Minimal `@oxyhq/bloom/button` + `@oxyhq/bloom/loading` stubs. All bloom
 * subpaths map to this single file (see `jest.config.js` moduleNameMapper), so
 * components under test that render `<Button>` / `<Loading>` resolve here. The
 * Button forwards `children` (so queries by label work), `onPress` (mapped to
 * `onClick`), `disabled` (a disabled jsdom `<button>` never fires click — so a
 * `disabled` Button is un-pressable in tests), and `testID` (as `data-testid`);
 * other RN-only props are dropped so they do not leak onto the DOM node.
 */
export const Button = ({
  children,
  onPress,
  disabled,
  testID,
}: {
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
} & Record<string, unknown>) =>
  createElement(
    'button',
    { type: 'button', onClick: onPress, disabled, 'data-testid': testID },
    children,
  );

export const Loading = () => createElement('span', null, 'loading');

/**
 * `@oxyhq/bloom/collapsible` stub — Bloom's uncontrolled disclosure. Mirrors the
 * real behaviour the auth chooser's "Having trouble?" affordance depends on: the
 * trigger is always rendered, and the CHILDREN are mounted only while open (so a
 * test can assert an alternative is genuinely absent until disclosed). Starts
 * from `defaultOpen`, exactly like the real component.
 */
export const Collapsible = ({
  title,
  children,
  defaultOpen = false,
  testID,
}: {
  title?: string;
  children?: ReactNode;
  defaultOpen?: boolean;
  testID?: string;
} & Record<string, unknown>) => {
  const [open, setOpen] = useState(defaultOpen);
  return createElement(
    'div',
    { 'data-testid': testID },
    createElement(
      'button',
      { type: 'button', key: 'trigger', onClick: () => setOpen(!open) },
      title,
    ),
    open ? createElement(Fragment, { key: 'content' }, children) : null,
  );
};

/**
 * Minimal stubs for the Bloom primitives the account switchers render
 * (`@oxyhq/bloom/avatar`, `@oxyhq/bloom/typography`, `@oxyhq/bloom/divider`, and
 * the root `Dialog` / `useDialogControl`). All bloom subpaths map to this file,
 * so a component under test resolves these names here. `Avatar` renders no text
 * so it never collides with `getByText(displayName)` queries.
 */
export const Avatar = () => createElement('span', { 'aria-hidden': 'true' });

/**
 * `@oxyhq/bloom/avatar-group` stub — the account-menu facepile. The real group
 * renders overlapping avatars plus a `+N` overflow chip; here we only need a
 * queryable node per rendered member so a component under test can assert how
 * many it previews and what the overflow says.
 */
export const AvatarGroup = ({
  items,
  max = 5,
  testID,
}: {
  items?: Array<{ id?: string; displayName?: string }>;
  max?: number;
  testID?: string;
} & Record<string, unknown>) => {
  const list = items ?? [];
  const shown = list.slice(0, max);
  const overflow = list.length - shown.length;
  return createElement(
    'span',
    { 'data-testid': testID, 'aria-hidden': 'true' },
    shown.map((item, index) =>
      createElement('span', { key: item.id ?? index, 'data-facepile': item.displayName }),
    ),
    overflow > 0 ? createElement('span', { key: 'overflow' }, `+${overflow}`) : null,
  );
};

export const Text = ({
  children,
  testID,
}: { children?: ReactNode; testID?: string } & Record<string, unknown>) =>
  createElement('span', { 'data-testid': testID }, children);

export const Divider = () => createElement('hr', null);

/**
 * `@oxyhq/bloom/theme` per-account color-scope stubs used by `OxyAccountDialog`.
 *
 * The real `BloomColorScope` merges scoped CSS vars, which jsdom cannot show —
 * so the stub surfaces the preset it was handed as `data-color-preset`, the one
 * observable that says WHICH account's colour a row was scoped to. Style props
 * are unreachable here (the `react-native` stub drops `style` entirely), so this
 * attribute is the only way a per-row accent can be asserted at all.
 *
 * The registry carries the real preset NAMES and stand-in hexes. It was empty,
 * which made `toPreset` narrow everything to `undefined` and `resolveAccentHex`
 * answer the theme fallback for every account — so a suite could not have told
 * per-account theming from none, in either direction. The hex VALUES are not
 * Bloom's and nothing should assert them; all that matters is that a name
 * resolves and two names resolve differently.
 */
export const BloomColorScope = ({
  children,
  colorPreset,
}: { children?: ReactNode; colorPreset?: string }) =>
  createElement('div', { 'data-color-preset': colorPreset }, children);

export const APP_COLOR_NAMES: readonly string[] = [
  'teal',
  'blue',
  'green',
  'amber',
  'yellow',
  'red',
  'purple',
  'pink',
  'sky',
  'orange',
  'mint',
  'oxy',
  'faircoin',
];

export const APP_COLOR_PRESETS: Record<string, { hex: string }> = Object.fromEntries(
  APP_COLOR_NAMES.map((name, index) => [name, { hex: `#0000${(index + 16).toString(16)}` }]),
);

/**
 * `@oxyhq/bloom/dialog` `<Dialog>` stub. The real component renders its own
 * portal/backdrop chrome; here we only need the controlled `open` gate and the
 * `children` so a component under test (e.g. `OxyAccountDialog`) can be queried
 * for its content. Extra props (`placement`, `onClose`, `dismissOnBackdrop`, …)
 * are ignored.
 */
export const Dialog = ({
  open,
  children,
}: { open?: boolean; children?: ReactNode } & Record<string, unknown>) =>
  open === false ? null : createElement(Fragment, null, children);

export const useDialogControl = (): {
  open: () => void;
  close: () => void;
  isOpen: boolean;
} => ({
  open: jest.fn(),
  close: jest.fn(),
  isOpen: false,
});

export const toast: {
  (message: string, options?: Record<string, unknown>): void;
  success: ToastFn;
  error: ToastFn;
  info: ToastFn;
  warning: ToastFn;
  promise: ToastFn;
  dismiss: () => void;
} = Object.assign(
  jest.fn() as unknown as ToastFn,
  {
    success: jest.fn() as ToastFn,
    error: jest.fn() as ToastFn,
    info: jest.fn() as ToastFn,
    warning: jest.fn() as ToastFn,
    promise: jest.fn() as ToastFn,
    dismiss: jest.fn(),
  },
);

/**
 * Stub for `@oxyhq/bloom/theme`'s `useTheme`. Components under test
 * (`FollowButton`, etc.) only read `colors.*`; return the canonical key set so
 * any themed component renders without dragging in the real theme provider.
 */
export const useTheme = (): { isDark: boolean; colors: Record<string, string> } => ({
  isDark: false,
  colors: {
    primary: '#5e3bff',
    primaryForeground: '#ffffff',
    secondary: '#eeeeee',
    background: '#ffffff',
    backgroundSecondary: '#f5f5f5',
    backgroundTertiary: '#efefef',
    inputBackground: '#f5f5f5',
    text: '#000000',
    textSecondary: '#666666',
    card: '#ffffff',
    border: '#e0e0e0',
    icon: '#666666',
    success: '#22c55e',
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#3b82f6',
  },
});

/** Generic passthrough for Bloom layout primitives not asserted in unit tests. */
const passthrough =
  (tag: string) =>
  ({ children, testID }: { children?: ReactNode; testID?: string } & Record<string, unknown>) =>
    createElement(tag, { 'data-testid': testID }, children);

export const BloomDialogProvider = ({ children }: { children?: ReactNode }) =>
  createElement(Fragment, null, children);

/**
 * Renders an empty marker node rather than `null` so a test can COUNT the
 * outlets in a rendered tree. Both Bloom outlets read a module-level store, so
 * two of either would render every toast / every surface twice — the marker is
 * what lets `oxyProviderComposition.test.tsx` assert exactly one.
 */
export const ToastOutlet = () => createElement('div', { 'data-testid': 'bloom-toast-outlet' });

/**
 * `@oxyhq/bloom/surfaces` stubs. The real stack renders each presented surface as
 * a stacked `<Dialog>`; here we only need the module surface so the SDK's
 * `navigation/surfaces.ts` + `OxyProvider` resolve. `present` returns a
 * never-settling promise (unit tests do not await surface dismissals) and
 * `SurfaceHost` renders only a countable marker. The SDK's own surface behaviour
 * is covered by the browser-verification harness, not jsdom.
 */
export const SurfaceHost = () => createElement('div', { 'data-testid': 'bloom-surface-host' });

// Mirrors the real provider, which renders `[children, <SurfaceHost/>]`.
export const SurfaceProvider = ({ children }: { children?: ReactNode }) =>
  createElement(Fragment, null, children, createElement(SurfaceHost));

export const useSurface = (): { dismiss: (result?: unknown) => void; present: () => Promise<unknown> } => ({
  dismiss: () => {},
  present: () => new Promise<unknown>(() => {}),
});

// `jest.fn()`s rather than plain stubs: screens drive `confirm`/`prompt`
// outcomes per test (a confirmed vs. declined destructive action) and assert the
// options they were called with.
export const surfaces = {
  present: jest.fn(() => new Promise<unknown>(() => {})),
  dismiss: jest.fn(),
  dismissById: jest.fn(),
  dismissToRoot: jest.fn(),
  dismissAll: jest.fn(),
  confirm: jest.fn(() => Promise.resolve(false)),
  prompt: jest.fn(() => Promise.resolve(null)),
};

export const present = surfaces.present;
export const dismiss = surfaces.dismiss;
export const dismissById = surfaces.dismissById;
export const dismissToRoot = surfaces.dismissToRoot;
export const dismissAll = surfaces.dismissAll;
export const confirm = surfaces.confirm;
export const prompt = surfaces.prompt;

export const PressableScale = passthrough('div');

/**
 * `@oxyhq/bloom/settings-list` stubs. The real `SettingsListItem` renders a
 * Pressable (→ button role) carrying `title`/`description`/`value` as text, an
 * `icon` + `rightElement`, and an `accessibilityLabel` — the account switcher
 * queries rows by their display name (`getByText` / `getByRole('button', …)`)
 * and taps them, so the stub must forward those props rather than swallow them.
 * A `disabled` item renders a disabled `<button>` (un-clickable in jsdom).
 */
export const SettingsListGroup = ({
  title,
  children,
  testID,
}: { title?: string; children?: ReactNode; testID?: string } & Record<string, unknown>) =>
  createElement(
    'div',
    { 'data-testid': testID },
    title ? createElement('span', { key: 'group-title' }, title) : null,
    children,
  );

export const SettingsListItem = ({
  icon,
  title,
  description,
  value,
  rightElement,
  onPress,
  disabled,
  accessibilityLabel,
  expanded,
  testID,
}: {
  icon?: ReactNode;
  title?: string;
  description?: string;
  value?: string;
  rightElement?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  expanded?: boolean;
  testID?: string;
} & Record<string, unknown>) => {
  const body = [
    icon ? createElement(Fragment, { key: 'icon' }, icon) : null,
    createElement('span', { key: 'title' }, title),
    description ? createElement('span', { key: 'desc' }, description) : null,
    value ? createElement('span', { key: 'value' }, value) : null,
    rightElement ? createElement(Fragment, { key: 'right' }, rightElement) : null,
  ];
  const label = accessibilityLabel ?? title;
  if (onPress) {
    return createElement(
      'button',
      {
        type: 'button',
        'aria-label': label,
        'aria-expanded': expanded,
        onClick: onPress,
        disabled,
        'data-testid': testID,
      },
      body,
    );
  }
  return createElement('div', { 'aria-label': label, 'data-testid': testID }, body);
};

/**
 * `@oxyhq/bloom/composition-bar` stub. The real bar renders one sized block per
 * category; here we only need a queryable node per category so a component under
 * test (the account menu's storage meter) can assert its segments.
 */
export const CompositionBar = ({
  categories,
  testID,
}: {
  categories?: Array<{ key: string; name: string; amount: number; color: string }>;
  testID?: string;
} & Record<string, unknown>) =>
  createElement(
    'div',
    { 'data-testid': testID },
    (categories ?? [])
      .filter((category) => category.amount > 0)
      .map((category) =>
        createElement('span', {
          key: category.key,
          'data-segment': category.key,
          'data-amount': category.amount,
        }),
      ),
  );

/** `@oxyhq/bloom/settings-list` hairline between rows. */
export const SettingsListDivider = () => createElement('hr', { 'aria-hidden': 'true' });

export const Switch = ({
  value,
  onValueChange,
  testID,
}: {
  value?: boolean;
  onValueChange?: (next: boolean) => void;
  testID?: string;
} & Record<string, unknown>) =>
  createElement('input', {
    type: 'checkbox',
    role: 'switch',
    checked: value,
    onChange: () => onValueChange?.(!value),
    'data-testid': testID,
  });

export const TextField = passthrough('div');
export const TextFieldInput = passthrough('input');

export const H1 = Text;
export const H4 = Text;
export const H5 = Text;
export const H6 = Text;

export const Chip = passthrough('span');
export const SearchInput = passthrough('input');
export const IconCircle = passthrough('span');
export const BenefitList = passthrough('div');
export const BenefitRow = passthrough('div');
export const Accordion = passthrough('div');
export const AccordionItem = passthrough('div');
export const AccordionTrigger = passthrough('button');
export const AccordionContent = passthrough('div');
export const SegmentedControl = passthrough('div');
export const SegmentedControlItem = passthrough('button');

/**
 * `@oxyhq/bloom/admonition` stubs — the compound inline-notice primitives. The
 * text must stay queryable (a denied-permission notice is asserted by its copy)
 * and `AdmonitionButton` must stay pressable, so both forward their props
 * instead of rendering opaque nodes.
 */
export const AdmonitionRoot = passthrough('div');
export const AdmonitionRow = passthrough('div');
export const AdmonitionContent = passthrough('div');
export const AdmonitionIcon = () => createElement('span', { 'aria-hidden': 'true' });
export const AdmonitionText = ({ children }: { children?: ReactNode }) =>
  createElement('span', null, children);
export const AdmonitionButton = Button;
export const Admonition = ({ children }: { children?: ReactNode }) =>
  createElement('div', null, createElement('span', null, children));

export default toast;
