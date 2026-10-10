declare module 'expo-document-picker' {
  type DocumentPickerInputType = string | string[];

  export interface DocumentPickerOptions {
    type?: DocumentPickerInputType;
    multiple?: boolean;
    copyToCacheDirectory?: boolean;
  }

  export interface DocumentPickerAsset {
    name?: string | null;
    size?: number | null;
    mimeType?: string | null;
    uri?: string;
    file?: File | Blob;
    lastModified?: number | null;
  }

  export interface DocumentPickerSuccessResult {
    canceled: false;
    assets: DocumentPickerAsset[];
    type?: 'success';
  }

  export interface DocumentPickerCanceledResult {
    canceled: true;
    assets: [];
    type?: 'cancel';
  }

  export type DocumentPickerResult = DocumentPickerSuccessResult | DocumentPickerCanceledResult;

  export function getDocumentAsync(options?: DocumentPickerOptions): Promise<DocumentPickerResult>;
  export function isAvailableAsync(): Promise<boolean>;
}
