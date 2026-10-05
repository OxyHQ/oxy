import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { shouldSuppressHttpTrace } from './utils/telemetryRedaction.js';

const enabled = process.env.OTEL_SDK_DISABLED !== 'true'
  && Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

const sdk = enabled
  ? new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'oxy-api',
      traceExporter: new OTLPTraceExporter(),
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: 30_000,
        }),
      ],
      instrumentations: [getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        // Session cache values contain bearer and refresh tokens. Redis spans
        // must never copy command arguments into the telemetry trust boundary.
        '@opentelemetry/instrumentation-ioredis': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          // HTTP instrumentation records the raw target before Express can
          // replace parameters with its route template. Do not create spans
          // when that target can contain credentials.
          ignoreIncomingRequestHook: request => shouldSuppressHttpTrace(request.url),
        },
      })],
    })
  : null;

sdk?.start();

/** Flush telemetry during the server's existing graceful-shutdown window. */
export const shutdownTelemetry = async (): Promise<void> => {
  await sdk?.shutdown();
};
