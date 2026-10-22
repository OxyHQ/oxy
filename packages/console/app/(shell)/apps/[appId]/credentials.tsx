import { useAppDetail } from '@/components/apps/app-context';
import { CredentialsSection } from '@/components/apps/credentials-section';

export default function AppCredentialsScreen() {
  const { application, access } = useAppDetail();
  return <CredentialsSection key={application._id} application={application} access={access} />;
}
