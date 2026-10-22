import { useAppDetail } from '@/components/apps/app-context';
import { WebhooksAuditSection } from '@/components/apps/webhooks-audit-section';

export default function AppWebhooksScreen() {
  const { application, access } = useAppDetail();
  return <WebhooksAuditSection key={application._id} application={application} access={access} />;
}
