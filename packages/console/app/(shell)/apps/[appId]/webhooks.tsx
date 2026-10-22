import { useAppDetail } from '@/components/apps/app-context';
import { FilesWebhookForm } from '@/components/apps/FilesWebhookForm';
import { WebhookAudit } from '@/components/apps/WebhookAudit';
import { WebhookEndpointsForm } from '@/components/apps/WebhookEndpointsForm';

export default function AppWebhooksScreen() {
  const { application, access } = useAppDetail();
  return (
    <>
      <WebhookEndpointsForm key={application._id} application={application} access={access} />
      <FilesWebhookForm
        key={`files-${application._id}`}
        application={application}
        canEdit={access.can('webhooks:update')}
      />
      <WebhookAudit application={application} access={access} />
    </>
  );
}
