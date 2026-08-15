'use client';

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ArtificialIntelligence01Icon,
  ChartLineData02Icon,
  CreditCardIcon,
  Home01Icon,
  Key01Icon,
  Search01Icon,
  SourceCodeIcon,
} from '@hugeicons/core-free-icons';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const runCommand = useCallback((command: () => void) => {
    setOpen(false);
    command();
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3">
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/apps' }))}>
              <HugeiconsIcon icon={Add01Icon} />
              <span>Create New App</span>
              <CommandShortcut>⌘N</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/apps' }))}>
              <HugeiconsIcon icon={Key01Icon} />
              <span>Manage applications</span>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Navigation">
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/dashboard' }))}>
              <HugeiconsIcon icon={Home01Icon} />
              <span>Dashboard</span>
              <CommandShortcut>⌘D</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/apps' }))}>
              <HugeiconsIcon icon={Key01Icon} />
              <span>Applications</span>
              <CommandShortcut>⌘1</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/usage' }))}>
              <HugeiconsIcon icon={ChartLineData02Icon} />
              <span>Usage</span>
              <CommandShortcut>⌘2</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/billing' }))}>
              <HugeiconsIcon icon={CreditCardIcon} />
              <span>Billing</span>
              <CommandShortcut>⌘3</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/models' }))}>
              <HugeiconsIcon icon={ArtificialIntelligence01Icon} />
              <span>Models</span>
              <CommandShortcut>⌘4</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => navigate({ to: '/documentation' }))}>
              <HugeiconsIcon icon={SourceCodeIcon} />
              <span>Documentation</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

export function CommandMenuTrigger() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground bg-muted/50 border border-border rounded-md hover:bg-muted transition-colors"
      >
        <HugeiconsIcon icon={Search01Icon} size={14} />
        <span className="hidden sm:inline">Search...</span>
        <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandMenuContent onClose={() => setOpen(false)} />
      </CommandDialog>
    </>
  );
}

function CommandMenuContent({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();

  const runCommand = useCallback(
    (command: () => void) => {
      onClose();
      command();
    },
    [onClose]
  );

  return (
    <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3">
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => runCommand(() => navigate({ to: '/apps' }))}>
            <HugeiconsIcon icon={Add01Icon} />
            <span>Create New App</span>
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate({ to: '/apps' }))}>
            <HugeiconsIcon icon={Key01Icon} />
            <span>Manage applications</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Navigation">
          <CommandItem onSelect={() => runCommand(() => navigate({ to: '/dashboard' }))}>
            <HugeiconsIcon icon={Home01Icon} />
            <span>Dashboard</span>
            <CommandShortcut>⌘D</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate({ to: '/apps' }))}>
            <HugeiconsIcon icon={Key01Icon} />
            <span>Applications</span>
            <CommandShortcut>⌘1</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate({ to: '/usage' }))}>
            <HugeiconsIcon icon={ChartLineData02Icon} />
            <span>Usage</span>
            <CommandShortcut>⌘2</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate({ to: '/billing' }))}>
            <HugeiconsIcon icon={CreditCardIcon} />
            <span>Billing</span>
            <CommandShortcut>⌘3</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate({ to: '/models' }))}>
            <HugeiconsIcon icon={ArtificialIntelligence01Icon} />
            <span>Models</span>
            <CommandShortcut>⌘4</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate({ to: '/documentation' }))}>
            <HugeiconsIcon icon={SourceCodeIcon} />
            <span>Documentation</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
