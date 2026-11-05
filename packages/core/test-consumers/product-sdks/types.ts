import { OxyServices } from '@oxy.so/core';
import { OxyServer } from '@oxy.so/core/server';
import { createAliaForOxyService, createAliaTransportForOxyService } from '@alia.onl/server';
import { clarityForOxyService } from '@clarity.surf/sdk/server';
import { kaanaForOxyService } from '@kaana.ai/sdk/server';
import { postOxyServiceJson } from '@oxy.so/mcp';
import type { useOxy } from '@oxy.so/services/ui/client';
const own = new OxyServer({ baseURL: 'http://127.0.0.1:1' });
const frontend = new OxyServices({ baseURL: 'http://127.0.0.1:1' });
const providerClient: ReturnType<typeof useOxy>['oxyServices'] = frontend;
const linked = providerClient.createLinkedClient({ baseURL: 'http://127.0.0.1:1' });
const alia = createAliaForOxyService(own, { requester: { accountId: 'A', taskId: 'task-A' } });
const aliaTransport = createAliaTransportForOxyService(own, {
  requester: { accountId: 'A', requesterContext: 'proof' },
});
const clarity = clarityForOxyService(own);
const kaana = kaanaForOxyService(own, { attribution: { accountId: 'A' } });
const mcp = postOxyServiceJson(
  {},
  {
    endpoint: 'https://api.oxy.so/probe',
    transport: own.createServiceClient({ baseURL: 'https://api.oxy.so', audience: 'oxy-api' }),
  },
);
void [linked, alia, aliaTransport, clarity, kaana, mcp];
