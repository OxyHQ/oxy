import type { ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { layout, Stack } from '@oxy.so/bloom-language/router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { router } from 'expo-router';
import { LocaleProvider } from '@/lib/i18n';
import NotesScreen from '../app/(app)/(tabs)/index';
import NewNoteScreen from '../app/(app)/(tabs)/new';
import NoteScreen from '../app/(app)/notes/[id]';

// The screens read only `logout` from the SDK. The session, and the gesture
// root it owns in the app, are OxyProvider's, which these tests do not mount.
jest.mock('@oxy.so/services', () => ({ useOxy: () => ({ logout: jest.fn() }) }));

function Providers({ children }: { children: ReactNode }) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <BloomProvider>
        <LocaleProvider>{children}</LocaleProvider>
      </BloomProvider>
    </GestureHandlerRootView>
  );
}

// The screens in a language stack, as the app's own layouts draw them.
const routes = {
  _layout: layout(() => Stack()),
  index: NotesScreen,
  new: NewNoteScreen,
  'notes/[id]': NoteScreen,
};

describe('notes', () => {
  test('the list shows the notes its source reads', async () => {
    await renderRouter(routes, { initialUrl: '/', wrapper: Providers });

    // A row is one control, named by its title.
    expect(await screen.findByLabelText('Welcome to {{APP_NAME}}')).toBeTruthy();
    expect(screen.getByLabelText('Written in the Bloom language')).toBeTruthy();
  });

  test('a note saved from the form joins the list', async () => {
    await renderRouter(routes, { initialUrl: '/new', wrapper: Providers });

    await fireEvent.changeText(await screen.findByLabelText('Title'), 'Groceries');
    await fireEvent.press(screen.getByText('Save note'));

    expect(screen).toHavePathname('/');
    expect(await screen.findByLabelText('Groceries')).toBeTruthy();
  });

  test('a note opens on its own screen', async () => {
    await renderRouter(routes, { initialUrl: '/', wrapper: Providers });
    await screen.findByLabelText('Welcome to {{APP_NAME}}');

    await act(() => router.push('/notes/welcome'));

    expect(await screen.findByText(/Replace its stand-in server with your API/)).toBeTruthy();
  });
});
