import { useAppDetail } from '@/components/apps/app-context';
import { CredentialsTable } from '@/components/apps/CredentialsTable';

export default function AppCredentialsScreen() {
  const { application, access } = useAppDetail();
  // Keyed by application so a revealed secret never outlives the selection.
  return <CredentialsTable key={application._id} application={application} access={access} />;
}
