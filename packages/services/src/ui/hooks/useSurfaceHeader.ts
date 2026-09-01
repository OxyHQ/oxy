import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { DialogHeaderConfig } from '@oxyhq/bloom/dialog';

/**
 * The header content a mounted surface screen contributes at runtime: its
 * (translated) title/subtitle and optional slot nodes. Back/close affordances
 * are owned by the surface host (`SurfaceScreen`) — a screen never wires them.
 *
 * Alongside the classic slots (`left`/`right`) a screen can declare the rich
 * design-system fields Bloom's nav header supports: the single trailing
 * `primaryAction` CTA (Upload / Save), a trailing icon `actions` row, a header
 * `search` / `segments` in the large-title zone, an `onImage` `tone` over media,
 * and a wizard `progress` bar.
 *
 * Only the NODE fields (`left`/`right`/`titleContent`, and an action's `icon`)
 * must be referentially stable — a node can only be compared by identity, so an
 * inline one thrashes the header. The rich OBJECT fields are compared by value
 * (see {@link surfaceHeaderContentEqual}), so an inline `primaryAction` /
 * `actions` / `search` / `segments` / `progress` is safe to pass.
 */
export type SurfaceHeaderContent = Pick<
  DialogHeaderConfig,
  | 'title'
  | 'titleContent'
  | 'subtitle'
  | 'largeTitle'
  | 'left'
  | 'right'
  | 'onBack'
  | 'primaryAction'
  | 'actions'
  | 'search'
  | 'segments'
  | 'tone'
  | 'progress'
>;

interface SurfaceHeaderContextValue {
  setContent: (content: SurfaceHeaderContent | null) => void;
}

/**
 * Provided by {@link ../components/SurfaceScreen}. Bridges a screen's runtime
 * header contribution up to the host, which merges it with the back/close
 * wiring and drives the Dialog's own nav header. `null` outside a surface (or in
 * a headerless surface), so {@link useSurfaceHeader} is a safe no-op there.
 */
export const SurfaceHeaderContext = createContext<SurfaceHeaderContextValue | null>(null);

type HeaderPrimaryAction = NonNullable<SurfaceHeaderContent['primaryAction']>;
type HeaderAction = NonNullable<SurfaceHeaderContent['actions']>[number];
type HeaderSearch = NonNullable<SurfaceHeaderContent['search']>;
type HeaderSegments = NonNullable<SurfaceHeaderContent['segments']>;
type HeaderProgress = NonNullable<SurfaceHeaderContent['progress']>;

function primaryActionEqual(
  a: HeaderPrimaryAction | undefined,
  b: HeaderPrimaryAction | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // `onPress` is a fresh closure each render — its identity never changes what
  // the button renders, so compare only the render-affecting scalars.
  return a.label === b.label && !!a.disabled === !!b.disabled && !!a.loading === !!b.loading;
}

function actionsEqual(a: HeaderAction[] | undefined, b: HeaderAction[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    // `icon` is a node (identity); `onPress` is ignored, like `primaryAction`'s.
    if (
      x.accessibilityLabel !== y.accessibilityLabel ||
      !!x.disabled !== !!y.disabled ||
      x.icon !== y.icon
    ) {
      return false;
    }
  }
  return true;
}

function searchEqual(a: HeaderSearch | undefined, b: HeaderSearch | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.value === b.value && a.placeholder === b.placeholder;
}

function segmentsEqual(a: HeaderSegments | undefined, b: HeaderSegments | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.value !== b.value || a.items.length !== b.items.length) return false;
  for (let i = 0; i < a.items.length; i += 1) {
    const x = a.items[i];
    const y = b.items[i];
    if (!x || !y || x.key !== y.key || x.label !== y.label) return false;
  }
  return true;
}

function progressEqual(a: HeaderProgress | undefined, b: HeaderProgress | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.step === b.step && a.total === b.total;
}

/**
 * Value-equality for a surface's header contribution.
 *
 * This MIRRORS Bloom's own `configsEqual` (`@oxyhq/bloom/dialog`), which guards
 * the header store one layer down — deliberately field for field. The two must
 * not diverge: this comparator is the gate that decides whether the host's
 * `setContent` fires, so a comparator STRICTER than Bloom's re-introduces the
 * update loop Bloom's own guard was written to prevent.
 *
 * Scalars (`title`/`subtitle`/`largeTitle`/`tone`) compare by value. The rich
 * object fields (`primaryAction`/`actions`/`search`/`segments`/`progress`)
 * compare by their render-affecting scalars, so a screen may build them inline:
 * a fresh object with unchanged contents is NOT a change. Only the node fields
 * (`titleContent`/`left`/`right`, and an action's `icon`) compare by identity —
 * there is nothing else to compare a `ReactNode` by — so those, and only those,
 * carry the memoize-me contract.
 *
 * Function-typed affordances compare by PRESENCE, never identity: `onBack`
 * legitimately gets a fresh closure each render and its identity never changes
 * what the header renders, so it must not count as a change (that is exactly
 * what would drive the update loop).
 */
function surfaceHeaderContentEqual(
  a: SurfaceHeaderContent | null,
  b: SurfaceHeaderContent | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.title === b.title &&
    a.titleContent === b.titleContent &&
    a.subtitle === b.subtitle &&
    a.largeTitle === b.largeTitle &&
    a.left === b.left &&
    a.right === b.right &&
    !!a.onBack === !!b.onBack &&
    a.tone === b.tone &&
    primaryActionEqual(a.primaryAction, b.primaryAction) &&
    actionsEqual(a.actions, b.actions) &&
    searchEqual(a.search, b.search) &&
    segmentsEqual(a.segments, b.segments) &&
    progressEqual(a.progress, b.progress)
  );
}

/**
 * Declare the Dialog nav header's content from within a surface screen — its
 * title/subtitle and any action slot. Merges over nothing (the host owns
 * back/close), replaces on change, and clears on unmount. Call it unconditionally;
 * it is a no-op outside a header-mode surface.
 *
 * Screens pass an INLINE `content` object (a fresh reference every render), so the
 * push is guarded by {@link surfaceHeaderContentEqual}: the host's `setContent` is
 * called only when the VALUE actually changes. Without that guard the setState
 * would fire every render → the screen re-renders → the effect runs again → an
 * infinite update loop (React error #185) in any consumer that does not memoize
 * the object for us (i.e. anything not compiled by the React Compiler).
 */
export function useSurfaceHeader(content: SurfaceHeaderContent | null | undefined): void {
  const ctx = useContext(SurfaceHeaderContext);
  const set = ctx?.setContent;
  const setRef = useRef(set);
  setRef.current = set;
  // The last value pushed to the host; `undefined` until the first push.
  const lastRef = useRef<SurfaceHeaderContent | null | undefined>(undefined);

  // Runs after EVERY commit (no deps array) so the bar/title fill in the same
  // layout phase — but only pushes on a real value change, never on reference churn.
  useLayoutEffect(() => {
    const s = setRef.current;
    if (!s) return;
    const next = content ?? null;
    if (lastRef.current !== undefined && surfaceHeaderContentEqual(lastRef.current, next)) return;
    lastRef.current = next;
    s(next);
  });

  // Clear this surface's contribution when the screen unmounts.
  useLayoutEffect(
    () => () => {
      lastRef.current = undefined;
      setRef.current?.(null);
    },
    [],
  );
}
