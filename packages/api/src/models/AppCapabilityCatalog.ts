import mongoose, { Schema, type Document } from 'mongoose';
import type { AppCapabilityCatalog } from '@oxyhq/contracts';

export interface IAppCapabilityCatalogRegistration extends Document {
  appId: string;
  version: string;
  audience: string;
  catalog: AppCapabilityCatalog;
  digest: string;
  signature: string;
  registeredByApplicationId: mongoose.Types.ObjectId;
  registeredByCredentialId: mongoose.Types.ObjectId;
  deployedAt: Date;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AppCapabilityCatalogSchema = new Schema<IAppCapabilityCatalogRegistration>({
  appId: { type: String, required: true, trim: true, maxlength: 255, index: true },
  version: { type: String, required: true, trim: true, maxlength: 255 },
  audience: { type: String, required: true, trim: true, maxlength: 255 },
  catalog: { type: Schema.Types.Mixed, required: true },
  digest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  signature: { type: String, required: true },
  registeredByApplicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true },
  registeredByCredentialId: { type: Schema.Types.ObjectId, ref: 'ApplicationCredential', required: true },
  deployedAt: { type: Date, required: true },
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true });

AppCapabilityCatalogSchema.index({ appId: 1, version: 1, digest: 1 }, { unique: true });
AppCapabilityCatalogSchema.index(
  { appId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

export const AppCapabilityCatalogRegistration = mongoose.model<IAppCapabilityCatalogRegistration>(
  'AppCapabilityCatalogRegistration',
  AppCapabilityCatalogSchema,
);
