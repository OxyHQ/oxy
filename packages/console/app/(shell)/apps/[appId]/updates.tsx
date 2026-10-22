import { UpdatesSection } from '@/components/apps-updates/updates-section';
import { useAppDetail } from '@/components/apps/app-context';

/** Over-the-air update channels for the application. */
export default function AppUpdatesScreen() {
  const { application, access } = useAppDetail();
  return <UpdatesSection application={application} access={access} />;
}
