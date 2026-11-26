import { useState } from 'react';
import { useList } from '@oxy.so/bloom-data';
import { Button, GlassGroup, HStack, Icon, ScrollView, Text, regular } from '@oxy.so/bloom-language';
import { navigate, screen } from '@oxy.so/bloom-language/router';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiLogoutBoxRLine } from '@oxy.so/bloom/icons/RiLogoutBoxRLine';
import { useOxy } from '@oxy.so/services';
import { NoteRow } from '@/components/note-row';
import { useTranslation } from '@/lib/i18n';
import { notes } from '@/lib/notes';

/**
 * The notes, from `@oxy.so/bloom-data`. The header's actions are glass: the
 * navigation layer, not the content. Adjacent glass shares one `GlassGroup`,
 * and only the primary action is tinted.
 */
export default screen(function NotesScreen() {
  const { t } = useTranslation();
  const { logout } = useOxy();
  const view = useList(notes);
  const [refreshing, setRefreshing] = useState(false);

  // A pull writes `true`; the list writes `false` once it has read again.
  const refresh = (pulled: boolean) => {
    if (!pulled) return;
    setRefreshing(true);
    void view.refresh().finally(() => setRefreshing(false));
  };

  return ScrollView(
    view.ids.length === 0 && !view.isLoading ? Text(t('notes.empty')).foreground('muted') : null,
    view.ids.map((id) => NoteRow({ id }).id(id)),
  )
    .contentMargins('horizontal', 'md')
    .spacing('xs')
    .refreshable([refreshing, refresh])
    .title(t('notes.title'))
    .toolbar(
      GlassGroup(
        HStack(
          Button(Icon(RiLogoutBoxRLine))
            .label(t('notes.signOut'))
            .glass()
            .onPress(() => void logout()),
          Button(Icon(RiAddLine))
            .label(t('notes.new'))
            .glass(regular.tint('primary'))
            .onPress(navigate('/new')),
        ).spacing('sm'),
      ),
    );
});
