import { GeneralSection } from '@/components/apps/general-section';
import { useAppDetail } from '@/components/apps/app-context';

export default function AppGeneralScreen() {
  const { application, access } = useAppDetail();
  // Keyed by application so moving between two applications mounts a fresh
  // draft instead of carrying the previous one's typing into the wrong app.
  return <GeneralSection key={application._id} application={application} access={access} />;
}
