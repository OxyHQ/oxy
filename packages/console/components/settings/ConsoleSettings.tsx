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
import { AccountPage } from '@/components/settings/pages/AccountPage';
import { AppearancePage } from '@/components/settings/pages/AppearancePage';
import { AuditPage } from '@/components/settings/pages/AuditPage';
import { LanguagePage } from '@/components/settings/pages/LanguagePage';
import { useTranslation } from '@/lib/i18n';

export type ConsoleSettingsPage = 'account' | 'audit' | 'appearance' | 'language';

const PAGES = [
  {
    key: 'account',
    labelKey: 'settingsPage.tabs.account',
    icon: RiSettings3Line,
    Page: AccountPage,
  },
  { key: 'audit', labelKey: 'settingsPage.tabs.audit', icon: RiHistoryLine, Page: AuditPage },
  {
    key: 'appearance',
    labelKey: 'settingsPage.appearance.title',
    icon: RiPaletteLine,
    Page: AppearancePage,
  },
  { key: 'language', labelKey: 'settings.language.title', icon: RiEarthLine, Page: LanguagePage },
] as const;

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
  const { t } = useTranslation();
  const control = useDialogControl();
  const { showBottomSheet } = useOxy();
  const pendingOxyAccount = useRef(false);
  const [page, setPage] = useState<ConsoleSettingsPage>('account');
  const [request, setRequest] = useState<{ sequence: number; initialView: 'navigation' | 'page' }>({
    sequence: 0,
    initialView: 'navigation',
  });

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

  return (
    <SettingsContext.Provider value={value}>
      {children}
      <SettingsModal
        control={control}
        initialView={request.initialView}
        page={page}
        onPageChange={(next) => setPage(next as ConsoleSettingsPage)}
        onClose={() => {
          // The Oxy account sheet opens once this dialog has finished closing.
          if (pendingOxyAccount.current) {
            pendingOxyAccount.current = false;
            showBottomSheet?.('ManageAccount');
          }
        }}
        labels={{ dialog: t('common.settings'), close: t('common.close'), back: t('common.back') }}
        pages={Object.fromEntries(
          PAGES.map(({ key, labelKey, Page }) => [key, { title: t(labelKey), content: <Page /> }]),
        )}
        groups={[
          {
            label: t('app.name'),
            items: PAGES.map(({ key, labelKey, icon }) => ({
              key,
              label: t(labelKey),
              icon,
              page: key,
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
                  pendingOxyAccount.current = true;
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
