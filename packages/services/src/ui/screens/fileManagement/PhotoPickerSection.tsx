import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    ActivityIndicator,
    RefreshControl,
    FlatList,
    Platform,
    Animated,
    useWindowDimensions,
    type LayoutChangeEvent,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import type { FileMetadata } from '@oxyhq/core';
import { computePhotoGridLayout } from './photoGridLayout';
import FileLibraryError from './FileLibraryError';

/**
 * Haptic feedback wrapper. `expo-haptics` is an optional dependency — when not
 * installed (or on web), all calls degrade silently. We resolve the module
 * once and cache the promise so subsequent calls don't repeat the dynamic
 * import. Matches the pattern used by AvatarCropScreen.
 */
type HapticImpact = 'light' | 'medium' | 'heavy';
interface HapticsModule {
    impactAsync: (style: unknown) => Promise<void>;
    selectionAsync: () => Promise<void>;
    ImpactFeedbackStyle: { Light: unknown; Medium: unknown; Heavy: unknown };
}

let hapticsModulePromise: Promise<HapticsModule | null> | null = null;
const getHaptics = (): Promise<HapticsModule | null> => {
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
};

const hapticImpact = async (style: HapticImpact): Promise<void> => {
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
};

const hapticSelection = async (): Promise<void> => {
    const h = await getHaptics();
    if (!h) return;
    try {
        await h.selectionAsync();
    } catch {
        // Silent.
    }
};

/**
 * The picker renders inside a Bloom `<Dialog>` in NAV-HEADER mode with
 * `tone: 'onImage'` (bottom-sheet on narrow, centered card on `md+`). The Dialog
 * owns the shared gradient nav bar (Cancel / "Choose Photo" / Upload, wired by
 * `FileManagementScreen` through `useSurfaceHeader`). Because the tone is
 * `'onImage'`, the Dialog inserts NO nav-bar spacer above this content
 * (`DialogNavBarSpacer` collapses to nothing), so the black photo grid slides UP
 * under the floating translucent bar and reads EDGE-TO-EDGE — the Apple/Google
 * Photos immersive picker. The grid therefore takes the FULL `frameSize` height
 * and carries no top padding; only the pull-to-refresh spinner is offset so it
 * lands below the floating bar.
 *
 * `FLOATING_NAV_BAR_HEIGHT` mirrors Bloom's `DIALOG_NAV_BAR_HEIGHT` (not exported
 * from `@oxyhq/bloom/dialog`) — the height of the floating bar the refresh spinner
 * must clear.
 */
const FLOATING_NAV_BAR_HEIGHT = 52;

/**
 * Props for the dedicated photo picker view. Used by FileManagementScreen
 * only when `selectMode + image-only` is active. All callbacks are wired by
 * the parent — this component is purely presentational.
 */
export interface PhotoPickerViewProps {
    photos: FileMetadata[];
    selectedIds: Set<string>;
    multiSelect: boolean;
    maxSelection?: number;
    allowUpload: boolean;
    refreshing: boolean;
    uploading: boolean;
    isPickingDocument: boolean;
    hasMore: boolean;
    loadingMore: boolean;
    /**
     * Initial-load flag. While `true` AND no photos have arrived yet, the picker
     * renders its OWN loading skeleton (placement-aware grid of shimmer tiles)
     * instead of the empty state — so the loading UI matches the picker's shape
     * and container width, not the browse file-manager chrome.
     */
    loading: boolean;
    /** Terminal load failure (nothing cached) — renders a distinct error state. */
    loadError: boolean;
    /** Retry the failed list load (wired to the query's refetch). */
    onRetry: () => void;
    reduceMotion: boolean;
    getThumbUrl: (file: FileMetadata) => string | undefined;
    primaryColor: string;
    isOwner: boolean;
    onTogglePhoto: (photo: FileMetadata) => void;
    onPreviewPhoto: (photo: FileMetadata) => void;
    onUpload: () => void;
    onRefresh: () => void;
    onLoadMore: () => void;
    t: (key: string, vars?: Record<string, string | number>) => string;
}

/**
 * Photo-cell animation tuning. The cell uses RN's own `Animated` (NOT
 * Reanimated): its entrance is a staggered opacity fade — replacing the
 * Reanimated `entering={FadeIn}` LAYOUT animation, which cannot load on the
 * RN-Web build (no `react-native-worklets` babel plugin) and only warns +
 * no-ops there. RN `Animated` runs cross-platform: native-driven on device,
 * JS-driven on web (`useNativeDriver: false`), so the fade actually plays on
 * web instead of being skipped.
 */
const STAGGER_PER_CELL_MS = 15;
const MAX_TOTAL_STAGGER_MS = 800;
const ENTRANCE_DURATION_MS = 200;
/** Selection-ring pulse: a quick scale bump that springs back to rest. */
const RING_PULSE_PEAK = 1.05;
const RING_PULSE_UP_MS = 110;
const RING_SPRING_FRICTION = 9;
const RING_SPRING_TENSION = 120;
/**
 * The selection ring is an `Animated.View` (its pulse transform must be inline,
 * and `className` interop on `Animated.View` is not guaranteed under the RN-Web
 * build), so these mirror the `rounded-radius-8 border-[3px]` design tokens.
 */
const CELL_CORNER_RADIUS = 8; // `rounded-radius-8`
const SELECTION_RING_WIDTH = 3; // `border-[3px]`

/**
 * Loading-skeleton tile fill. The picker's backdrop is ALWAYS black regardless
 * of theme, so we cannot use Bloom `Skeleton.Box`'s theme default (`contrast50`,
 * which is a near-black gray on a dark theme → invisible on this backdrop). A
 * neutral dark gray reads as a photo placeholder on black; Bloom's shimmer still
 * pulses the tile opacity on top of it. `Skeleton.Box` applies `style` after its
 * own base, so this override wins while the animated opacity is preserved.
 */
const SKELETON_TILE_COLOR = '#26262A';
/** Minimum skeleton rows so the grid never looks empty on a very short panel. */
const SKELETON_MIN_ROWS = 4;

type PhotoPickerCellProps = {
    photo: FileMetadata;
    size: number;
    marginRight: number;
    marginBottom: number;
    isSelected: boolean;
    selectionIndex: number;
    dim: boolean;
    primaryColor: string;
    thumbUrl: string | undefined;
    enterIndex: number;
    reduceMotion: boolean;
    onPress: () => void;
    onLongPress: () => void;
    a11yLabel: string;
};

/**
 * A single photo cell. Memoized so re-renders during selection only touch
 * affected cells — selecting one photo must not redraw the whole grid.
 *
 * Apple Photos pattern: when any cell is selected, *non-selected* siblings fade
 * to 0.6 opacity to focus attention on the active selection. A staggered
 * entrance fade plays on mount; a spring pulse plays each time a cell enters the
 * selected state. Both animations are pinned off under reduce-motion, so the
 * one component covers both the animated and the reduced-motion paths.
 */
const PhotoPickerCell = React.memo(function PhotoPickerCell(props: PhotoPickerCellProps) {
    const {
        photo, size, marginRight, marginBottom, isSelected, selectionIndex,
        dim, primaryColor, thumbUrl, enterIndex, reduceMotion,
        onPress, onLongPress, a11yLabel,
    } = props;

    const delay = Math.min(enterIndex * STAGGER_PER_CELL_MS, MAX_TOTAL_STAGGER_MS);

    // Entrance fade, staggered by the cell's grid index. Started from the wrapper's
    // ref callback (fires on mount) rather than an effect. Reduce-motion pins
    // opacity at 1 and never animates.
    //
    // CRITICAL: `Animated.View` rebuilds its merged ref on every render, so React
    // re-invokes this callback on EVERY commit (not just mount) — and re-running
    // `Animated.timing().start()`/`setValue` each time drives a web re-render that
    // re-fires the ref → "Maximum update depth exceeded" once the grid has cells.
    // The `startedRef` latch makes it genuinely run-once per mount, breaking the
    // loop. (jest/react-test-renderer never exercises the Animated merged-ref path,
    // so this only reproduces in a real browser.)
    const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
    const startedRef = useRef(false);
    const startEntrance = useCallback((node: unknown) => {
        if (!node) return; // unmount
        if (startedRef.current) return; // ref re-fired on a later commit — already ran
        startedRef.current = true;
        if (reduceMotion) {
            opacity.setValue(1);
            return;
        }
        opacity.setValue(0);
        Animated.timing(opacity, {
            toValue: 1,
            duration: ENTRANCE_DURATION_MS,
            delay,
            useNativeDriver: Platform.OS !== 'web',
        }).start();
    }, [opacity, delay, reduceMotion]);

    // Selection-ring pulse: a quick scale bump that springs back to rest. The ring
    // renders ONLY while selected, so its own mount IS the "became selected"
    // signal — driven from the ring's ref callback, not an effect. Reduce-motion
    // holds the ring at rest scale. Same run-once latch as the entrance (the ring's
    // `Animated.View` re-fires this ref every commit too) — reset on unmount so a
    // later re-selection pulses again.
    const ringScale = useRef(new Animated.Value(1)).current;
    const pulsedRef = useRef(false);
    const startRingPulse = useCallback((node: unknown) => {
        if (!node) {
            pulsedRef.current = false; // ring unmounted (deselected) — arm the next pulse
            return;
        }
        if (pulsedRef.current) return; // ref re-fired on a later commit — already pulsed
        pulsedRef.current = true;
        ringScale.setValue(1);
        if (reduceMotion) return;
        Animated.sequence([
            Animated.timing(ringScale, {
                toValue: RING_PULSE_PEAK,
                duration: RING_PULSE_UP_MS,
                useNativeDriver: Platform.OS !== 'web',
            }),
            Animated.spring(ringScale, {
                toValue: 1,
                friction: RING_SPRING_FRICTION,
                tension: RING_SPRING_TENSION,
                useNativeDriver: Platform.OS !== 'web',
            }),
        ]).start();
    }, [ringScale, reduceMotion]);

    return (
        // The animated wrapper carries the entrance opacity + the layout box as
        // inline `style`: animated values must be inline, and the box's
        // size/margins are runtime pixels className cannot express. `className`
        // drives the static chrome below (`flex-1` fills this fixed-size box).
        <Animated.View
            ref={startEntrance}
            style={{
                width: size,
                height: size,
                marginRight,
                marginBottom,
                position: 'relative',
                opacity,
            }}
        >
            <TouchableOpacity
                activeOpacity={0.85}
                onPress={onPress}
                onLongPress={onLongPress}
                className="flex-1"
                accessibilityRole="button"
                accessibilityLabel={a11yLabel}
                accessibilityState={{ selected: isSelected }}
            >
                <View
                    className={`flex-1 rounded-radius-8 overflow-hidden bg-[#111111]${dim ? ' opacity-60' : ''}`}
                >
                    <ExpoImage
                        source={{ uri: thumbUrl }}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="cover"
                        transition={120}
                        cachePolicy="memory-disk"
                        accessibilityLabel={photo.filename}
                    />
                </View>
                {isSelected && (
                    <Animated.View
                        ref={startRingPulse}
                        style={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            left: 0,
                            borderRadius: CELL_CORNER_RADIUS,
                            borderWidth: SELECTION_RING_WIDTH,
                            borderColor: primaryColor,
                            transform: [{ scale: ringScale }],
                            pointerEvents: 'none',
                        }}
                    />
                )}
                {isSelected && (
                    <View
                        className="absolute top-1.5 right-1.5 min-w-[22px] h-[22px] px-1.5 rounded-full items-center justify-center"
                        style={{ backgroundColor: primaryColor, pointerEvents: 'none' }}
                    >
                        <Text className="text-white text-[12px] font-bold leading-[14px]">
                            {selectionIndex > 0 ? String(selectionIndex) : ''}
                        </Text>
                    </View>
                )}
            </TouchableOpacity>
        </Animated.View>
    );
});

const PhotoPickerView: React.FC<PhotoPickerViewProps> = ({
    photos,
    selectedIds,
    multiSelect,
    maxSelection,
    allowUpload,
    refreshing,
    uploading,
    isPickingDocument,
    hasMore,
    loadingMore,
    loading,
    loadError,
    onRetry,
    reduceMotion,
    getThumbUrl,
    primaryColor,
    isOwner,
    onTogglePhoto,
    onPreviewPhoto,
    onUpload,
    onRefresh,
    onLoadMore,
    t,
}) => {
    // Grid sizing width. We PREFER the measured grid-container width (the
    // bottom-sheet content width) so tiles size to the sheet, not the device
    // screen — on wide viewports the sheet is centered/narrower than the screen.
    // But we must NEVER gate the whole grid on that measurement: `onLayout` is
    // unreliable on web (react-native-css can suppress it), and a grid that only
    // renders after a measurement can stay blank forever. So we fall back to the
    // window width until a real measurement arrives — the grid ALWAYS renders,
    // then snaps to the sheet width once `onLayout` reports it. The measured
    // wrapper carries ONLY a `style` (no `className`) to maximise the chance
    // `onLayout` fires on web.
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const [gridWidth, setGridWidth] = useState(0);
    const onRootLayout = useCallback((e: LayoutChangeEvent) => {
        const w = Math.round(e.nativeEvent.layout.width);
        setGridWidth((prev) => (prev === w ? prev : w));
    }, []);

    // The picker FILLS its panel: the surface morphs the container UP to an
    // explicit large target (`frameSize.heightRatio: 0.9` in `surfaceRegistry`),
    // and this root takes that SAME 0.9-of-viewport height. Under `tone:'onImage'`
    // the Dialog inserts NO nav-bar spacer, so the grid uses the FULL morph target
    // (no `-52`) and slides up under the floating bar, edge-to-edge, within the
    // panel's `maxHeightRatio: 0.9` cap. A `flex: 1` root can't fill (no definite
    // bound propagates through the sheet's flex chain at rest, where the panel is
    // height:auto), so the fixed height is required; the FlatList scrolls within
    // it. Keep the 0.9 ratio in sync with the picker's `frameSize` in
    // `surfaceRegistry.ts`.
    const panelHeight = useMemo(() => Math.round(windowHeight * 0.9), [windowHeight]);
    const rootStyle = useMemo(() => ({ height: panelHeight }), [panelHeight]);

    const effectiveWidth = gridWidth > 0 ? gridWidth : windowWidth;
    const { columns, cellSize, gutter } = useMemo(
        () => computePhotoGridLayout(effectiveWidth),
        [effectiveWidth],
    );

    // How many shimmer tiles the loading skeleton renders: enough FULL rows to
    // fill the panel down to (but never past) its `maxHeight` cap, so the panel
    // hugs the skeleton content instead of overflowing or scrolling. `floor`
    // keeps the last row whole; `SKELETON_MIN_ROWS` guards a very short panel.
    const skeletonTileCount = useMemo(() => {
        const rowHeight = cellSize + gutter;
        if (rowHeight <= 0) return columns * SKELETON_MIN_ROWS;
        const available = Math.max(0, panelHeight - FLOATING_NAV_BAR_HEIGHT);
        const rows = Math.max(SKELETON_MIN_ROWS, Math.floor(available / rowHeight));
        return rows * columns;
    }, [cellSize, gutter, columns, panelHeight]);

    // Map selectedIds → 1-based selection order for the badge. We freeze a
    // stable order at the time of selection: the order is the insertion
    // order of the Set (which JS preserves natively).
    const selectionOrder = useMemo(() => {
        const map = new Map<string, number>();
        let i = 1;
        for (const id of selectedIds) {
            map.set(id, i++);
        }
        return map;
    }, [selectedIds]);

    const hasAnySelection = selectedIds.size > 0;

    const isEmpty = photos.length === 0;
    const atSelectionLimit =
        multiSelect && maxSelection != null && selectedIds.size >= maxSelection;

    const handleCellPress = useCallback(
        (photo: FileMetadata) => {
            if (Platform.OS !== 'web') {
                void hapticImpact('light');
            }
            onTogglePhoto(photo);
        },
        [onTogglePhoto],
    );

    const handleCellLongPress = useCallback(
        (photo: FileMetadata) => {
            if (Platform.OS !== 'web') {
                void hapticSelection();
            }
            onPreviewPhoto(photo);
        },
        [onPreviewPhoto],
    );

    // FlatList renderItem: each cell knows its enterIndex (for stagger).
    const renderItem = useCallback(
        ({ item, index }: { item: FileMetadata; index: number }) => {
            const isSelected = selectedIds.has(item.id);
            const selIndex = isSelected ? (selectionOrder.get(item.id) || 0) : 0;
            // Last column gets no right margin; last row no bottom margin
            // (FlatList handles row breaks via numColumns).
            const isLastInRow = (index + 1) % columns === 0;
            const a11yLabel = t(
                isSelected
                    ? 'fileManagement.a11y.photoCellSelected'
                    : 'fileManagement.a11y.photoCellUnselected',
                { name: item.filename || 'photo' },
            );
            return (
                <PhotoPickerCell
                    photo={item}
                    size={cellSize}
                    marginRight={isLastInRow ? 0 : gutter}
                    marginBottom={gutter}
                    isSelected={isSelected}
                    selectionIndex={selIndex}
                    dim={
                        multiSelect
                        && !isSelected
                        && (hasAnySelection || atSelectionLimit)
                    }
                    primaryColor={primaryColor}
                    thumbUrl={getThumbUrl(item)}
                    enterIndex={index}
                    reduceMotion={reduceMotion}
                    onPress={() => handleCellPress(item)}
                    onLongPress={() => handleCellLongPress(item)}
                    a11yLabel={a11yLabel}
                />
            );
        },
        [
            selectedIds, selectionOrder, columns, cellSize, gutter, multiSelect, hasAnySelection,
            atSelectionLimit, primaryColor, getThumbUrl, reduceMotion, handleCellPress,
            handleCellLongPress, t,
        ],
    );

    const keyExtractor = useCallback((item: FileMetadata) => item.id, []);

    const listFooter = useMemo(() => {
        if (!loadingMore) return null;
        return (
            <View className="py-space-16 items-center">
                <ActivityIndicator size="small" color="#FFFFFF" />
            </View>
        );
    }, [loadingMore]);

    const handleEndReached = useCallback(() => {
        if (loadingMore || !hasMore) return;
        onLoadMore();
    }, [loadingMore, hasMore, onLoadMore]);

    return (
        // Measured wrapper: `style`-only (no className) so RN-Web fires onLayout.
        // `rootStyle` is placement-aware — a `maxHeight` cap that gives the
        // FlatList a bounded scroll region while letting a short grid hug its
        // content (see the `rootStyle` derivation). It must NOT carry a className
        // (that can suppress web `onLayout`).
        <View style={rootStyle} onLayout={onRootLayout}>
            {/* `min-h-0` lets this flex child shrink below its content on web so
                the FlatList gets a bounded scroll region inside the height-capped
                root (the CSS flexbox `min-height:auto` trap; a no-op on native,
                where Yoga already defaults min-height to 0). */}
            <View className="flex-1 min-h-0 bg-black">
                {/* Photo grid — full-bleed black canvas CONTENT under the shared
                    Dialog nav bar (the Dialog reserves the bar's height above this
                    and its gradient fades a little further down; the top padding
                    clears that fade). */}
                {isEmpty && loadError ? (
                    /* Terminal load failure — a DISTINCT error surface (not the
                       empty state), centered in the immersive frame. Retry re-runs
                       the list query. */
                    <View className="flex-1 items-center justify-center">
                        <FileLibraryError
                            title={t('fileManagement.loadError.title')}
                            description={t('fileManagement.loadError.description')}
                            retryLabel={t('fileManagement.retry')}
                            onRetry={onRetry}
                            iconColor="#FF6B6B"
                            titleColor="#FFFFFF"
                            descriptionColor="rgba(255,255,255,0.7)"
                            buttonColor={primaryColor}
                        />
                    </View>
                ) : isEmpty && loading ? (
                    /* Loading skeleton — the picker's OWN shape: shimmer tiles laid
                       out with the SAME placement-aware geometry the real grid uses
                       (`computePhotoGridLayout(effectiveWidth)`), edge-to-edge under
                       the floating bar. `flexWrap` breaks rows exactly at `columns`
                       because the last tile in each row carries no right margin (a
                       full row + gutters fits the measured width by construction). */
                    <View
                        style={{ flexDirection: 'row', flexWrap: 'wrap', pointerEvents: 'none' }}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    >
                        {Array.from({ length: skeletonTileCount }, (_, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size skeleton grid, order never changes
                            <Skeleton.Box
                                key={`skeleton-${index}`}
                                width={cellSize}
                                height={cellSize}
                                borderRadius={CELL_CORNER_RADIUS}
                                style={{
                                    marginRight: (index + 1) % columns === 0 ? 0 : gutter,
                                    marginBottom: gutter,
                                    backgroundColor: SKELETON_TILE_COLOR,
                                }}
                            />
                        ))}
                    </View>
                ) : isEmpty ? (
                    <View className="flex-1 items-center justify-center px-space-32">
                        <View className="opacity-30 mb-space-16">
                            <MaterialCommunityIcons name="image-outline" size={64} color="#FFFFFF" />
                        </View>
                        <Text className="text-white text-[17px] font-semibold text-center mb-1.5">
                            {t('fileManagement.photoPicker.emptyTitle')}
                        </Text>
                        <Text className="text-white text-[14px] font-normal text-center opacity-70 mb-space-24">
                            {t('fileManagement.photoPicker.emptySubtitle')}
                        </Text>
                        {isOwner && allowUpload && (
                            <TouchableOpacity
                                className="flex-row items-center gap-space-8 px-[22px] py-space-12 rounded-full"
                                style={{ backgroundColor: primaryColor }}
                                onPress={onUpload}
                                disabled={uploading || isPickingDocument}
                                accessibilityRole="button"
                                accessibilityLabel={t('fileManagement.uploadPhoto')}
                                accessibilityState={{ busy: uploading || isPickingDocument }}
                            >
                                {(uploading || isPickingDocument) ? (
                                    <ActivityIndicator size="small" color="#FFFFFF" />
                                ) : (
                                    <>
                                        <Ionicons name="cloud-upload" size={18} color="#FFFFFF" />
                                        <Text className="text-white text-[15px] font-semibold">
                                            {t('fileManagement.uploadPhoto')}
                                        </Text>
                                    </>
                                )}
                            </TouchableOpacity>
                        )}
                    </View>
                ) : (
                        <FlatList
                            key={`cols-${columns}`}
                            data={photos}
                            renderItem={renderItem}
                            keyExtractor={keyExtractor}
                            numColumns={columns}
                            className="flex-1 min-h-0"
                            contentContainerClassName="pb-space-24"
                            showsVerticalScrollIndicator={false}
                            refreshControl={
                                <RefreshControl
                                    refreshing={refreshing}
                                    onRefresh={onRefresh}
                                    tintColor="#FFFFFF"
                                    colors={[primaryColor]}
                                    progressViewOffset={FLOATING_NAV_BAR_HEIGHT}
                                />
                            }
                            onEndReached={handleEndReached}
                            onEndReachedThreshold={0.4}
                            ListFooterComponent={listFooter}
                            removeClippedSubviews={Platform.OS !== 'web'}
                            initialNumToRender={Math.max(12, columns * 6)}
                            windowSize={9}
                        />
                )}
            </View>
        </View>
    );
};

export default PhotoPickerView;
