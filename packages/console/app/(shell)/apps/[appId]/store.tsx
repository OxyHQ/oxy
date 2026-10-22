import { ApplicationTab } from '@/components/apps-inference/application-tab';
import { StoreSection } from '@/components/apps-store/store-section';

/** The application's store page: its listing, review state and screenshots. */
export default function AppStoreScreen() {
  return (
    <ApplicationTab maxWidthClassName="max-w-4xl">
      {(application, access) => <StoreSection application={application} access={access} />}
    </ApplicationTab>
  );
}
