import { GroupedSectionItem, type GroupedSectionItemProps } from '@oxy.so/bloom/grouped-section';

/**
 * Bloom's settings row with nothing cut off.
 *
 * Bloom clamps a row's title at one line and its description at two. In
 * Commons a row is how an identity, a key or a backup is explained, and in
 * Spanish the clamps cut titles and sentences mid-word ("Consigue avales de
 * personas de con…", Pixel 8a). Every Commons row shows its text whole; a
 * caller can still clamp one by passing the limit.
 */
export function SettingsListItem({
  titleNumberOfLines = 0,
  descriptionLines = 0,
  ...props
}: GroupedSectionItemProps) {
  return (
    <GroupedSectionItem
      {...props}
      titleNumberOfLines={titleNumberOfLines}
      descriptionLines={descriptionLines}
    />
  );
}
