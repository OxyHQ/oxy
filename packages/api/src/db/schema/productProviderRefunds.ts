/** Terminal full-cash-refund evidence may arrive before any paid grant exists.
 * No FK to source/segment: that would prevent recording the activation fence.
 * IDs are derived from the same owned financial identity as paid evidence. */
import {sql} from 'drizzle-orm';
import {check,pgTable,text,unique,jsonb} from 'drizzle-orm/pg-core';
import {createdAt,timestamptz} from '@oxy.so/db';
import {users} from './users';
export const accessProviderRefunds=pgTable('access_provider_refunds',{
 id:text().primaryKey(),provider:text().notNull(),providerAccountRef:text().notNull(),mode:text().notNull(),environment:text().notNull(),
 invoiceId:text().notNull(),lineId:text().notNull(),priceId:text().notNull(),paymentIntentId:text().notNull(),chargeId:text().notNull(),
 sourceId:text().notNull(),segmentId:text().notNull(),providerSubscriptionId:text().notNull(),
 payerAccountId:text().notNull().references(()=>users.id,{onDelete:'restrict'}),beneficiaryAccountId:text().notNull().references(()=>users.id,{onDelete:'restrict'}),
 periodStart:timestamptz().notNull(),periodEnd:timestamptz().notNull(),payload:jsonb().notNull(),payloadSha256:text().notNull(),observedAt:timestamptz().notNull(),createdAt:createdAt(),
},t=>[
 unique('access_provider_refunds_segment_key').on(t.segmentId),
 unique('access_provider_refunds_financial_key').on(t.provider,t.providerAccountRef,t.mode,t.environment,t.invoiceId,t.lineId),
 check('access_provider_refunds_provider',sql`${t.provider}='peable'`),
 check('access_provider_refunds_namespace',sql`(${t.mode}='live' and ${t.environment}='production') or (${t.mode}='test' and ${t.environment} in ('test','staging','development'))`),
 check('access_provider_refunds_period',sql`${t.periodEnd}>${t.periodStart}`),
 check('access_provider_refunds_payload',sql`jsonb_typeof(${t.payload})='object' and ${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
]);
