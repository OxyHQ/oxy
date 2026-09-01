import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@oxyhq/bloom';
import { useEmailStore } from '@/hooks/useEmail';
import { emailKeys } from '@/hooks/queries/queryKeys';
import type { Label } from '@/services/emailApi';

const LABELS_KEY = emailKeys.labels;

export function useLabels() {
  const api = useEmailStore((s) => s._api);

  return useQuery<Label[]>({
    queryKey: LABELS_KEY,
    queryFn: async () => {
      if (!api) throw new Error('Email API not initialized');
      return await api.listLabels();
    },
    enabled: !!api,
  });
}

/**
 * Snapshot the labels cache, apply an optimistic updater, and return the
 * previous value for rollback. Centralises the create/update/delete
 * optimistic pattern so the label picker reacts instantly.
 */
async function optimisticLabels(
  queryClient: ReturnType<typeof useQueryClient>,
  updater: (prev: Label[]) => Label[],
): Promise<{ prev: Label[] | undefined }> {
  await queryClient.cancelQueries({ queryKey: LABELS_KEY });
  const prev = queryClient.getQueryData<Label[]>(LABELS_KEY);
  queryClient.setQueryData<Label[]>(LABELS_KEY, (old) => updater(old ?? []));
  return { prev };
}

export function useCreateLabel() {
  const api = useEmailStore((s) => s._api);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ name, color }: { name: string; color: string }) => {
      if (!api) throw new Error('Email API not initialized');
      return await api.createLabel(name, color);
    },
    onMutate: async ({ name, color }) => {
      const tempId = `optimistic:${Date.now()}`;
      const optimistic: Label = {
        _id: tempId,
        userId: '',
        name,
        color,
        order: Number.MAX_SAFE_INTEGER,
        // A user-created label is never a system one.
        system: false,
      };
      const { prev } = await optimisticLabels(queryClient, (labels) => [...labels, optimistic]);
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) queryClient.setQueryData(LABELS_KEY, context.prev);
      toast.error('Failed to create label.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: LABELS_KEY });
    },
  });
}

export function useUpdateLabel() {
  const api = useEmailStore((s) => s._api);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ labelId, updates }: { labelId: string; updates: { name?: string; color?: string } }) => {
      if (!api) throw new Error('Email API not initialized');
      return await api.updateLabel(labelId, updates);
    },
    onMutate: async ({ labelId, updates }) => {
      const { prev } = await optimisticLabels(queryClient, (labels) =>
        labels.map((l) => (l._id === labelId ? { ...l, ...updates } : l)),
      );
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) queryClient.setQueryData(LABELS_KEY, context.prev);
      toast.error('Failed to update label.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: LABELS_KEY });
    },
  });
}

export function useDeleteLabel() {
  const api = useEmailStore((s) => s._api);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (labelId: string) => {
      if (!api) throw new Error('Email API not initialized');
      await api.deleteLabel(labelId);
    },
    onMutate: async (labelId) => {
      const { prev } = await optimisticLabels(queryClient, (labels) =>
        labels.filter((l) => l._id !== labelId),
      );
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) queryClient.setQueryData(LABELS_KEY, context.prev);
      toast.error('Failed to delete label.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: LABELS_KEY });
    },
  });
}
