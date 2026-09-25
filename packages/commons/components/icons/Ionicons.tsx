import React, { type ComponentProps } from 'react';
// The SUBPATH, never the `@expo/vector-icons` barrel (see MaterialCommunityIcons.tsx).
import BaseIonicons from '@expo/vector-icons/Ionicons';

export type IoniconsProps = ComponentProps<typeof BaseIonicons>;

/**
 * Commons' one entry to the Ionicons glyph font. The glyph is hidden from
 * assistive technology after the caller's props, for the reason documented on
 * `components/icons/MaterialCommunityIcons.tsx`.
 */
function Ionicons(props: IoniconsProps) {
  return <BaseIonicons {...props} aria-hidden />;
}

Ionicons.glyphMap = BaseIonicons.glyphMap;

export default Ionicons;
