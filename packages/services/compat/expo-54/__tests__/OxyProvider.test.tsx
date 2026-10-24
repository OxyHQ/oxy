import { act, useEffect } from 'react';
import { Platform, Text } from 'react-native';
import { OxyProvider, useAuth } from '@oxy.so/services';

type Seen = { resolved: boolean; authenticated: boolean };
type TestNode = { type: unknown; props: { testID?: string; children?: unknown } };
type TestRenderer = {
  root: { findAll(predicate: (node: TestNode) => boolean): TestNode[] };
  unmount(): void;
};

function Probe({ onAuth }: { onAuth: (seen: Seen) => void }) {
  const { isAuthResolved, isAuthenticated } = useAuth();
  useEffect(() => {
    onAuth({ resolved: isAuthResolved, authenticated: isAuthenticated });
  }, [isAuthResolved, isAuthenticated, onAuth]);
  return <Text testID="app-child">signed {isAuthenticated ? 'in' : 'out'}</Text>;
}

async function mount(element: React.ReactElement) {
  if (Platform.OS === 'web') {
    const { createRoot } = require('react-dom/client');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(element));
    return {
      text: () => container.textContent ?? '',
      unmount: () => act(() => root.unmount()),
    };
  }
  const renderer: {
    create(element: React.ReactElement): TestRenderer;
  } = require('react-test-renderer');
  let tree: TestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(element);
  });
  const rendered = tree as TestRenderer;
  return {
    text: () =>
      rendered.root
        .findAll((node) => node.props.testID === 'app-child' && typeof node.type === 'string')
        .map((node) => [node.props.children].flat().join(''))
        .join(''),
    unmount: () => act(() => rendered.unmount()),
  };
}

it(`mounts OxyProvider on ${Platform.OS} and cold boot settles signed out`, async () => {
  const seen: Seen[] = [];
  const view = await mount(
    <OxyProvider baseURL="http://127.0.0.1:9" clientId="oxy_dk_compat_probe">
      <Probe onAuth={(state) => seen.push(state)} />
    </OxyProvider>,
  );

  for (let i = 0; i < 100 && !seen.some((state) => state.resolved); i++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  }

  expect(seen.length).toBeGreaterThan(0);
  expect(seen.at(-1)).toEqual({ resolved: true, authenticated: false });
  expect(view.text()).toContain('signed out');
  await view.unmount();
});

if (Platform.OS === 'macos') {
  it('runs on react-native-macos without the modules macOS lacks', () => {
    expect(require('react-native/package.json').name).toBe('react-native-macos');
    const requested = (globalThis as { __absentNativeModulesRequested?: Set<string> })
      .__absentNativeModulesRequested;
    expect(requested?.size).toBeGreaterThan(0);
  });
}
