import { useAppDetail } from '@/components/apps/app-context';
import { UsagePanel } from '@/components/apps/UsagePanel';

export default function AppUsageScreen() {
  const { application, access } = useAppDetail();
  return <UsagePanel key={application._id} application={application} access={access} />;
}
