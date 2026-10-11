import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { SocketIoInstrumentation } from '@opentelemetry/instrumentation-socket.io';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { shouldSuppressHttpTrace } from './utils/telemetryRedaction.js';

const enabled =
  process.env.OTEL_SDK_DISABLED !== 'true' && Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

const sdk = enabled
  ? new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'oxy-api',
      // Traces only, sampled by OTEL_TRACES_SAMPLER/_ARG from the task definition.
      // Metrics are Oxy ecosystem telemetry's job, not CloudWatch's.
      traceExporter: new OTLPTraceExporter(),
      // Only the libraries this API runs on. Redis stays uninstrumented: session
      // cache values contain bearer and refresh tokens, and Redis spans must never
      // copy command arguments into the telemetry trust boundary.
      instrumentations: [
        new HttpInstrumentation({
          // HTTP instrumentation records the raw target before Express can
          // replace parameters with its route template. Do not create spans
          // when that target can contain credentials.
          ignoreIncomingRequestHook: (request) => shouldSuppressHttpTrace(request.url),
        }),
        new ExpressInstrumentation(),
        new UndiciInstrumentation(),
        new SocketIoInstrumentation(),
        new AwsInstrumentation(),
        new PinoInstrumentation(),
      ],
    })
  : null;

sdk?.start();

/** Flush telemetry during the server's existing graceful-shutdown window. */
export const shutdownTelemetry = async (): Promise<void> => {
  await sdk?.shutdown();
};
