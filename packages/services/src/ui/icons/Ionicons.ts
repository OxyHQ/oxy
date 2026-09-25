import createIconSet from '@expo/vector-icons/createIconSet';
import { decorativeIconSet } from './decorativeIconSet';
import font from '../../assets/fonts/icons/OxyServicesIonicons.ttf';
import { ioniconsGlyphMap } from './subsetGlyphMaps';

/** Glyphs are decorative: hidden from assistive technology (see `decorativeIconSet`). */
const Ionicons = decorativeIconSet(
  createIconSet(
    ioniconsGlyphMap,
    'OxyServicesIonicons',
    font,
  ),
  'Ionicons',
);

export default Ionicons;
