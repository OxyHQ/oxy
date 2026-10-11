import type { FeedbackType, PriorityLevel } from './types';

export const FEEDBACK_TYPES: FeedbackType[] = [
  {
    id: 'bug',
    label: 'Bug Report',
    icon: 'bug',
    color: '#FF3B30',
    description: 'Report a problem or issue',
  },
  {
    id: 'feature',
    label: 'Feature Request',
    icon: 'bulb',
    color: '#007AFF',
    description: 'Suggest a new feature',
  },
  {
    id: 'general',
    label: 'General Feedback',
    icon: 'chatbubble',
    color: '#34C759',
    description: 'Share your thoughts',
  },
  {
    id: 'support',
    label: 'Support Request',
    icon: 'help-circle',
    color: '#FF9500',
    description: 'Get help with something',
  },
];

export const PRIORITY_LEVELS: PriorityLevel[] = [
  { id: 'low', label: 'Low', icon: 'arrow-down', color: '#34C759' },
  { id: 'medium', label: 'Medium', icon: 'remove', color: '#FF9500' },
  { id: 'high', label: 'High', icon: 'arrow-up', color: '#FF3B30' },
  { id: 'critical', label: 'Critical', icon: 'warning', color: '#FF0000' },
];

export const CATEGORIES: Record<string, string[]> = {
  bug: ['UI/UX', 'Performance', 'Authentication', 'File Management', 'Billing', 'Other'],
  feature: ['User Interface', 'File Management', 'Security', 'Performance', 'Integration', 'Other'],
  general: ['User Experience', 'Design', 'Performance', 'Documentation', 'Other'],
  support: ['Account Issues', 'Billing', 'Technical Problems', 'Feature Questions', 'Other'],
};
