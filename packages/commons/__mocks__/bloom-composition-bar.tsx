/**
 * Lightweight `@oxy.so/bloom/composition-bar` stub for component tests.
 */
import React from 'react';

export interface CompositionCategory {
  key: string;
  name: string;
  amount: number;
  color: string;
  fraction: number;
}

interface CompositionBarProps {
  categories: CompositionCategory[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  hintLabel: string;
  formatReadout: (points: number, percent: number) => string;
}

export function CompositionBar({ categories, hintLabel }: CompositionBarProps) {
  return (
    <div data-testid="composition-bar">
      <span>{hintLabel}</span>
      {categories.map((category) => (
        <span key={category.key}>{category.name}</span>
      ))}
    </div>
  );
}
