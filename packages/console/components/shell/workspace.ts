import {
  APP_SHELL_DEFAULTS,
  type AppShellPanelDefinition,
  type AppShellPanelLayout,
  type AppShellProps,
} from '@oxy.so/bloom/app-shell';
import { BREAKPOINTS } from '@oxy.so/bloom/styles';

/** Compositor geometry shared with Inbox: framed from md, drawer reveals below lg. */
export const CONSOLE_WORKSPACE = {
  framedFrom: BREAKPOINTS.md,
  safeArea: true,
  drawer: 'reveal',
  header: null,
  contentMaxWidth: 'none',
  gutter: APP_SHELL_DEFAULTS.dashboardGutter,
} satisfies Partial<AppShellProps>;

export const CONSOLE_PANELS = {
  mode: 'split',
  flow: 'bounded',
  appearance: 'separated',
  collapseBelow: BREAKPOINTS.lg,
} satisfies Partial<AppShellPanelLayout>;

/** Optional list pane (e.g. the applications list beside an app's detail). */
export const CONSOLE_LIST_PANEL = {
  id: 'list',
  width: 340,
  minWidth: 280,
  maxWidth: 440,
  chrome: 'none',
  scroll: 'content',
} satisfies AppShellPanelDefinition;

export const CONSOLE_DETAIL_PANEL = {
  id: 'detail',
  appearance: 'plain',
  chrome: 'none',
  scroll: 'content',
} satisfies AppShellPanelDefinition;
