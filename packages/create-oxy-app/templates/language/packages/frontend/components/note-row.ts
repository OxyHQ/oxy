import { useEntity } from '@oxy.so/bloom-data';
import { Icon, ListItem, view } from '@oxy.so/bloom-language';
import { navigate } from '@oxy.so/bloom-language/router';
import { RiBookOpenLine } from '@oxy.so/bloom/icons/RiBookOpenLine';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiLightbulbLine } from '@oxy.so/bloom/icons/RiLightbulbLine';
import { RiPushpinFill } from '@oxy.so/bloom/icons/RiPushpinFill';
import { Note, type NoteCategory } from '@/lib/notes';

const CATEGORY_ICONS = {
  idea: RiLightbulbLine,
  task: RiCheckboxCircleLine,
  journal: RiBookOpenLine,
} as const satisfies Record<NoteCategory, unknown>;

/**
 * One note in the list. It reads its record by id, so it re-renders only when
 * a field it reads changes (`title`, `body`, `category`, `pinned`), and a press
 * pushes the note's own screen.
 */
export const NoteRow = view(function NoteRow({ id }: { id: string }) {
  const note = useEntity(Note, id);
  if (!note) return null;
  return ListItem(note.title)
    .supporting(note.body)
    .supportingLines(1)
    .prefix(Icon(CATEGORY_ICONS[note.category]).foreground('muted'))
    .trailing(note.pinned ? Icon(RiPushpinFill).foreground('primary') : null)
    .onPress(navigate('/notes/[id]', { id }));
});
