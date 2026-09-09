import { createFileRoute } from '@tanstack/react-router';
import { ClarityPage } from '@/components/clarity/clarity-page';

export const Route = createFileRoute('/_layout/clarity/')({ component: () => <ClarityPage section="overview" /> });
