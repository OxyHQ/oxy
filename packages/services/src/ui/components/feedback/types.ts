import type { Animated } from 'react-native';

export interface FeedbackData {
  type: 'bug' | 'feature' | 'general' | 'support';
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  contactEmail: string;
  systemInfo: boolean;
}

export interface FeedbackState {
  status: 'idle' | 'submitting' | 'success' | 'error';
  message: string;
}

export interface FeedbackType {
  id: FeedbackData['type'];
  label: string;
  icon: string;
  color: string;
  description: string;
}

export interface PriorityLevel {
  id: FeedbackData['priority'];
  label: string;
  icon: string;
  color: string;
}

export interface FeedbackColors {
  primary: string;
  text: string;
  secondaryText: string;
  border: string;
  background: string;
  inputBackground: string;
  success?: string;
}

export interface FeedbackStepAnimations {
  fadeAnim: Animated.Value;
  slideAnim: Animated.Value;
}

export interface User {
  id?: string;
  email?: string;
  username?: string;
}
