import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

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
      })],
    })
  : null;

sdk?.start();

/** Flush telemetry during the server's existing graceful-shutdown window. */
export const shutdownTelemetry = async (): Promise<void> => {
  await sdk?.shutdown();
};
