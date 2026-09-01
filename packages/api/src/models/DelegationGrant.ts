import mongoose, { Schema, type Document } from 'mongoose';
import {
  AUTONOMY_LEVELS,
  CAPABILITY_PACKAGES,
  type AutonomyLevel,
  type CapabilityPackage,
} from '@oxyhq/contracts';

export interface IDelegationGrant extends Document {
  ownerAccountId: mongoose.Types.ObjectId;
  actorAccountId: mongoose.Types.ObjectId;
  resourceAppId: string;
  effectiveAccountId: mongoose.Types.ObjectId;
  resourceType: string;
  resourceId: string;
  capabilityPackages: CapabilityPackage[];
  maximumAutonomy: AutonomyLevel;
  canRedelegate: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdByUserId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DelegationGrantSchema = new Schema<IDelegationGrant>({
  ownerAccountId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actorAccountId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  resourceAppId: { type: String, required: true, trim: true, maxlength: 255, index: true },
  effectiveAccountId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  resourceType: { type: String, required: true, trim: true, maxlength: 255 },
  resourceId: { type: String, required: true, trim: true, maxlength: 255 },
  capabilityPackages: [{ type: String, enum: CAPABILITY_PACKAGES, required: true }],
  maximumAutonomy: { type: String, enum: AUTONOMY_LEVELS, required: true },
  canRedelegate: { type: Boolean, default: false },
  expiresAt: { type: Date, default: null, index: true },
  revokedAt: { type: Date, default: null, index: true },
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

DelegationGrantSchema.index({
  ownerAccountId: 1,
  actorAccountId: 1,
  resourceAppId: 1,
  effectiveAccountId: 1,
  resourceType: 1,
  resourceId: 1,
});

export const DelegationGrant = mongoose.model<IDelegationGrant>('DelegationGrant', DelegationGrantSchema);

export interface IDelegationCapability extends Document {
  grantId: mongoose.Types.ObjectId;
  capability: string;
}

const DelegationCapabilitySchema = new Schema<IDelegationCapability>({
  grantId: { type: Schema.Types.ObjectId, ref: 'DelegationGrant', required: true, index: true },
  capability: { type: String, required: true, trim: true, maxlength: 255 },
}, { timestamps: true });

DelegationCapabilitySchema.index({ grantId: 1, capability: 1 }, { unique: true });

export const DelegationCapability = mongoose.model<IDelegationCapability>(
  'DelegationCapability',
  DelegationCapabilitySchema,
);

export interface IDelegationToolOverride extends Document {
  grantId: mongoose.Types.ObjectId;
  tool: string;
  decision: 'allow' | 'deny';
}

const DelegationToolOverrideSchema = new Schema<IDelegationToolOverride>({
  grantId: { type: Schema.Types.ObjectId, ref: 'DelegationGrant', required: true, index: true },
  tool: { type: String, required: true, trim: true, maxlength: 255 },
  decision: { type: String, enum: ['allow', 'deny'], required: true },
}, { timestamps: true });

DelegationToolOverrideSchema.index({ grantId: 1, tool: 1 }, { unique: true });

export const DelegationToolOverride = mongoose.model<IDelegationToolOverride>(
  'DelegationToolOverride',
  DelegationToolOverrideSchema,
);

export interface IDelegationLimit extends Document {
  grantId: mongoose.Types.ObjectId;
  key: string;
  value: string | number | boolean | string[];
}

const DelegationLimitSchema = new Schema<IDelegationLimit>({
  grantId: { type: Schema.Types.ObjectId, ref: 'DelegationGrant', required: true, index: true },
  key: { type: String, required: true, trim: true, maxlength: 255 },
  value: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });

DelegationLimitSchema.index({ grantId: 1, key: 1 }, { unique: true });

export const DelegationLimit = mongoose.model<IDelegationLimit>('DelegationLimit', DelegationLimitSchema);
