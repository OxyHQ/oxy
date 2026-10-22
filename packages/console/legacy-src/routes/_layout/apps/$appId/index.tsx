import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_layout/apps/$appId/')({
  // The application detail view is the settings page (General / Members /
  // Credentials / Usage tabs). Redirect the bare app route to it.
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/apps/$appId/settings', params: { appId: params.appId } });
  },
});
