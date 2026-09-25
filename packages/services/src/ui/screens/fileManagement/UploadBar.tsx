import type React from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { Card } from '@oxy.so/bloom/card';
import { Loading } from '@oxy.so/bloom/loading';
import { Meter } from '@oxy.so/bloom/stat-bar';

export interface UploadBarProps {
    uploadProgress: { current: number; total: number } | null;
    t: (key: string, vars?: Record<string, string | number>) => string;
}

/** Upload state is app-owned; surface, spinner and determinate meter are Bloom. */
const UploadBar: React.FC<UploadBarProps> = ({ uploadProgress, t }) => (
    <View pointerEvents="none" className="absolute top-[72px] left-0 right-0 items-center z-50">
        <Card appearance="solid" elevation="s" radius="radius-max" className="flex-row items-center px-3.5 py-2.5 gap-2.5 min-w-[200px]">
            <View className="flex-1 gap-1.5">
                <Text variant="caption-1-medium">
                    {t('fileManagement.uploading')}{uploadProgress ? ` ${uploadProgress.current}/${uploadProgress.total}` : '…'}
                </Text>
                {uploadProgress && uploadProgress.total > 0 ? (
                    <Meter value={uploadProgress.current} max={uploadProgress.total} height={3}
                        accessibilityLabel={t('fileManagement.uploading')} />
                ) : null}
            </View>
            <Loading size="small" />
        </Card>
    </View>
);

export default UploadBar;
