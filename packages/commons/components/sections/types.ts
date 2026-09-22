import type React from 'react';
import type { IconName } from '@/constants/icons';

/**
 * A single row rendered by `GroupedSection`.
 *
 * Mirrors the props that `components/grouped-section` accepts. Declared here
 * (rather than imported from that component) so the home and security screens
 * — which both build large arrays of these — share one canonical shape instead
 * of redeclaring it locally.
 */
export interface GroupedItem {
  id: string;
  icon?: IconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  showChevron?: boolean;
  disabled?: boolean;
  customContent?: React.ReactNode;
  customIcon?: React.ReactNode;
}

/**
 * A `GroupedItem` that carries a sort `priority`. Lower numbers sort first.
 *
 * Used by the recommendation builders on both the home and security screens,
 * which collect a list of candidate recommendations and render them ordered by
 * ascending priority.
 */
export interface PrioritizedGroupedItem extends GroupedItem {
  priority: number;
}
