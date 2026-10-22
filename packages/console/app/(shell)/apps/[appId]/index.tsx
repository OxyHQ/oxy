import { useAppDetail } from '@/components/apps/app-context';
import { GeneralForm } from '@/components/apps/GeneralForm';

export default function AppGeneralScreen() {
  const { application, access } = useAppDetail();
  // Keyed by application so a fresh draft mounts when the selection changes.
  return <GeneralForm key={application._id} application={application} access={access} />;
}
