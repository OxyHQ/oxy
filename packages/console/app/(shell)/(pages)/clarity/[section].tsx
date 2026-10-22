import { Redirect, useLocalSearchParams } from 'expo-router';

import {
  CLARITY_SECTIONS,
  ClarityPage,
  type ClaritySection,
} from '@/components/clarity/clarity-page';

/** `/clarity/<section>`; an unknown section falls back to the overview. */
export default function ClaritySectionScreen() {
  const { section } = useLocalSearchParams<{ section: string }>();

  if (!CLARITY_SECTIONS.includes(section as ClaritySection) || section === 'overview') {
    return <Redirect href="/clarity" />;
  }
  return <ClarityPage section={section as ClaritySection} />;
}
