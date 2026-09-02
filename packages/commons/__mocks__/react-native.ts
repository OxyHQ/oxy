/**
 * Minimal React Native stub for the accounts test environment.
 *
 * Only the surfaces used by code under test are stubbed. We expose a mutable
 * `Platform.OS` so individual tests can flip between `web` / `ios` / `android`
 * to exercise platform-conditional branches.
 *
 * The primitive components (`View`, `Text`, `Pressable`, …) render to plain DOM
 * nodes so component tests can mount under `@testing-library/react` (jsdom) and
 * query by text / role. RN-specific props (`style`, `numberOfLines`, …) are
 * intentionally dropped; the queryable ones (`testID`, `accessibilityLabel`,
 * `accessibilityRole`, `onPress`) are forwarded to their DOM equivalents.
 */

import React from 'react';

type PlatformOS = 'ios' | 'android' | 'web' | 'windows' | 'macos';

interface StubProps {
  children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
  testID?: string;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  onPress?: () => void;
  disabled?: boolean;
}

interface TextInputStubProps extends StubProps {
  value?: string;
  placeholder?: string;
  onChangeText?: (value: string) => void;
}

function domProps(props: StubProps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (props.testID) out['data-testid'] = props.testID;
  if (props.accessibilityLabel) out['aria-label'] = props.accessibilityLabel;
  if (props.accessibilityRole) out.role = props.accessibilityRole;
  return out;
}

function resolveChildren(children: StubProps['children']): React.ReactNode {
  return typeof children === 'function' ? children({ pressed: false }) : children;
}

export const View = ({ children, ...rest }: StubProps): React.ReactElement =>
  React.createElement('div', domProps(rest), children as React.ReactNode);

export const Text = ({ children, ...rest }: StubProps): React.ReactElement =>
  React.createElement('span', domProps(rest), children as React.ReactNode);

export const ScrollView = ({ children, ...rest }: StubProps): React.ReactElement =>
  React.createElement('div', domProps(rest), children as React.ReactNode);

interface ImageStubProps extends StubProps {
  source?: { uri?: string } | number;
}

/**
 * Renders as an `<img>` carrying the resolved remote `uri`, so a test can assert
 * WHICH image a screen chose to display (e.g. that an app logo came from the
 * server-resolved record). Local `require()`d assets have no uri.
 */
export const Image = ({ source, ...rest }: ImageStubProps): React.ReactElement =>
  React.createElement('img', {
    ...domProps(rest),
    src: typeof source === 'object' && source !== null ? source.uri : undefined,
    alt: '',
  });

export const ActivityIndicator = (props: StubProps): React.ReactElement =>
  React.createElement('div', { role: 'progressbar', ...domProps(props) });

const pressable = (props: StubProps): React.ReactElement =>
  React.createElement(
    'button',
    {
      type: 'button',
      onClick: props.onPress,
      disabled: props.disabled,
      role: props.accessibilityRole ?? 'button',
      'aria-label': props.accessibilityLabel,
      'data-testid': props.testID,
    },
    resolveChildren(props.children),
  );

export const Pressable = pressable;
export const TouchableOpacity = pressable;
export const TouchableWithoutFeedback = pressable;

export const TextInput = ({
  value,
  placeholder,
  onChangeText,
  ...rest
}: TextInputStubProps): React.ReactElement =>
  React.createElement('input', {
    ...domProps(rest),
    value,
    placeholder,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      onChangeText?.(event.target.value),
  });

export const Platform: {
  OS: PlatformOS;
  select: <T>(obj: Partial<Record<PlatformOS | 'default' | 'native', T>>) => T | undefined;
  Version: number;
} = {
  OS: 'ios',
  select: (obj) => {
    const os = Platform.OS;
    if (os in obj) return obj[os];
    if (os !== 'web' && 'native' in obj) return obj.native;
    return obj.default;
  },
  Version: 17,
};

export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
  flatten: <T>(style: T): T => style,
  hairlineWidth: 1,
};

export const Dimensions = {
  get: () => ({ width: 375, height: 812 }),
  addEventListener: () => ({ remove: () => undefined }),
};

export const Linking = {
  openURL: async (_url: string): Promise<void> => undefined,
  openSettings: async (): Promise<void> => undefined,
};

export const AppState = {
  currentState: 'active',
  addEventListener: (
    _type: 'change',
    _listener: (state: 'active' | 'background' | 'inactive' | 'unknown' | 'extension') => void,
  ) => ({ remove: () => undefined }),
};

export const useColorScheme = (): 'light' | 'dark' => 'light';

export const I18nManager: {
  isRTL: boolean;
  allowRTL: (allowRTL: boolean) => void;
  forceRTL: (forceRTL: boolean) => void;
  getConstants: () => { isRTL: boolean; doLeftAndRightSwapInRTL: boolean };
} = {
  isRTL: false,
  allowRTL: () => undefined,
  forceRTL: () => undefined,
  getConstants: () => ({ isRTL: false, doLeftAndRightSwapInRTL: true }),
};
