import React from 'react';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { Loading } from '@oxy.so/bloom/loading';

/** Floor height for every full-body `EmptyState` (loading, empty, error), so a state swap never jumps the layout. */
export const STATE_MIN_HEIGHT = 360;

interface LoadingStateProps {
  title?: string;
  description?: string;
}

/** A screen body that is still resolving: Bloom's `EmptyState` with a spinner in the illustration slot. */
export function LoadingState({ title, description }: LoadingStateProps) {
  return (
    <EmptyState
      illustration={<Loading variant="spinner" size="lg" />}
      title={title}
      description={description}
      minHeight={STATE_MIN_HEIGHT}
    />
  );
}
