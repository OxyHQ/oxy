import { executeRows, type SqlExecutor } from '@oxy.so/db';
import { sql } from 'drizzle-orm';
import type { InferenceEnvironment } from '@oxy.so/contracts';
import { readMeteredCapacity } from '../services/inferenceMeteredUsage.service';

/** Schema readiness is independent of identity and capacity; every read is metadata only. */
export async function readJevTechnicalMetering(
  executor: SqlExecutor, applicationId: string, environment: InferenceEnvironment
): Promise<{ schemaAvailable: boolean; activeAdmissions: number; dailyAdmissions: number }> {
  const [schema] = await executeRows<{ available: boolean }>(executor, sql`
    select to_regclass('public.inference_metered_usage') is not null
      and (select count(*) from pg_attribute a
        where a.attrelid = to_regclass('public.inference_metered_usage')
          and not a.attisdropped and not a.attnotnull
          and ((a.attname in ('parent_request_id', 'final_authorized_model_reference',
            'final_authorized_provider', 'final_authorized_deployment_id',
            'final_authorized_ceiling_currency') and format_type(a.atttypid, a.atttypmod) = 'text')
            or (a.attname = 'final_authorized_ceiling_amount'
              and format_type(a.atttypid, a.atttypmod) = 'numeric(30,12)'))) = 6
      and (select count(*) from pg_constraint c
        where c.conrelid = to_regclass('public.inference_metered_usage')
          and c.contype = 'c' and c.convalidated and c.conname in
            ('inference_metered_usage_parent_check', 'inference_metered_usage_final_authorization_check')) = 2
      and exists (select 1 from pg_index i join pg_class idx on idx.oid = i.indexrelid
        join pg_attribute a on a.attrelid = i.indrelid and a.attname = 'parent_request_id'
        where i.indrelid = to_regclass('public.inference_metered_usage')
          and idx.relname = 'inference_metered_usage_parent_idx'
          and i.indisvalid and i.indisready and i.indnkeyatts = 1
          and i.indkey[0] = a.attnum) as available`);
  if (schema?.available !== true) return { schemaAvailable: false, activeAdmissions: 0, dailyAdmissions: 0 };
  return { schemaAvailable: true, ...await readMeteredCapacity(executor, applicationId, environment) };
}
