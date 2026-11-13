import type { DialogHeaderConfig } from '@oxy.so/bloom/dialog';
import { useSurfaceHeader } from './useSurfaceHeader';
const semantic: NonNullable<DialogHeaderConfig['actions']>[number] = {
  id: 'save', label: 'Save', onPress() {}, busy: true, selected: false,
  visible: true, overflow: 'auto', group: 'document', priority: 2,
  essential: false, labelVisibility: 'always',
};
const legacy: NonNullable<DialogHeaderConfig['actions']>[number] = {
  accessibilityLabel: 'More', onPress() {},
};
useSurfaceHeader({ actions: [semantic, legacy] });
