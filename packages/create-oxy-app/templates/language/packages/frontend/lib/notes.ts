import { action, entity, list, source } from '@oxy.so/bloom-data';

/**
 * The example's data, in `@oxy.so/bloom-data`: records by id in memory, read
 * with field-level subscriptions (`useEntity`), lists filled by a source
 * (`useList`) and changed by actions. `OxyProvider` opens one store per
 * account, so these records live in the signed-in account's store.
 */

export type NoteCategory = 'idea' | 'task' | 'journal';

/** A note as the server sends it: plain JSON-shaped data, never mutated in place. */
export interface NoteRecord {
  id: string;
  title: string;
  body: string;
  category: NoteCategory;
  pinned: boolean;
  createdAt: number;
}

/** The categories a note can have, with their message keys (`lib/i18n.tsx`). */
export const CATEGORIES: readonly { value: NoteCategory; label: string }[] = [
  { value: 'idea', label: 'categories.idea' },
  { value: 'task', label: 'categories.task' },
  { value: 'journal', label: 'categories.journal' },
];

/** Notes by id. */
export const Note = entity<NoteRecord>('note', { id: (note) => note.id });

/** The notes in order, under one key (`all`). */
export const Notes = list('notes', { of: Note });

/**
 * A stand-in for your API, so the screens work with no backend. Replace each
 * read and write of `server` with a request (`oxyServices.createLinkedClient({
 * baseURL: API_URL })`); the screens do not change.
 */
let server: NoteRecord[] = [
  {
    id: 'welcome',
    title: 'Welcome to {{APP_NAME}}',
    body: 'These notes come from lib/notes.ts. Replace its stand-in server with your API.',
    category: 'idea',
    pinned: true,
    createdAt: 0,
  },
  {
    id: 'language',
    title: 'Written in the Bloom language',
    body: 'Views are functions; their look is a chain of modifiers whose values are Bloom tokens.',
    category: 'journal',
    pinned: false,
    createdAt: 0,
  },
];

/** Fills `Notes` (`useList(notes)`). A screen that mounts reads it again. */
export const notes = source(Notes, {
  key: () => 'all',
  load: async () => ({ items: server.slice() }),
});

/** Saves a new note, then shows it first in the list. */
export const addNote = action({
  key: (note: NoteRecord) => `note:${note.id}`,
  run: async (note: NoteRecord) => {
    server = [note, ...server];
    return note;
  },
  settle: (saved) => {
    Note.put(saved);
    Notes.prepend('all', [saved.id]);
  },
});

/**
 * Pins or unpins a note. The change shows at once (the optimistic layer) and
 * is dropped if the server refuses it. The arguments state the target, never
 * a toggle, so a call that reaches the server twice is still right.
 */
export const setPinned = action({
  key: (id: string, _pinned: boolean) => `pin:${id}`,
  optimistic: (id: string, pinned: boolean) => {
    Note.merge(id, { pinned });
  },
  run: async (id: string, pinned: boolean) => {
    server = server.map((note) => (note.id === id ? { ...note, pinned } : note));
  },
});

/** A new note's id. */
export function newNoteId(): string {
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
