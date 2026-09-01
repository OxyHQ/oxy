import mongoose, { Schema, type Document } from 'mongoose';
import type { AuditEvent } from '@oxyhq/contracts';

export interface ICapabilityAuditEvent extends Document {
  eventId: string;
  event: AuditEvent;
  createdAt: Date;
  updatedAt: Date;
}

const CapabilityAuditEventSchema = new Schema<ICapabilityAuditEvent>({
  eventId: { type: String, required: true, trim: true, maxlength: 255, unique: true, index: true },
  event: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });

CapabilityAuditEventSchema.index({ 'event.correlation.runId': 1, createdAt: 1 });
CapabilityAuditEventSchema.index({ 'event.executor.accountId': 1, createdAt: -1 });
CapabilityAuditEventSchema.index({ 'event.effectiveAccountId': 1, createdAt: -1 });

export const CapabilityAuditEvent = mongoose.model<ICapabilityAuditEvent>(
  'CapabilityAuditEvent',
  CapabilityAuditEventSchema,
);
