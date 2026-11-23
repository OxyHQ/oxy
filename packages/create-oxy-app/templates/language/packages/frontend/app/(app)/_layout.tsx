import { AppLayout, Destination, layout, Stack } from '@oxy.so/bloom-language/router';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiStickyNoteLine } from '@oxy.so/bloom/icons/RiStickyNoteLine';
import { useTranslation } from '@/lib/i18n';

/**
 * The signed-in app: Bloom's AppShell around one stack. The tabs are its first
 * route, `(tabs)`, and a note is pushed over them, so Back returns to the tab
 * it was opened from. The destinations are the tabs: the system tab bar on
 * iOS, Bloom's bottom bar on Android (on the lens) and the web, and the
 * sidebar's rows on a wide screen.
 */
export default layout(function App() {
  const { t } = useTranslation();
  return AppLayout(Stack('(tabs)', 'notes/[id]')).destinations(
    Destination('index', '/').label(t('notes.title')).icon(RiStickyNoteLine).bar(true),
    Destination('new', '/new').label(t('notes.new')).icon(RiAddLine).bar(true),
  );
});
