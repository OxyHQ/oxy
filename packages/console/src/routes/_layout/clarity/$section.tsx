import { createFileRoute, redirect } from '@tanstack/react-router';
import type { ClaritySection } from '@/components/clarity/clarity-page';
import { ClarityPage } from '@/components/clarity/clarity-page';

const sections = new Set<ClaritySection>(['search', 'news', 'indexing', 'sites', 'jobs', 'usage']);

export const Route = createFileRoute('/_layout/clarity/$section')({
  beforeLoad: ({ params }) => { if (!sections.has(params.section as ClaritySection)) throw redirect({ to: '/clarity' }); },
  component: SectionPage,
});

function SectionPage() {
  const { section } = Route.useParams();
  return <ClarityPage section={section as ClaritySection} />;
}
