import createIconSet from '@expo/vector-icons/createIconSet';
import font from '../../assets/fonts/icons/OxyServicesMaterialCommunityIcons.ttf';
import { materialCommunityIconsGlyphMap } from './subsetGlyphMaps';

const MaterialCommunityIcons = createIconSet(
  materialCommunityIconsGlyphMap,
  'OxyServicesMaterialCommunityIcons',
  font,
);

export default MaterialCommunityIcons;
