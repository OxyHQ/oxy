import { ApplicationTab } from '@/components/apps-inference/application-tab';
import { UpdatesSection } from '@/components/apps-updates/updates-section';

/** Over-the-air update channels for the application. */
export default function AppUpdatesScreen() {
  return (
    <ApplicationTab maxWidthClassName="max-w-4xl">
      {(application, access) => <UpdatesSection application={application} access={access} />}
    </ApplicationTab>
  );
}
