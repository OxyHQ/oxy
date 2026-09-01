import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { toast } from '@oxyhq/bloom/toast';
import {
    SegmentedControl,
    SegmentedControlItem,
    SegmentedControlItemText,
} from '@oxyhq/bloom/segmented-control';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Loading } from '@oxyhq/bloom/loading';
import { Text } from '@oxyhq/bloom/typography';
import { SettingsIcon } from '../components/SettingsIcon';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';

type SavesTab = 'saves' | 'collections';

interface SavedItem {
    id: string;
    title: string;
    type: 'post' | 'collection';
    savedAt: Date;
}

interface Collection {
    id: string;
    name: string;
    description?: string;
    itemCount?: number;
    createdAt?: Date;
    updatedAt?: Date;
}

const SavesCollectionsScreen: React.FC<BaseScreenProps> = ({
    onClose,
    goBack,
}) => {
    // Saves & collections belong to the ACTIVE account (the org/project/bot when
    // switched, else the personal user).
    const { oxyServices, user } = useOxy();
    const { t } = useI18n();

    useSurfaceHeader({ title: t('saves.title') || 'Saves & Collections' });
    const bloomTheme = useTheme();
    const [savedItems, setSavedItems] = useState<SavedItem[]>([]);
    const [collections, setCollections] = useState<Collection[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<SavesTab>('saves');

    // Load saved items and collections from API
    useEffect(() => {
        const loadData = async () => {
            try {
                setIsLoading(true);
                if (user?.id && oxyServices) {
                    const [saved, cols] = await Promise.all([
                        oxyServices.getSavedItems(user.id),
                        oxyServices.getCollections(user.id),
                    ]);
                    setSavedItems(saved.map((item) => ({
                        id: item.id,
                        title: item.title,
                        type: item.itemType === 'post' ? 'post' : 'collection',
                        savedAt: new Date(item.createdAt),
                    })));
                    setCollections(cols.map((col) => ({
                        id: col.id,
                        name: col.name,
                        description: col.description,
                        itemCount: col.itemCount,
                        createdAt: col.createdAt ? new Date(col.createdAt) : undefined,
                    })));
                }
            } catch (error) {
                toast.error(t('saves.loadError') || 'Failed to load saved items');
            } finally {
                setIsLoading(false);
            }
        };

        loadData();
    }, [user?.id, oxyServices, t]);

    const formatDate = (date: Date) => {
        return date.toLocaleDateString();
    };

    return (
        <>

            {/* Tabs */}
            <View className="px-screen-margin py-space-12 border-b border-border">
                <SegmentedControl<SavesTab>
                    label={t('saves.title') || 'Saves & Collections'}
                    type="tabs"
                    value={activeTab}
                    onChange={setActiveTab}
                >
                    <SegmentedControlItem value="saves">
                        <SegmentedControlItemText>
                            {t('saves.tabs.saves') || 'Saves'}
                        </SegmentedControlItemText>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="collections">
                        <SegmentedControlItemText>
                            {t('saves.tabs.collections') || 'Collections'}
                        </SegmentedControlItemText>
                    </SegmentedControlItem>
                </SegmentedControl>
            </View>

            <View className="px-screen-margin pb-space-24">
                    {isLoading ? (
                        <Loading
                            size="large"
                            color={bloomTheme.colors.text}
                            text={t('saves.loading') || 'Loading...'}
                        />
                    ) : activeTab === 'saves' ? (
                        savedItems.length === 0 ? (
                            <Text className="text-text-secondary text-center p-space-40">
                                {t('saves.empty') || 'No saved items yet'}
                            </Text>
                        ) : (
                            <SettingsListGroup title={t('saves.savedItems') || 'Saved Items'}>
                                {savedItems.map((item) => (
                                    <SettingsListItem
                                        key={item.id}
                                        icon={
                                            <SettingsIcon
                                                name={item.type === 'post' ? 'file-document-outline' : 'folder'}
                                                color={item.type === 'post' ? bloomTheme.colors.primary : bloomTheme.colors.info}
                                            />
                                        }
                                        title={item.title}
                                        description={formatDate(item.savedAt)}
                                    />
                                ))}
                            </SettingsListGroup>
                        )
                    ) : (
                        collections.length === 0 ? (
                            <Text className="text-text-secondary text-center p-space-40">
                                {t('saves.noCollections') || 'No collections yet'}
                            </Text>
                        ) : (
                            <SettingsListGroup title={t('saves.collections') || 'Collections'}>
                                {collections.map((collection) => (
                                    <SettingsListItem
                                        key={collection.id}
                                        icon={<SettingsIcon name="folder" color={bloomTheme.colors.info} />}
                                        title={collection.name}
                                        description={`${collection.itemCount || 0} items`}
                                    />
                                ))}
                            </SettingsListGroup>
                        )
                    )}
                </View>
        </>
    );
};

export default React.memo(SavesCollectionsScreen);
