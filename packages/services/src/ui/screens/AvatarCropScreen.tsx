/**
 * AvatarCropScreen
 *
 * Flagship-grade circular crop editor presented after the user picks an image
 * but before the avatar is uploaded. Inspired by iOS Photos, Google Photos and
 * Instagram crop tools.
 *
 * Reached ONLY by navigating within a `ChangeAvatar` surface, so the panel
 * morphs from the source list into the editor. The surface owns the chrome: this
 * screen declares its title and its "Use photo" action through `useSurfaceHeader`
 * and renders no bar of its own — the nav bar's back arrow is Cancel, and it
 * returns to the source list.
 *
 * Architecture:
 *  - A dark crop stage, independent of theme, so photos always read well, inset
 *    inside the surface's own themed panel.
 *  - Circular viewport with white ring and a 3x3 rule-of-thirds grid that
 *    appears during gestures and fades after 800ms.
 *  - Floating zoom chip during pinch.
 *  - Pan + pinch via Gesture Handler, transform driven by Reanimated.
 *  - Reduced-motion aware entrance animation.
 *  - Haptics on milestones via dynamically imported expo-haptics (optional).
 *
 * `expo-image-manipulator` and `expo-haptics` are optional peer dependencies —
 * loaded with `await import(...)`. A missing manipulator surfaces a clear
 * error; missing haptics simply degrades silently.
 */

import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ActivityIndicator,
    Image,
    Platform,
    AccessibilityInfo,
    Pressable,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    Easing,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { logger } from '@oxyhq/core';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { useSurfaceHeader, type SurfaceHeaderContent } from '../hooks/useSurfaceHeader';
import { toast } from '@oxyhq/bloom/toast';
import type { BaseScreenProps } from '../types/navigation';

/** Component name used in `logger` context for filtered diagnostics. */
const LOG_COMPONENT = 'AvatarCropScreen';

/** Final crop result handed back to the caller. */
export interface AvatarCropResult {
    /** File URI to the cropped 512x512 JPEG on disk. */
    uri: string;
    /** Output width (always 512). */
    width: number;
    /** Output height (always 512). */
    height: number;
    /** MIME type (always `image/jpeg`). */
    mime: 'image/jpeg';
}

export interface AvatarCropScreenProps extends BaseScreenProps {
    /** URI of the source image to crop (device / camera sources pass this). */
    imageUri?: string;
    /**
     * ID of an existing Oxy file to crop (the "My Oxy files" source passes this
     * instead of a URL). Its download URL is usually private, so it is resolved
     * HERE — showing this screen's own loading state on the dark canvas — rather
     * than in the source list, which would otherwise linger for the round-trip.
     */
    imageFileId?: string;
    /** Natural width of the source image (optional — measured if absent). */
    sourceWidth?: number;
    /** Natural height of the source image (optional — measured if absent). */
    sourceHeight?: number;
}

/** Side length (in dp) of the crop viewport. The output is always 512x512px. */
const VIEWPORT_SIZE = 320;
const OUTPUT_SIZE = 512;
const MIN_SCALE = 1;
const MAX_SCALE = 4;
/** Zoom increment per +/- button press (web, where there is no pinch). */
const ZOOM_STEP = 0.5;
/** Tween duration for a button-driven zoom (collapses to 0 under reduce-motion). */
const ZOOM_BUTTON_DURATION_MS = 180;
/** Duration (ms) that the rule-of-thirds grid lingers after a gesture ends. */
const GRID_FADE_DELAY_MS = 800;
const GRID_FADE_DURATION_MS = 220;
/** Duration the zoom chip stays visible after a pinch ends. */
const ZOOM_CHIP_FADE_DELAY_MS = 600;
const ZOOM_CHIP_FADE_DURATION_MS = 200;
/** Stage color is fixed independent of theme so the photo always reads well. */
const CANVAS_BG = '#000000';
/** Corner radius of the dark stage block inside the surface's themed panel. */
const STAGE_RADIUS = 24;
const RING_COLOR = '#ffffff';
const RING_WIDTH = 2;
const REMOTE_HTTP_URI_PATTERN = /^https?:\/\//i;

/**
 * Clamp the translation so the image edges never leave the viewport at any
 * scale. Worklet-friendly (pure function, no closures over JS state) so the
 * gesture handlers can reuse it without re-creating the closure each render.
 */
function clampTranslation(
    tx: number,
    ty: number,
    s: number,
    baseW: number,
    baseH: number,
): { tx: number; ty: number } {
    'worklet';
    const scaledW = baseW * s;
    const scaledH = baseH * s;
    const maxX = Math.max(0, (scaledW - VIEWPORT_SIZE) / 2);
    const maxY = Math.max(0, (scaledH - VIEWPORT_SIZE) / 2);
    return {
        tx: Math.min(Math.max(tx, -maxX), maxX),
        ty: Math.min(Math.max(ty, -maxY), maxY),
    };
}

interface ImageNaturalSize {
    width: number;
    height: number;
}

/**
 * Measure an image's intrinsic size via `Image.getSize`, wrapped as a Promise so
 * it can be a React Query `queryFn` (no component state / effects). Rejects on a
 * platform failure or degenerate dimensions so the query surfaces `isError`.
 * Mirrors the `measurePhotoDimensions` helper the photo grid uses.
 */
function measureImageSize(uri: string): Promise<ImageNaturalSize> {
    return new Promise<ImageNaturalSize>((resolve, reject) => {
        Image.getSize(
            uri,
            (width, height) => {
                if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
                    reject(new Error('Image reported invalid dimensions'));
                    return;
                }
                resolve({ width, height });
            },
            () => reject(new Error('Image measurement failed')),
        );
    });
}

/**
 * Lazy-loaded reference to the expo-image-manipulator module. The module is an
 * optional peer dep, so we resolve it on demand and surface a clean error
 * upstream if the consuming app has not installed it.
 */
interface ImageManipulatorModule {
    manipulateAsync: (
        uri: string,
        actions: Array<{
            crop?: { originX: number; originY: number; width: number; height: number };
            resize?: { width?: number; height?: number };
        }>,
        saveOptions?: { format?: 'jpeg' | 'png' | 'webp'; compress?: number },
    ) => Promise<{ uri: string; width: number; height: number }>;
    SaveFormat: { JPEG: 'jpeg'; PNG: 'png'; WEBP: 'webp' };
}

async function loadImageManipulator(): Promise<ImageManipulatorModule> {
    try {
        const mod = (await import('expo-image-manipulator')) as unknown as ImageManipulatorModule;
        if (!mod || typeof mod.manipulateAsync !== 'function') {
            throw new Error('expo-image-manipulator did not export manipulateAsync');
        }
        return mod;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
            `expo-image-manipulator is required for avatar cropping but is not installed: ${message}`,
        );
    }
}

interface PreparedManipulatorImage {
    uri: string;
    cleanup?: () => void;
}

function isCanvasLoadFailure(err: unknown): boolean {
    return (
        Platform.OS === 'web' &&
        typeof HTMLCanvasElement !== 'undefined' &&
        err instanceof HTMLCanvasElement
    );
}

const SENSITIVE_URI_PATTERN =
    /\b(?:file|content|ph|assets-library):\/\/\S+|\/(?:data|var|private|storage|sdcard|tmp)\/\S+/gi;

function sanitizeImageErrorMessage(message: string): string {
    return message.replace(SENSITIVE_URI_PATTERN, '[redacted-uri]');
}

function normalizeCropError(err: unknown): Error {
    if (isCanvasLoadFailure(err)) {
        return new Error('Image could not be loaded for cropping');
    }
    if (err instanceof Error) {
        return new Error(sanitizeImageErrorMessage(err.message || 'Failed to crop image'));
    }
    if (typeof err === 'string' && err.trim()) {
        return new Error(sanitizeImageErrorMessage(err.trim()));
    }
    return new Error('Failed to crop image');
}

async function prepareImageForManipulator(uri: string): Promise<PreparedManipulatorImage> {
    if (Platform.OS !== 'web' || !REMOTE_HTTP_URI_PATTERN.test(uri)) {
        return { uri };
    }

    let response: Response;
    try {
        response = await fetch(uri);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Image could not be loaded for cropping: ${message}`);
    }

    if (!response.ok) {
        throw new Error(`Image could not be loaded for cropping (${response.status})`);
    }

    const blob = await response.blob();
    if (blob.size <= 0) {
        throw new Error('Image could not be loaded for cropping');
    }

    const contentType = response.headers.get('content-type') || blob.type;
    if (contentType && !contentType.toLowerCase().startsWith('image/')) {
        throw new Error('Selected file is not an image');
    }

    const objectUrl = URL.createObjectURL(blob);
    return {
        uri: objectUrl,
        cleanup: () => URL.revokeObjectURL(objectUrl),
    };
}

/**
 * Haptic feedback wrapper. `expo-haptics` is an optional dependency — when not
 * installed (or on web), all calls degrade silently. We resolve the module once
 * and cache the promise so subsequent calls don't repeat the dynamic import.
 */
type HapticImpact = 'light' | 'medium' | 'heavy';
type HapticNotification = 'success' | 'warning' | 'error';
interface HapticsModule {
    impactAsync: (style: unknown) => Promise<void>;
    notificationAsync: (type: unknown) => Promise<void>;
    selectionAsync: () => Promise<void>;
    ImpactFeedbackStyle: { Light: unknown; Medium: unknown; Heavy: unknown };
    NotificationFeedbackType: { Success: unknown; Warning: unknown; Error: unknown };
}

let hapticsModulePromise: Promise<HapticsModule | null> | null = null;
function getHaptics(): Promise<HapticsModule | null> {
    if (Platform.OS === 'web') return Promise.resolve(null);
    if (hapticsModulePromise) return hapticsModulePromise;
    hapticsModulePromise = (async () => {
        try {
            const mod = (await import('expo-haptics')) as unknown as HapticsModule;
            if (!mod || typeof mod.impactAsync !== 'function') return null;
            return mod;
        } catch {
            return null;
        }
    })();
    return hapticsModulePromise;
}

async function hapticImpact(style: HapticImpact): Promise<void> {
    const h = await getHaptics();
    if (!h) return;
    const styleEnum =
        style === 'heavy'
            ? h.ImpactFeedbackStyle.Heavy
            : style === 'medium'
                ? h.ImpactFeedbackStyle.Medium
                : h.ImpactFeedbackStyle.Light;
    try {
        await h.impactAsync(styleEnum);
    } catch {
        // Silent — haptics are non-critical UX polish.
    }
}

async function hapticNotification(type: HapticNotification): Promise<void> {
    const h = await getHaptics();
    if (!h) return;
    const typeEnum =
        type === 'error'
            ? h.NotificationFeedbackType.Error
            : type === 'warning'
                ? h.NotificationFeedbackType.Warning
                : h.NotificationFeedbackType.Success;
    try {
        await h.notificationAsync(typeEnum);
    } catch {
        // Silent.
    }
}

async function hapticSelection(): Promise<void> {
    const h = await getHaptics();
    if (!h) return;
    try {
        await h.selectionAsync();
    } catch {
        // Silent.
    }
}

const AvatarCropScreen: React.FC<AvatarCropScreenProps> = ({
    dismiss,
    goBack,
    imageUri,
    imageFileId,
    sourceWidth,
    sourceHeight,
}) => {
    const theme = useTheme();
    const { t } = useI18n();
    const { oxyServices } = useOxy();
    // Reactive OS reduce-motion preference (useSyncExternalStore, no effect). Pins
    // the entrance spring off. Declared before `entrance` so its initial rest value
    // is correct under reduce-motion.
    const reduceMotion = useReduceMotion();

    // The "My Oxy files" source hands us a file ID instead of a ready URL. Its
    // download URL is usually private, so it must be resolved through the SDK
    // (which throws on failure). Resolving it HERE — not in the source list — is
    // what keeps the list from lingering on screen for the round-trip: this screen
    // shows its own spinner on the dark canvas while the URL resolves. A React
    // Query read (not an effect) so it stays declarative and cached.
    const shouldResolveFile = !imageUri && !!imageFileId;
    const sourceQuery = useQuery({
        queryKey: ['avatarCropSource', imageFileId],
        enabled: shouldResolveFile,
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
        queryFn: async () => {
            if (!imageFileId) {
                throw new Error('No file id to resolve for cropping');
            }
            const resolved = await oxyServices.assetGetUrl(imageFileId);
            if (!resolved?.url) {
                throw new Error('No download URL returned for the selected image');
            }
            return resolved.url;
        },
    });

    // The URL the cropper actually loads: the passed `imageUri`, else the URL the
    // file-ID query resolved. While it resolves, `effectiveUri` is undefined and
    // the stage shows its own spinner (never the empty state).
    const effectiveUri = imageUri ?? sourceQuery.data;
    const isResolvingSource = shouldResolveFile && !sourceQuery.data && !sourceQuery.isError;
    const sourceErrorMessage = sourceQuery.isError
        ? t('changeAvatar.errors.loadImageFailed') || 'Could not load the selected image'
        : null;

    // Natural size of the source image. Known up front (device/camera sources pass
    // the dimensions) OR measured lazily from `effectiveUri` via a React Query read
    // (no effect) — the same Image.getSize→useQuery pattern the photo grid uses.
    const hasPassedDimensions = !!(sourceWidth && sourceHeight);
    const measureQuery = useQuery({
        queryKey: ['avatarCropMeasure', effectiveUri],
        enabled: !!effectiveUri && !hasPassedDimensions,
        queryFn: () => {
            if (!effectiveUri) {
                throw new Error('No image to measure');
            }
            return measureImageSize(effectiveUri);
        },
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
        placeholderData: keepPreviousData,
    });
    const naturalSize = useMemo<ImageNaturalSize | null>(() => {
        if (sourceWidth && sourceHeight) return { width: sourceWidth, height: sourceHeight };
        return measureQuery.data ?? null;
    }, [sourceWidth, sourceHeight, measureQuery.data]);
    /** Measurement failed (bad dimensions / getSize error) — surfaced via the empty UI. */
    const measureErrorMessage = measureQuery.isError
        ? t('editProfile.toasts.cropMeasureFailed') || 'Could not measure the image'
        : null;

    const [isProcessing, setIsProcessing] = useState(false);
    const [zoomLabel, setZoomLabel] = useState('1.0');
    /** True when scale != MIN_SCALE OR translate != 0 — used to reveal the reset link. */
    const [isModified, setIsModified] = useState(false);

    // Shared values for the active gesture transform.
    const scale = useSharedValue(MIN_SCALE);
    const translateX = useSharedValue(0);
    const translateY = useSharedValue(0);

    // Entrance scale of the crop circle (pulse-in on mount).
    const entrance = useSharedValue(reduceMotion ? 1 : 0.95);
    /** 0..1 opacity for the rule-of-thirds grid and zoom chip. */
    const gridOpacity = useSharedValue(0);
    const zoomChipOpacity = useSharedValue(0);

    // Refs that mirror the latest committed shared values so the JS-side
    // confirm handler can read them without an extra `useSharedValue → react`
    // bridge. Updated by `runOnJS(commit*)` from the gesture worklets.
    const committedScale = useRef(MIN_SCALE);
    const committedTranslateX = useRef(0);
    const committedTranslateY = useRef(0);

    // Saved start values for relative gesture math.
    const savedScale = useSharedValue(MIN_SCALE);
    const savedTranslateX = useSharedValue(0);
    const savedTranslateY = useSharedValue(0);

    // Track whether we've already announced a min/max bound during the current
    // pinch so selection haptics don't fire on every frame.
    const hitMinRef = useRef(false);
    const hitMaxRef = useRef(false);

    // The image is rendered at "cover" relative to the viewport. We compute
    // `baseScale` so 1.0x means the image exactly covers the square; everything
    // larger than that is user-zoom.
    const baseFit = useMemo((): { width: number; height: number } | null => {
        if (!naturalSize) return null;
        const ratio = naturalSize.width / naturalSize.height;
        // Cover: the smaller dimension matches the viewport.
        if (ratio >= 1) {
            // Landscape — height fills viewport
            return { width: VIEWPORT_SIZE * ratio, height: VIEWPORT_SIZE };
        }
        return { width: VIEWPORT_SIZE, height: VIEWPORT_SIZE / ratio };
    }, [naturalSize]);

    // Entrance pulse, driven from the crop frame's ref callback (fires on mount)
    // rather than an effect — the media-cleanup `startEntrance` pattern. Reduce
    // motion pins the frame at rest; otherwise it springs in from 0.95→1. The
    // callback depends on `reduceMotion`, so if that preference resolves/flips the
    // callback re-runs with the node and re-pins (snap to 1) — matching the old
    // effect that snapped the entrance to rest when reduce-motion turned on.
    const startEntrance = useCallback(
        (node: unknown): void => {
            if (!node) return; // unmount
            if (reduceMotion) {
                entrance.value = 1;
                return;
            }
            entrance.value = withSpring(1, { damping: 14, stiffness: 180, mass: 0.9 });
        },
        [entrance, reduceMotion],
    );

    const commitTransform = useCallback((s: number, tx: number, ty: number) => {
        committedScale.current = s;
        committedTranslateX.current = tx;
        committedTranslateY.current = ty;
        const modified =
            Math.abs(s - MIN_SCALE) > 0.001 || Math.abs(tx) > 0.5 || Math.abs(ty) > 0.5;
        setIsModified(modified);
        setZoomLabel(s.toFixed(1));
    }, []);

    /** Show the rule-of-thirds grid; called from gesture worklets via runOnJS-free path. */
    const showGrid = useCallback(() => {
        gridOpacity.value = withTiming(1, { duration: 120, easing: Easing.out(Easing.quad) });
    }, [gridOpacity]);

    const hideGrid = useCallback(() => {
        gridOpacity.value = withDelay(
            GRID_FADE_DELAY_MS,
            withTiming(0, { duration: GRID_FADE_DURATION_MS, easing: Easing.in(Easing.quad) }),
        );
    }, [gridOpacity]);

    const showZoomChip = useCallback(() => {
        zoomChipOpacity.value = withTiming(1, { duration: 100 });
    }, [zoomChipOpacity]);

    const hideZoomChip = useCallback(() => {
        zoomChipOpacity.value = withDelay(
            ZOOM_CHIP_FADE_DELAY_MS,
            withTiming(0, { duration: ZOOM_CHIP_FADE_DURATION_MS }),
        );
    }, [zoomChipOpacity]);

    /** Dev-only ping fired once per gesture start so we can confirm in logs. */
    const logGestureStart = useCallback((kind: 'pan' | 'pinch') => {
        logger.debug(`gesture start: ${kind}`, { component: LOG_COMPONENT });
    }, []);

    const panGesture = useMemo(
        () =>
            Gesture.Pan()
                .minDistance(2)
                .onStart(() => {
                    'worklet';
                    savedTranslateX.value = translateX.value;
                    savedTranslateY.value = translateY.value;
                    runOnJS(showGrid)();
                    runOnJS(logGestureStart)('pan');
                })
                .onUpdate((event) => {
                    'worklet';
                    if (!baseFit) return;
                    const next = clampTranslation(
                        savedTranslateX.value + event.translationX,
                        savedTranslateY.value + event.translationY,
                        scale.value,
                        baseFit.width,
                        baseFit.height,
                    );
                    translateX.value = next.tx;
                    translateY.value = next.ty;
                })
                .onEnd(() => {
                    'worklet';
                    runOnJS(commitTransform)(scale.value, translateX.value, translateY.value);
                    runOnJS(hideGrid)();
                }),
        [
            baseFit,
            commitTransform,
            hideGrid,
            logGestureStart,
            savedTranslateX,
            savedTranslateY,
            scale,
            showGrid,
            translateX,
            translateY,
        ],
    );

    /** Imperative helpers invoked from worklets via runOnJS. Stable refs. */
    const resetPinchBounds = useCallback((): void => {
        hitMinRef.current = false;
        hitMaxRef.current = false;
    }, []);

    const updateZoomLabel = useCallback((s: number): void => {
        setZoomLabel(s.toFixed(1));
    }, []);

    const notifyMinBoundHit = useCallback((): void => {
        if (hitMinRef.current) return;
        hitMinRef.current = true;
        void hapticSelection();
    }, []);

    const notifyMaxBoundHit = useCallback((): void => {
        if (hitMaxRef.current) return;
        hitMaxRef.current = true;
        void hapticSelection();
    }, []);

    const pinchGesture = useMemo(
        () =>
            Gesture.Pinch()
                .onStart(() => {
                    'worklet';
                    savedScale.value = scale.value;
                    runOnJS(showGrid)();
                    runOnJS(showZoomChip)();
                    runOnJS(resetPinchBounds)();
                    runOnJS(logGestureStart)('pinch');
                })
                .onUpdate((event) => {
                    'worklet';
                    if (!baseFit) return;
                    const raw = savedScale.value * event.scale;
                    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
                    scale.value = nextScale;
                    // Re-clamp translation since the bounds depend on scale.
                    const clamped = clampTranslation(
                        translateX.value,
                        translateY.value,
                        nextScale,
                        baseFit.width,
                        baseFit.height,
                    );
                    translateX.value = clamped.tx;
                    translateY.value = clamped.ty;
                    runOnJS(updateZoomLabel)(nextScale);
                    // Selection haptic on first frame at min/max.
                    if (nextScale <= MIN_SCALE + 0.001 && raw < MIN_SCALE) {
                        runOnJS(notifyMinBoundHit)();
                    } else if (nextScale >= MAX_SCALE - 0.001 && raw > MAX_SCALE) {
                        runOnJS(notifyMaxBoundHit)();
                    }
                })
                .onEnd(() => {
                    'worklet';
                    runOnJS(commitTransform)(scale.value, translateX.value, translateY.value);
                    runOnJS(hideGrid)();
                    runOnJS(hideZoomChip)();
                }),
        [
            baseFit,
            commitTransform,
            hideGrid,
            hideZoomChip,
            logGestureStart,
            notifyMaxBoundHit,
            notifyMinBoundHit,
            resetPinchBounds,
            savedScale,
            scale,
            showGrid,
            showZoomChip,
            translateX,
            translateY,
            updateZoomLabel,
        ],
    );

    const composedGesture = useMemo(
        () => Gesture.Simultaneous(panGesture, pinchGesture),
        [panGesture, pinchGesture],
    );

    // Deps list every shared value the mapper reads so it re-runs on web (RN-Web
    // has no worklets plugin — a mapper omitting its driver SVs freezes at the
    // first frame, which would leave the button-driven zoom stuck). Native
    // auto-tracks and ignores the extra deps, so this is safe cross-platform.
    const imageAnimatedStyle = useAnimatedStyle(
        () => ({
            transform: [
                { translateX: translateX.value },
                { translateY: translateY.value },
                { scale: scale.value },
            ],
        }),
        [translateX, translateY, scale],
    );

    // `[entrance]` in deps so the ref-callback-driven entrance spring ticks on
    // RN-Web (no worklets plugin); native auto-tracks and ignores the extra dep.
    const cropFrameAnimatedStyle = useAnimatedStyle(
        () => ({
            transform: [{ scale: entrance.value }],
        }),
        [entrance],
    );

    const gridAnimatedStyle = useAnimatedStyle(() => ({
        opacity: gridOpacity.value,
    }));

    const zoomChipAnimatedStyle = useAnimatedStyle(() => ({
        opacity: zoomChipOpacity.value,
    }));

    const resetTransform = useCallback(() => {
        const duration = reduceMotion ? 0 : 220;
        scale.value = withTiming(MIN_SCALE, { duration });
        translateX.value = withTiming(0, { duration });
        translateY.value = withTiming(0, { duration });
        commitTransform(MIN_SCALE, 0, 0);
        void hapticImpact('light');
        AccessibilityInfo.announceForAccessibility(
            t('editProfile.crop.a11yResetAnnouncement') || 'Crop reset',
        );
    }, [commitTransform, reduceMotion, scale, t, translateX, translateY]);

    /**
     * Web zoom controls. A desktop pointer has no pinch, so the +/- buttons drive
     * the SAME `scale` shared value the pinch gesture does — clamped to the same
     * bounds, with translation re-clamped through the shared {@link clampTranslation}
     * helper so the image never leaves the viewport. Native keeps pinch (the
     * buttons are hidden there). Reduced motion collapses the tween to an instant
     * set. Reads the committed transform (refs) at press time, never during render.
     */
    const applyZoom = useCallback(
        (direction: 1 | -1) => {
            if (!baseFit || isProcessing) return;
            const current = committedScale.current;
            const target = Math.min(
                MAX_SCALE,
                Math.max(MIN_SCALE, current + direction * ZOOM_STEP),
            );
            if (Math.abs(target - current) < 0.001) {
                // Already at the bound — a soft selection tick, no transform change.
                void hapticSelection();
                return;
            }
            const clamped = clampTranslation(
                committedTranslateX.current,
                committedTranslateY.current,
                target,
                baseFit.width,
                baseFit.height,
            );
            const duration = reduceMotion ? 0 : ZOOM_BUTTON_DURATION_MS;
            scale.value = withTiming(target, { duration });
            translateX.value = withTiming(clamped.tx, { duration });
            translateY.value = withTiming(clamped.ty, { duration });
            commitTransform(target, clamped.tx, clamped.ty);
            void hapticImpact('light');
            // Mirror the pinch's transient chrome so the buttons feel identical.
            showGrid();
            hideGrid();
            showZoomChip();
            hideZoomChip();
        },
        [
            baseFit,
            commitTransform,
            hideGrid,
            hideZoomChip,
            isProcessing,
            reduceMotion,
            scale,
            showGrid,
            showZoomChip,
            translateX,
            translateY,
        ],
    );

    /**
     * Convert the on-screen transform into pixel-space crop coordinates
     * relative to the source image, then invoke expo-image-manipulator to
     * crop + resize to 512x512 JPEG.
     */
    const handleConfirm = useCallback(async () => {
        // Dev-only breadcrumb. Avoid logging `imageUri` so on-device file
        // paths don't leak into breadcrumb sinks that surface debug output.
        logger.debug(
            'handleConfirm start',
            { component: LOG_COMPONENT },
            {
                hasBaseFit: !!baseFit,
                hasNaturalSize: !!naturalSize,
                committedScale: committedScale.current,
                committedTranslateX: committedTranslateX.current,
                committedTranslateY: committedTranslateY.current,
            },
        );
        if (!effectiveUri || !baseFit || !naturalSize) {
            toast.error(
                t('editProfile.toasts.cropNotReady') || 'Image not ready yet',
            );
            return;
        }

        setIsProcessing(true);
        let preparedImageCleanup: (() => void) | undefined;
        try {
            const { manipulateAsync, SaveFormat } = await loadImageManipulator();

            const s = committedScale.current;
            const tx = committedTranslateX.current;
            const ty = committedTranslateY.current;

            // Visible viewport in *displayed image* pixel space (with scale applied):
            // The viewport is centered on the image origin, then offset by (-tx, -ty).
            const scaledImageWidth = baseFit.width * s;
            const scaledImageHeight = baseFit.height * s;

            // Top-left of viewport in displayed-pixel space:
            const viewportLeft = (scaledImageWidth - VIEWPORT_SIZE) / 2 - tx;
            const viewportTop = (scaledImageHeight - VIEWPORT_SIZE) / 2 - ty;

            // Convert to source-image pixel space:
            const sourcePerDisplay = naturalSize.width / scaledImageWidth;
            const cropX = Math.max(0, viewportLeft * sourcePerDisplay);
            const cropY = Math.max(0, viewportTop * sourcePerDisplay);
            const cropSize = Math.min(
                naturalSize.width - cropX,
                naturalSize.height - cropY,
                VIEWPORT_SIZE * sourcePerDisplay,
            );

            if (!Number.isFinite(cropSize) || cropSize <= 0) {
                throw new Error('Computed crop region is invalid');
            }

            // Dev-only crop coordinates. We log the derived crop region but
            // never the input URI — paths are PII-adjacent on some platforms.
            logger.debug(
                'manipulateAsync input',
                { component: LOG_COMPONENT },
                {
                    cropX,
                    cropY,
                    cropSize,
                    outputSize: OUTPUT_SIZE,
                },
            );

            const preparedImage = await prepareImageForManipulator(effectiveUri);
            preparedImageCleanup = preparedImage.cleanup;
            const result = await manipulateAsync(
                preparedImage.uri,
                [
                    {
                        crop: {
                            originX: cropX,
                            originY: cropY,
                            width: cropSize,
                            height: cropSize,
                        },
                    },
                    { resize: { width: OUTPUT_SIZE, height: OUTPUT_SIZE } },
                ],
                { format: SaveFormat.JPEG, compress: 0.85 },
            );

            // Log only the result's dimensions, never the on-disk URI.
            logger.debug(
                'manipulateAsync result',
                { component: LOG_COMPONENT },
                { width: result.width, height: result.height },
            );

            void hapticNotification('success');

            // Resolve the surface's present() promise with the cropped JPEG and
            // close it. The awaiting caller (`useAvatarPicker`) handles the
            // upload + any success toast.
            dismiss?.({
                uri: result.uri,
                width: result.width,
                height: result.height,
                mime: 'image/jpeg',
            });
        } catch (err) {
            const normalizedError = normalizeCropError(err);
            logger.error('handleConfirm failed', normalizedError, { component: LOG_COMPONENT });
            void hapticNotification('error');
            toast.error(
                normalizedError.message || t('editProfile.toasts.cropFailed') || 'Failed to crop image',
            );
        } finally {
            preparedImageCleanup?.();
            setIsProcessing(false);
        }
    }, [baseFit, effectiveUri, naturalSize, dismiss, t]);

    /**
     * The surface's "Use photo" CTA, declared through the Dialog header's
     * `primaryAction` (a real Bloom Button with a loading spinner + disabled
     * state) — the standardized trailing action, no bespoke node. Memoized so the
     * header does not thrash.
     */
    const donePrimaryAction = useMemo<SurfaceHeaderContent['primaryAction']>(
        () => ({
            label: t('editProfile.crop.confirm'),
            onPress: () => void handleConfirm(),
            disabled: isProcessing || !baseFit,
            loading: isProcessing,
        }),
        [t, handleConfirm, isProcessing, baseFit],
    );

    // No bar of our own: the surface owns the chrome. `goBack` pops back to the
    // ChangeAvatar source list (and dismisses the surface if this is somehow the
    // root frame), which is exactly Cancel.
    useSurfaceHeader({
        title: t('editProfile.crop.title'),
        largeTitle: false,
        primaryAction: donePrimaryAction,
        onBack: goBack,
    });

    const styles = useMemo(
        () =>
            StyleSheet.create({
                container: {
                    backgroundColor: theme.colors.background,
                },
                stage: {
                    backgroundColor: CANVAS_BG,
                    borderRadius: STAGE_RADIUS,
                    overflow: 'hidden',
                    // Top padding clears the zoom chip, which floats 44dp above
                    // the crop frame and would otherwise be clipped by `overflow`.
                    paddingTop: 60,
                    paddingBottom: 28,
                    paddingHorizontal: 16,
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                cropFrame: {
                    width: VIEWPORT_SIZE,
                    height: VIEWPORT_SIZE,
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                viewport: {
                    width: VIEWPORT_SIZE,
                    height: VIEWPORT_SIZE,
                    overflow: 'hidden',
                    borderRadius: VIEWPORT_SIZE / 2,
                    backgroundColor: '#1a1a1a',
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                image: {
                    width: baseFit?.width ?? VIEWPORT_SIZE,
                    height: baseFit?.height ?? VIEWPORT_SIZE,
                },
                // Outer mask: large square that overlays the canvas, with a
                // round transparent cutout in the middle. We achieve this with
                // four edge boxes around the circle (top/bottom/left/right) so
                // there's no need for SVG. Each box is 50% black.
                ringOverlay: {
                    position: 'absolute',
                    width: VIEWPORT_SIZE,
                    height: VIEWPORT_SIZE,
                    borderRadius: VIEWPORT_SIZE / 2,
                    borderWidth: RING_WIDTH,
                    borderColor: RING_COLOR,
                    // Subtle inner shadow approximated with a thin secondary border.
                    ...Platform.select({
                        web: {
                            boxShadow: 'inset 0 0 14px rgba(0,0,0,0.45)',
                        },
                        default: {},
                    }),
                },
                gridOverlay: {
                    position: 'absolute',
                    width: VIEWPORT_SIZE,
                    height: VIEWPORT_SIZE,
                    borderRadius: VIEWPORT_SIZE / 2,
                    overflow: 'hidden',
                    pointerEvents: 'none',
                },
                gridLineH: {
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    height: StyleSheet.hairlineWidth,
                    backgroundColor: 'rgba(255,255,255,0.45)',
                },
                gridLineV: {
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    width: StyleSheet.hairlineWidth,
                    backgroundColor: 'rgba(255,255,255,0.45)',
                },
                zoomChip: {
                    position: 'absolute',
                    top: -44,
                    alignSelf: 'center',
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: 'rgba(0,0,0,0.7)',
                    minWidth: 56,
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                zoomChipText: {
                    color: '#ffffff',
                    fontFamily: Platform.select({
                        ios: 'Menlo',
                        android: 'monospace',
                        default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    }),
                    fontSize: 12,
                    letterSpacing: 0.2,
                },
                helperBlock: {
                    paddingTop: 16,
                    alignItems: 'center',
                    gap: 8,
                },
                helper: {
                    fontSize: 13,
                    lineHeight: 18,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    maxWidth: 320,
                },
                resetLink: {
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                },
                resetLinkText: {
                    fontSize: 13,
                    color: theme.colors.primary,
                    textDecorationLine: 'underline',
                },
                emptyState: {
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingVertical: 48,
                },
                emptyLabel: {
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                },
            }),
        [baseFit, theme],
    );

    // Reset link reveal — only show when the image is not at the default
    // transform. Use derived display state to avoid mounting/unmounting jank.
    const resetLinkOpacity = isModified ? 1 : 0;

    // Zoom-button state is derived from `zoomLabel` (reactive state, set on every
    // commit) rather than the committed-scale ref, so it stays correct across
    // renders without reading mutable state during render. The +/- pair is web-only
    // (native has pinch).
    const currentZoom = Number.parseFloat(zoomLabel) || MIN_SCALE;
    const canZoomOut = currentZoom > MIN_SCALE + 0.001;
    const canZoomIn = currentZoom < MAX_SCALE - 0.001;
    const showZoomControls = Platform.OS === 'web';
    const zoomOutDisabled = !canZoomOut || !baseFit || isProcessing;
    const zoomInDisabled = !canZoomIn || !baseFit || isProcessing;

    // No source at all (and none resolving), a resolution failure, or a
    // measurement failure — render a minimal empty state. While a file ID is still
    // resolving, fall THROUGH to the stage so its own spinner shows, not this.
    // The surface's nav bar (back = cancel) is the only chrome needed here.
    if ((!effectiveUri && !isResolvingSource) || sourceErrorMessage || measureErrorMessage) {
        const emptyMessage = sourceErrorMessage
            ? sourceErrorMessage
            : measureErrorMessage
                ? measureErrorMessage
                : t('editProfile.crop.noImage');
        return (
            <View style={styles.container} className="px-screen-margin pb-space-24">
                <View style={styles.emptyState}>
                    <Text style={styles.emptyLabel}>{emptyMessage}</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container} className="px-screen-margin pb-space-24">
            <View style={styles.stage}>
                <Animated.View
                    ref={startEntrance}
                    style={[styles.cropFrame, cropFrameAnimatedStyle]}
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={t('editProfile.crop.a11yImage')}
                >
                    <GestureDetector gesture={composedGesture}>
                        <View style={styles.viewport}>
                            {baseFit && effectiveUri ? (
                                <Animated.Image
                                    source={{ uri: effectiveUri }}
                                    style={[styles.image, imageAnimatedStyle]}
                                    resizeMode="cover"
                                />
                            ) : (
                                <ActivityIndicator color="#ffffff" />
                            )}
                        </View>
                    </GestureDetector>

                    {/* White ring + inner shadow around the circle. */}
                    <View pointerEvents="none" style={styles.ringOverlay} />

                    {/* Rule-of-thirds grid overlay (fades in during gesture). */}
                    <Animated.View
                        pointerEvents="none"
                        style={[styles.gridOverlay, gridAnimatedStyle]}
                    >
                        <View style={[styles.gridLineH, { top: VIEWPORT_SIZE / 3 }]} />
                        <View style={[styles.gridLineH, { top: (VIEWPORT_SIZE * 2) / 3 }]} />
                        <View style={[styles.gridLineV, { left: VIEWPORT_SIZE / 3 }]} />
                        <View style={[styles.gridLineV, { left: (VIEWPORT_SIZE * 2) / 3 }]} />
                    </Animated.View>

                    {/* Floating zoom chip during pinch. */}
                    <Animated.View
                        pointerEvents="none"
                        style={[styles.zoomChip, zoomChipAnimatedStyle]}
                    >
                        <Text style={styles.zoomChipText}>
                            {t('editProfile.crop.zoom', { value: zoomLabel })}
                        </Text>
                    </Animated.View>
                </Animated.View>

                {/* Web-only +/- zoom controls (a desktop pointer has no pinch).
                    Styled with NativeWind to match the translucent zoom-chip
                    aesthetic; the full-width row is `box-none` so only the pill
                    takes pointer events and the rest of the circle stays pannable. */}
                {showZoomControls ? (
                    <View
                        className="absolute bottom-4 left-0 right-0 items-center"
                        pointerEvents="box-none"
                    >
                        <View className="flex-row overflow-hidden rounded-full bg-black/70">
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('editProfile.crop.zoomOut')}
                                accessibilityState={{ disabled: zoomOutDisabled }}
                                disabled={zoomOutDisabled}
                                onPress={() => applyZoom(-1)}
                                className={`h-10 w-[52px] items-center justify-center active:bg-white/10${
                                    zoomOutDisabled ? ' opacity-40' : ''
                                }`}
                            >
                                <Text className="text-white text-[22px] font-medium leading-[24px]">
                                    {'−'}
                                </Text>
                            </Pressable>
                            <View className="w-px self-stretch bg-white/25" />
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('editProfile.crop.zoomIn')}
                                accessibilityState={{ disabled: zoomInDisabled }}
                                disabled={zoomInDisabled}
                                onPress={() => applyZoom(1)}
                                className={`h-10 w-[52px] items-center justify-center active:bg-white/10${
                                    zoomInDisabled ? ' opacity-40' : ''
                                }`}
                            >
                                <Text className="text-white text-[22px] font-medium leading-[24px]">
                                    {'+'}
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                ) : null}
            </View>

            <View style={styles.helperBlock}>
                <Text style={styles.helper}>{t('editProfile.crop.helper')}</Text>
                <Pressable
                    accessibilityLabel={t('editProfile.crop.a11yReset')}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !isModified || isProcessing }}
                    onPress={resetTransform}
                    disabled={!isModified || isProcessing}
                    style={[styles.resetLink, { opacity: isProcessing ? 0.3 : resetLinkOpacity }]}
                >
                    <Text style={styles.resetLinkText}>{t('editProfile.crop.resetToCenter')}</Text>
                </Pressable>
            </View>
        </View>
    );
};

export default AvatarCropScreen;
