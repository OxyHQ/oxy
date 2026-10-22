import { useAppDetail } from '@/components/apps/app-context';
import { UsageSection } from '@/components/apps/usage-section';

export default function AppUsageScreen() {
  const { application, access } = useAppDetail();
  return <UsageSection key={application._id} application={application} access={access} />;
}
