declare module 'expo-image-picker' {
    export interface ImagePickerAsset {
        uri: string;
        width: number;
        height: number;
    }

    export interface ImagePickerSuccessResult {
        canceled: false;
        assets: ImagePickerAsset[];
    }

    export interface ImagePickerCanceledResult {
        canceled: true;
        assets: null;
    }

    export type ImagePickerResult = ImagePickerSuccessResult | ImagePickerCanceledResult;

    export interface ImagePickerPermission {
        granted: boolean;
        canAskAgain: boolean;
    }

    export interface ImagePickerOptions {
        mediaTypes?: 'images'[];
        allowsMultipleSelection?: boolean;
        quality?: number;
    }

    export function launchImageLibraryAsync(options?: ImagePickerOptions): Promise<ImagePickerResult>;
    export function launchCameraAsync(options?: ImagePickerOptions): Promise<ImagePickerResult>;
    export function requestMediaLibraryPermissionsAsync(): Promise<ImagePickerPermission>;
    export function requestCameraPermissionsAsync(): Promise<ImagePickerPermission>;
}
