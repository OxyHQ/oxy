import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useAction } from '@oxy.so/bloom-data';
import { Button, HStack, ScrollView, Spacer, Text } from '@oxy.so/bloom-language';
import { Field, Option, Picker, TextEditor, TextField, Toggle } from '@oxy.so/bloom-language/inputs';
import { screen } from '@oxy.so/bloom-language/router';
import { useTranslation } from '@/lib/i18n';
import { addNote, CATEGORIES, newNoteId, type NoteCategory } from '@/lib/notes';

/**
 * A form. Each input takes a binding, `[value, setValue]`, which is what
 * `useState` returns: the screen owns the values, the controls read and write
 * them.
 */
export default screen(function NewNoteScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const title = useState('');
  const body = useState('');
  const category = useState<NoteCategory | undefined>('idea');
  const pinned = useState(false);
  const save = useAction(addNote);
  const ready = title[0].trim().length > 0 && !save.isPending;

  const submit = async () => {
    await save.run({
      id: newNoteId(),
      title: title[0].trim(),
      body: body[0].trim(),
      category: category[0] ?? 'idea',
      pinned: pinned[0],
      createdAt: Date.now(),
    });
    title[1]('');
    body[1]('');
    pinned[1](false);
    router.navigate('/');
  };

  return ScrollView(
    Field(
      t('form.title'),
      TextField(title, t('form.title')).placeholder(t('form.titlePlaceholder')).submitLabel('next'),
    ).required(),
    TextEditor(body, t('form.body')).placeholder(t('form.bodyPlaceholder')).rows(4),
    Picker(
      category,
      CATEGORIES.map((option) => Option(option.value, t(option.label))),
    ).label(t('form.category')),
    HStack(Text(t('form.pinned')), Spacer(), Toggle(pinned).label(t('form.pinned'))).spacing('sm'),
    Button(Text(t('form.save')))
      .disabled(!ready)
      .loading(save.isPending)
      .onPress(() => void submit()),
  )
    .contentMargins('md')
    .spacing('md')
    .keyboardTaps('handled')
    .title(t('form.heading'));
});
