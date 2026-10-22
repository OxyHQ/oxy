import { Command } from '@oxy.so/bloom/command';
import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Platform, Linking } from 'react-native';
import { create } from 'zustand';

import { useConsoleSettings } from '@/components/settings/ConsoleSettings';
import { useTranslation } from '@/lib/i18n';
import { buildCommandItems } from './command-menu-items';
import { openCreateWorkspace } from './CreateWorkspaceDialog';

interface CommandMenuState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const useCommandMenuState = create<CommandMenuState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Open the palette from anywhere (a sidebar search button, a header action). */
export function openCommandMenu(): void {
  useCommandMenuState.getState().setOpen(true);
}

/**
 * The Console's command palette (Bloom `Command`), opened with Cmd/Ctrl+K on web
 * or by `openCommandMenu()`. Mount ONCE inside the shell, e.g. as a sibling of the
 * routed content in `ConsoleShell`: it renders nothing until opened.
 */
export function CommandMenu() {
  const { t } = useTranslation();
  const router = useRouter();
  const { open: openSettings } = useConsoleSettings();
  const open = useCommandMenuState((state) => state.open);
  const setOpen = useCommandMenuState((state) => state.setOpen);

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        useCommandMenuState.getState().setOpen(!useCommandMenuState.getState().open);
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, []);

  const items = useMemo(
    () =>
      buildCommandItems(t, {
        navigate: (href) => router.navigate(href as never),
        openExternal: (url) => void Linking.openURL(url),
        openSettings: () => openSettings(),
        createWorkspace: openCreateWorkspace,
      }),
    [t, router, openSettings],
  );

  return (
    <Command
      open={open}
      onOpenChange={setOpen}
      items={items}
      placeholder={t('commandMenu.placeholder')}
      emptyText={t('commandMenu.empty')}
    />
  );
}
