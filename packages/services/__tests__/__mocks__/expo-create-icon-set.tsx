import React from 'react';

interface IconProps {
  name?: string;
  accessibilityLabel?: string;
}

export default function createIconSet(glyphMap: Record<string, number>) {
  const Icon = ({ name, accessibilityLabel }: IconProps): React.ReactElement =>
    React.createElement('span', { 'data-icon': name, 'aria-label': accessibilityLabel });
  Icon.glyphMap = glyphMap;
  return Icon;
}
