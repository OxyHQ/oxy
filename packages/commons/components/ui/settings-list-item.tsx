import {
  SettingsListItem as BloomSettingsListItem,
  type SettingsListItemProps,
} from '@oxy.so/bloom/settings-list';

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
}: SettingsListItemProps) {
  return (
    <BloomSettingsListItem
      {...props}
      titleNumberOfLines={titleNumberOfLines}
      descriptionLines={descriptionLines}
    />
  );
}
