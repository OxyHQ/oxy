/**
 * Labels subscreen — create, rename, recolor, delete custom labels.
 *
 * Alia-style layout: a grid of existing labels rendered as visual chips
 * (color dot + name + inline edit/delete actions), and a create-block at
 * the bottom that combines name input + color swatch picker + add button.
 */

import React, { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Button } from '@oxyhq/bloom/button';
import { Text } from '@oxyhq/bloom/typography';
import { useTheme } from '@oxyhq/bloom/theme';
import { Admonition } from '@oxyhq/bloom/admonition';
import { Dialog, useDialogControl , toast } from '@oxyhq/bloom';
import {
  Pin_Stroke2_Corner0_Rounded,
  Pencil_Stroke2_Corner0_Rounded,
  Trash_Stroke2_Corner0_Rounded,
  PlusSmall_Stroke2_Corner0_Rounded,
  CircleCheck_Stroke2_Corner0_Rounded,
  ColorPalette_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';

import { useColors } from '@/constants/theme';
import { SectionHeader } from '@/components/settings/SectionHeader';
import {
  useLabels,
  useCreateLabel,
  useUpdateLabel,
  useDeleteLabel,
} from '@/hooks/queries/useLabels';

const LABEL_COLORS = [
  '#4285f4', '#ea4335', '#fbbc04', '#34a853', '#ff6d01',
  '#46bdc6', '#7b1fa2', '#c2185b', '#795548', '#607d8b',
] as const;

const DEFAULT_NEW_COLOR = LABEL_COLORS[0];

export function LabelsSection() {
  const colors = useColors();
  const theme = useTheme();
  const { data: labels = [] } = useLabels();
  const createLabel = useCreateLabel();
  const updateLabel = useUpdateLabel();
  const deleteLabel = useDeleteLabel();

  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState<string>(DEFAULT_NEW_COLOR);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editingLabelName, setEditingLabelName] = useState('');

  const deleteConfirm = useDialogControl();
  const [labelPendingDelete, setLabelPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const handleCreate = useCallback(() => {
    const name = newLabelName.trim();
    if (!name) return;
    createLabel.mutate(
      { name, color: newLabelColor },
      {
        onSuccess: () => {
          setNewLabelName('');
          setNewLabelColor(DEFAULT_NEW_COLOR);
          toast.success('Label created.');
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : 'Failed to create label.';
          toast.error(message);
        },
      },
    );
  }, [newLabelName, newLabelColor, createLabel]);

  const handleUpdateName = useCallback(
    (labelId: string) => {
      const name = editingLabelName.trim();
      if (!name) return;
      updateLabel.mutate(
        { labelId, updates: { name } },
        {
          onSuccess: () => {
            setEditingLabelId(null);
            setEditingLabelName('');
          },
          onError: (err: unknown) => {
            const message = err instanceof Error ? err.message : 'Failed to update label.';
            toast.error(message);
          },
        },
      );
    },
    [editingLabelName, updateLabel],
  );

  const handleDelete = useCallback(() => {
    if (!labelPendingDelete) return;
    deleteLabel.mutate(labelPendingDelete.id, {
      onSuccess: () => {
        toast.success('Label deleted.');
        setLabelPendingDelete(null);
      },
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to delete label.';
        toast.error(message);
      },
    });
  }, [labelPendingDelete, deleteLabel]);

  const inputStyle = {
    color: colors.text,
    backgroundColor: theme.colors.background,
    borderColor: colors.border,
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.root}
    >
      {/* Existing labels */}
      <View style={styles.subsection}>
        <SectionHeader icon={Pin_Stroke2_Corner0_Rounded} title="Your labels" />
        {labels.length === 0 ? (
          <Admonition type="info">
            No labels yet. Create your first one below to organize messages.
          </Admonition>
        ) : (
          <View style={[styles.labelList, { borderColor: colors.border }]}>
            {labels.map((label, idx) => {
              const isEditing = editingLabelId === label._id;
              return (
                <View
                  key={label._id}
                  style={[
                    styles.labelRow,
                    idx > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: colors.border,
                    },
                  ]}
                >
                  <View style={[styles.labelDot, { backgroundColor: label.color }]} />
                  {isEditing ? (
                    <>
                      <TextInput
                        value={editingLabelName}
                        onChangeText={setEditingLabelName}
                        autoFocus
                        onSubmitEditing={() => handleUpdateName(label._id)}
                        returnKeyType="done"
                        placeholder="Label name"
                        placeholderTextColor={colors.secondaryText}
                        style={[styles.labelEditInput, inputStyle]}
                      />
                      <Pressable
                        onPress={() => handleUpdateName(label._id)}
                        style={styles.iconBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Save label name"
                      >
                        <CircleCheck_Stroke2_Corner0_Rounded
                          size="md"
                          style={{ color: theme.colors.primary }}
                        />
                      </Pressable>
                    </>
                  ) : (
                    <>
                      <Text style={[styles.labelName, { color: colors.text }]} numberOfLines={1}>
                        {label.name}
                      </Text>
                      {/* System labels ship with the product: no rename, no
                          delete, and the server rejects both anyway. */}
                      {label.system ? (
                        <Text style={[styles.systemTag, { color: colors.secondaryText }]}>
                          Built-in
                        </Text>
                      ) : (
                        <>
                          <Pressable
                            onPress={() => {
                              setEditingLabelId(label._id);
                              setEditingLabelName(label.name);
                            }}
                            style={styles.iconBtn}
                            accessibilityRole="button"
                            accessibilityLabel={`Rename ${label.name}`}
                          >
                            <Pencil_Stroke2_Corner0_Rounded
                              size="sm"
                              style={{ color: colors.icon }}
                            />
                          </Pressable>
                          <Pressable
                            onPress={() => {
                              setLabelPendingDelete({ id: label._id, name: label.name });
                              deleteConfirm.open();
                            }}
                            style={styles.iconBtn}
                            accessibilityRole="button"
                            accessibilityLabel={`Delete ${label.name}`}
                          >
                            <Trash_Stroke2_Corner0_Rounded
                              size="sm"
                              style={{ color: colors.error }}
                            />
                          </Pressable>
                        </>
                      )}
                    </>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </View>

      {/* Create label */}
      <View style={styles.subsection}>
        <SectionHeader icon={ColorPalette_Stroke2_Corner0_Rounded} title="Create label" />
        <View style={styles.swatchRow}>
          {LABEL_COLORS.map((c) => {
            const isActive = newLabelColor === c;
            return (
              <Pressable
                key={c}
                onPress={() => setNewLabelColor(c)}
                accessibilityRole="button"
                accessibilityLabel={`Pick ${c}`}
                style={[
                  styles.swatch,
                  { backgroundColor: c, borderColor: isActive ? colors.text : 'transparent' },
                ]}
              />
            );
          })}
        </View>
        <TextInput
          value={newLabelName}
          onChangeText={setNewLabelName}
          placeholder="New label name"
          placeholderTextColor={colors.secondaryText}
          onSubmitEditing={handleCreate}
          returnKeyType="done"
          style={[styles.createInput, inputStyle]}
        />
        <Button
          onPress={handleCreate}
          disabled={!newLabelName.trim() || createLabel.isPending}
          icon={<PlusSmall_Stroke2_Corner0_Rounded size="sm" style={{ color: '#FFFFFF' }} />}
          iconPosition="left"
        >
          {createLabel.isPending ? 'Creating…' : 'Add label'}
        </Button>
      </View>

      <Dialog
        control={deleteConfirm}
        title="Delete label?"
        description={
          labelPendingDelete
            ? `"${labelPendingDelete.name}" will be removed from any messages it's applied to.`
            : ''
        }
        actions={[
          { label: 'Delete', color: 'destructive', onPress: handleDelete },
          { label: 'Cancel', color: 'cancel' },
        ]}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    gap: 28,
  },
  subsection: {
    gap: 12,
  },
  labelList: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  labelDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  systemTag: {
    fontSize: 12,
  },
  labelName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
  labelEditInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
  },
  iconBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
  },
  createInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
});
