import type React from 'react';
import { memo } from 'react';
import { GroupedSectionIcon } from '@oxy.so/bloom/grouped-section';
import MaterialCommunityIcons from '../icons/MaterialCommunityIcons';

interface SettingsIconProps {
  name: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  color: string;
  iconSize?: number;
  size?: number;
}

/** SDK glyph adapter; Bloom owns the shared icon surface and contrast. */
const SettingsIconComponent: React.FC<SettingsIconProps> = ({ name, color, iconSize, size }) => (
  <GroupedSectionIcon color={color} size={size} iconSize={iconSize}>
    {({ color: foreground, size: glyphSize }) => (
      <MaterialCommunityIcons name={name} size={glyphSize} color={foreground} />
    )}
  </GroupedSectionIcon>
);

SettingsIconComponent.displayName = 'SettingsIcon';
export const SettingsIcon = memo(SettingsIconComponent);
export default SettingsIcon;
