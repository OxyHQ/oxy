import mongoose, { Schema, type Document } from 'mongoose';

export interface ICapabilityIdempotencyKey extends Document {
  effectiveAccountId: mongoose.Types.ObjectId;
  appId: string;
  tool: string;
  keyHash: string;
  ticketId: string;
  status: 'started' | 'succeeded' | 'failed';
  responseStatus?: number;
  createdAt: Date;
  updatedAt: Date;
}

const CapabilityIdempotencyKeySchema = new Schema<ICapabilityIdempotencyKey>({
  effectiveAccountId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  appId: { type: String, required: true, trim: true, maxlength: 255 },
  tool: { type: String, required: true, trim: true, maxlength: 255 },
  keyHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  ticketId: { type: String, required: true, trim: true, maxlength: 255 },
  status: { type: String, enum: ['started', 'succeeded', 'failed'], required: true },
  responseStatus: { type: Number },
}, { timestamps: true });

CapabilityIdempotencyKeySchema.index(
  { effectiveAccountId: 1, appId: 1, tool: 1, keyHash: 1 },
  { unique: true },
);

export const CapabilityIdempotencyKey = mongoose.model<ICapabilityIdempotencyKey>(
  'CapabilityIdempotencyKey',
  CapabilityIdempotencyKeySchema,
);
