import { useAppDetail } from '@/components/apps/app-context';
import { RolesPanel } from '@/components/apps/RolesPanel';

export default function AppRolesScreen() {
  const { application, access } = useAppDetail();
  return <RolesPanel key={application._id} application={application} access={access} />;
}
