import { useLocalSearchParams } from 'expo-router';
import { useAction, useEntity } from '@oxy.so/bloom-data';
import { HStack, ScrollView, Spacer, Text } from '@oxy.so/bloom-language';
import { Toggle } from '@oxy.so/bloom-language/inputs';
import { screen } from '@oxy.so/bloom-language/router';
import { useBackWithFallback } from '@oxy.so/bloom/panel-routing/expo-router';
import { useTranslation } from '@/lib/i18n';
import { CATEGORIES, Note, setPinned } from '@/lib/notes';

/**
 * One note, pushed over the tabs. Its pinned switch is bound to the record and
 * an action: the switch moves at once, and moves back if the server refuses.
 */
export default screen(function NoteScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const note = useEntity(Note, id);
  const pin = useAction(setPinned);
  const back = useBackWithFallback('/');

  if (!note) {
    return ScrollView(Text(t('notes.missing')).foreground('muted'))
      .contentMargins('md')
      .title(t('notes.title'))
      .onBack(back);
  }

  const category = CATEGORIES.find((option) => option.value === note.category);
  return ScrollView(
    Text(note.body).font('body'),
    HStack(
      Text(t('form.pinned')),
      Spacer(),
      Toggle([note.pinned, (next) => void pin.run(note.id, next)]).label(t('form.pinned')),
    ).spacing('sm'),
  )
    .contentMargins('md')
    .spacing('lg')
    .title(note.title)
    .subtitle(category ? t(category.label) : '')
    .onBack(back);
});
