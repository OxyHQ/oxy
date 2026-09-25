import React from 'react';

interface IconProps {
  name?: string;
  accessibilityLabel?: string;
  'aria-hidden'?: boolean;
}

export default function createIconSet(glyphMap: Record<string, number>) {
  const Icon = ({ name, accessibilityLabel, 'aria-hidden': ariaHidden }: IconProps): React.ReactElement =>
    React.createElement('span', {
      'data-icon': name,
      'aria-label': accessibilityLabel,
      'aria-hidden': ariaHidden,
    });
  Icon.glyphMap = glyphMap;
  return Icon;
}
