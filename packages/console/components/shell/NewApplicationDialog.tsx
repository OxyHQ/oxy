import { create } from 'zustand';

import { CreateApplicationDialog } from '@/components/apps/CreateApplicationDialog';

const useNewApplicationState = create<{ open: boolean; setOpen: (open: boolean) => void }>()(
  (set) => ({ open: false, setOpen: (open) => set({ open }) }),
);

/** Open the create-application dialog from anywhere (the sidebar's tree). */
export function openNewApplication(): void {
  useNewApplicationState.getState().setOpen(true);
}

/** Mount ONCE inside the shell: the sidebar sits outside every page that could host the dialog. */
export function NewApplicationDialog() {
  const open = useNewApplicationState((state) => state.open);
  const setOpen = useNewApplicationState((state) => state.setOpen);
  return <CreateApplicationDialog open={open} onClose={() => setOpen(false)} />;
}
