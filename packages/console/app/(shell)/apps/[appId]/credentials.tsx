import { useAppDetail } from '@/components/apps/app-context';
import { CredentialAccessSettings } from '@/components/apps/CredentialAccessSettings';
import { CredentialsTable } from '@/components/apps/CredentialsTable';

export default function AppCredentialsScreen() {
  const { application, access } = useAppDetail();
  // Keyed by application so a revealed secret never outlives the selection.
  return (
    <>
      <CredentialAccessSettings
        key={`access:${application._id}`}
        application={application}
        access={access}
      />
      <CredentialsTable key={application._id} application={application} access={access} />
    </>
  );
}
