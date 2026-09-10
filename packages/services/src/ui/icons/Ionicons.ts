import createIconSet from '@expo/vector-icons/createIconSet';
import font from '../../assets/fonts/icons/OxyServicesIonicons.ttf';
import { ioniconsGlyphMap } from './subsetGlyphMaps';

const Ionicons = createIconSet(
  ioniconsGlyphMap,
  'OxyServicesIonicons',
  font,
);

export default Ionicons;
