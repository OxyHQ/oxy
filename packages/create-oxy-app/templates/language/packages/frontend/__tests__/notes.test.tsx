import type { ReactNode } from 'react';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { router } from 'expo-router';
import { LocaleProvider } from '@/lib/i18n';
import NotesScreen from '../app/(app)/(tabs)/index';
import NewNoteScreen from '../app/(app)/(tabs)/new';
import NoteScreen from '../app/(app)/notes/[id]';

// The screens read only `logout` from the SDK; the session itself is
// OxyProvider's, which these tests do not mount.
jest.mock('@oxy.so/services', () => ({ useOxy: () => ({ logout: jest.fn() }) }));

function Providers({ children }: { children: ReactNode }) {
  return (
    <BloomProvider>
      <LocaleProvider>{children}</LocaleProvider>
    </BloomProvider>
  );
}

const routes = { index: NotesScreen, new: NewNoteScreen, 'notes/[id]': NoteScreen };

describe('notes', () => {
  test('the list shows the notes its source reads', async () => {
    renderRouter(routes, { initialUrl: '/', wrapper: Providers });

    expect(await screen.findByText('Welcome to {{APP_NAME}}')).toBeTruthy();
    expect(screen.getByText('Written in the Bloom language')).toBeTruthy();
  });

  test('a note saved from the form joins the list', async () => {
    renderRouter(routes, { initialUrl: '/new', wrapper: Providers });

    fireEvent.changeText(await screen.findByLabelText('Title'), 'Groceries');
    await act(async () => {
      fireEvent.press(screen.getByText('Save note'));
    });

    expect(screen).toHavePathname('/');
    expect(await screen.findByText('Groceries')).toBeTruthy();
  });

  test('a note opens on its own screen', async () => {
    renderRouter(routes, { initialUrl: '/', wrapper: Providers });
    await screen.findByText('Welcome to {{APP_NAME}}');

    act(() => router.push('/notes/welcome'));

    expect(await screen.findByText(/Replace its stand-in server with your API/)).toBeTruthy();
  });
});
