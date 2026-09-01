import mongoose, { Schema, type Document } from 'mongoose';
import { AUTONOMY_LEVELS, type AutonomyLevel } from '@oxyhq/contracts';

export interface IAccountCapabilityPolicy extends Document {
  accountId: mongoose.Types.ObjectId;
  appId: string;
  maximumAutonomy: AutonomyLevel;
  deniedCapabilities: string[];
  createdAt: Date;
  updatedAt: Date;
}

const AccountCapabilityPolicySchema = new Schema<IAccountCapabilityPolicy>({
  accountId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  appId: { type: String, required: true, trim: true, maxlength: 255 },
  maximumAutonomy: { type: String, enum: AUTONOMY_LEVELS, required: true },
  deniedCapabilities: [{ type: String, trim: true, maxlength: 255 }],
}, { timestamps: true });

AccountCapabilityPolicySchema.index({ accountId: 1, appId: 1 }, { unique: true });

export const AccountCapabilityPolicy = mongoose.model<IAccountCapabilityPolicy>(
  'AccountCapabilityPolicy',
  AccountCapabilityPolicySchema,
);
