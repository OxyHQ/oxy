import { observeEdgeRequest } from '@oxy.so/telemetry/edge';

type EdgeOptions = Parameters<typeof observeEdgeRequest>[0];
type PagesContext = EdgeOptions['ctx'] & Pick<EdgeOptions, 'request' | 'env' | 'next'>;

// Directory middleware preserves the existing /hub/* Pages function routing.
export function onRequest(context: PagesContext): Promise<Response> {
  return observeEdgeRequest({ service: 'auth', request: context.request, env: context.env, ctx: context, next: () => context.next() });
}
