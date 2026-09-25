import createIconSet from '@expo/vector-icons/createIconSet';
import { decorativeIconSet } from './decorativeIconSet';
import font from '../../assets/fonts/icons/OxyServicesMaterialCommunityIcons.ttf';
import { materialCommunityIconsGlyphMap } from './subsetGlyphMaps';

/** Glyphs are decorative: hidden from assistive technology (see `decorativeIconSet`). */
const MaterialCommunityIcons = decorativeIconSet(
  createIconSet(
    materialCommunityIconsGlyphMap,
    'OxyServicesMaterialCommunityIcons',
    font,
  ),
  'MaterialCommunityIcons',
);

export default MaterialCommunityIcons;
