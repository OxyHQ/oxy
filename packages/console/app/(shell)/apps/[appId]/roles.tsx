import { useAppDetail } from '@/components/apps/app-context';
import { RolesSection } from '@/components/apps/roles-section';

export default function AppRolesScreen() {
  const { application, access } = useAppDetail();
  return <RolesSection key={application._id} application={application} access={access} />;
}
