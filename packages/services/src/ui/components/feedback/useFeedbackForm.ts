import { useState, useCallback } from 'react';
import type { FeedbackData, FeedbackState } from './types';

export const useFeedbackForm = () => {
  const [feedbackData, setFeedbackData] = useState<FeedbackData>({
    type: 'general',
    title: '',
    description: '',
    priority: 'medium',
    category: '',
    contactEmail: '',
    systemInfo: true,
  });

  const [feedbackState, setFeedbackState] = useState<FeedbackState>({
    status: 'idle',
    message: '',
  });

  const updateField = useCallback(
    <K extends keyof FeedbackData>(field: K, value: FeedbackData[K]) => {
      setFeedbackData((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const resetForm = useCallback(() => {
    setFeedbackData({
      type: 'general',
      title: '',
      description: '',
      priority: 'medium',
      category: '',
      contactEmail: '',
      systemInfo: true,
    });
    setFeedbackState({ status: 'idle', message: '' });
  }, []);

  return {
    feedbackData,
    feedbackState,
    setFeedbackState,
    updateField,
    resetForm,
  };
};
