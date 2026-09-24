import type React from 'react';
import { Button } from '@oxy.so/bloom/button';

export interface SurfaceHeaderActionProps {
  /** Button label (e.g. a translated "Save"). */
  label: string;
  onPress: () => void;
  /** Show a spinner instead of the label (also disables the button). */
  loading?: boolean;
  disabled?: boolean;
}

/** Header actions share Bloom's sizing, surface, disabled and loading behavior. */
export const SurfaceHeaderAction: React.FC<SurfaceHeaderActionProps> = ({ label, onPress, loading, disabled }) => (
  <Button size="medium" onPress={onPress} loading={loading} disabled={disabled}>
    {label}
  </Button>
);
