/** Console settings are pages of Bloom's modal; Bloom owns navigation, scrolling and responsive chrome. */
import { useDialogControl } from '@oxy.so/bloom/dialog';
import { RiAccountCircleLine } from '@oxy.so/bloom/icons/RiAccountCircleLine';
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { SettingsModal } from '@oxy.so/bloom/settings-modal';
import { useOxy } from '@oxy.so/services/ui/client';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from '@/lib/i18n';
import { AccountSection } from './sections/AccountSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { AuditSection } from './sections/AuditSection';
import { LanguageSection } from './sections/LanguageSection';

export type ConsoleSettingsPage = 'account' | 'audit' | 'appearance' | 'language';

const SECTIONS = [
  { key: 'account', labelKey: 'settingsPage.tabs.account', icon: RiSettings3Line },
  { key: 'audit', labelKey: 'settingsPage.tabs.audit', icon: RiHistoryLine },
  { key: 'appearance', labelKey: 'settingsPage.appearance.title', icon: RiPaletteLine },
  { key: 'language', labelKey: 'settings.language.title', icon: RiEarthLine },
] as const satisfies ReadonlyArray<{ key: ConsoleSettingsPage; labelKey: string; icon: unknown }>;

const sectionContent: Record<ConsoleSettingsPage, ReactNode> = {
  account: <AccountSection />,
  audit: <AuditSection />,
  appearance: <AppearanceSection />,
  language: <LanguageSection />,
};

interface ConsoleSettingsValue {
  open: (page?: ConsoleSettingsPage) => void;
  close: () => void;
}

const SettingsContext = createContext<ConsoleSettingsValue | null>(null);

export function useConsoleSettings(): ConsoleSettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('Console settings must be used inside ConsoleSettingsProvider');
  return value;
}

export function ConsoleSettingsProvider({ children }: { children: ReactNode }) {
  const control = useDialogControl();
  const { showBottomSheet } = useOxy();
  const pendingAccount = useRef(false);
  const { t } = useTranslation();
  const [page, setPage] = useState<ConsoleSettingsPage>('account');
  const [request, setRequest] = useState<{
    sequence: number;
    initialView: 'navigation' | 'page';
  }>({ sequence: 0, initialView: 'navigation' });

  useEffect(() => {
    if (request.sequence) control.open();
  }, [request, control]);

  const open = useCallback((next?: ConsoleSettingsPage) => {
    setPage(next ?? 'account');
    setRequest((previous) => ({
      sequence: previous.sequence + 1,
      initialView: next ? 'page' : 'navigation',
    }));
  }, []);

  const close = useCallback(() => control.close(), [control]);

  const value = useMemo(() => ({ open, close }), [open, close]);

  const pages = useMemo(
    () =>
      Object.fromEntries(
        SECTIONS.map((section) => [
          section.key,
          { title: t(section.labelKey), content: sectionContent[section.key] },
        ]),
      ),
    [t],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
      <SettingsModal
        initialView={request.initialView}
        control={control}
        onClose={() => {
          if (pendingAccount.current) {
            pendingAccount.current = false;
            showBottomSheet?.('ManageAccount');
          }
        }}
        page={page}
        onPageChange={(next) => setPage(next as ConsoleSettingsPage)}
        pages={pages}
        groups={[
          {
            label: t('app.name'),
            items: SECTIONS.map((section) => ({
              key: section.key,
              label: t(section.labelKey),
              icon: section.icon,
              page: section.key,
            })),
          },
          {
            label: 'Oxy',
            items: [
              {
                key: 'oxy-account',
                label: t('settingsPage.manageOxyAccount'),
                icon: RiAccountCircleLine,
                onPress: () => {
                  pendingAccount.current = true;
                  control.close();
                },
              },
            ],
          },
        ]}
      />
    </SettingsContext.Provider>
  );
}
