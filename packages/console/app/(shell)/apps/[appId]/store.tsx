import { StoreSection } from '@/components/apps-store/store-section';
import { useAppDetail } from '@/components/apps/app-context';

/** The application's store page: its listing, review state and screenshots. */
export default function AppStoreScreen() {
  const { application, access } = useAppDetail();
  return <StoreSection application={application} access={access} />;
}
