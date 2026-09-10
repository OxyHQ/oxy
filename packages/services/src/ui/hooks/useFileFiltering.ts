import { useMemo, useState, useCallback } from 'react';
import type { FileMetadata } from '@oxy.so/core';

export type ViewMode = 'all' | 'photos' | 'videos' | 'documents' | 'audio';
export type SortBy = 'date' | 'size' | 'name' | 'type';
export type SortOrder = 'asc' | 'desc';

interface UseFileFilteringOptions {
  files: FileMetadata[];
  initialViewMode?: ViewMode;
  initialSortBy?: SortBy;
  initialSortOrder?: SortOrder;
}

interface UseFileFilteringReturn {
  filteredFiles: FileMetadata[];
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  sortBy: SortBy;
  setSortBy: (sort: SortBy) => void;
  sortOrder: SortOrder;
  setSortOrder: (order: SortOrder) => void;
  toggleSortOrder: () => void;
}

/**
 * Hook for file filtering, sorting, and search functionality
 * Extracts common file management logic for reuse across components
 */
export function useFileFiltering({
  files,
  initialViewMode = 'all',
  initialSortBy = 'date',
  initialSortOrder = 'desc',
}: UseFileFilteringOptions): UseFileFilteringReturn {
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>(initialSortBy);
  const [sortOrder, setSortOrder] = useState<SortOrder>(initialSortOrder);

  const toggleSortOrder = useCallback(() => {
    setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
  }, []);

  const filteredFiles = useMemo(() => {
    // Filter by view mode
    let filteredByMode = files;
    if (viewMode === 'photos') {
      filteredByMode = files.filter((file) => file.contentType.startsWith('image/'));
    } else if (viewMode === 'videos') {
      filteredByMode = files.filter((file) => file.contentType.startsWith('video/'));
    } else if (viewMode === 'documents') {
      filteredByMode = files.filter(
        (file) =>
          file.contentType.includes('pdf') ||
          file.contentType.includes('document') ||
          file.contentType.includes('text') ||
          file.contentType.includes('msword') ||
          file.contentType.includes('excel') ||
          file.contentType.includes('spreadsheet') ||
          file.contentType.includes('presentation') ||
          file.contentType.includes('powerpoint')
      );
    } else if (viewMode === 'audio') {
      filteredByMode = files.filter((file) => file.contentType.startsWith('audio/'));
    }

    // Filter by search query
    let filtered = filteredByMode;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filteredByMode.filter(
        (file) =>
          file.filename.toLowerCase().includes(query) ||
          file.contentType.toLowerCase().includes(query) ||
          (file.metadata?.description?.toLowerCase().includes(query))
      );
    }

    // Sort files
    const sorted = [...filtered].sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'date') {
        const dateA = new Date(a.uploadDate || 0).getTime();
        const dateB = new Date(b.uploadDate || 0).getTime();
        comparison = dateA - dateB;
      } else if (sortBy === 'size') {
        comparison = (a.length || 0) - (b.length || 0);
      } else if (sortBy === 'name') {
        comparison = (a.filename || '').localeCompare(b.filename || '');
      } else if (sortBy === 'type') {
        comparison = (a.contentType || '').localeCompare(b.contentType || '');
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [files, searchQuery, viewMode, sortBy, sortOrder]);

  return {
    filteredFiles,
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    sortBy,
    setSortBy,
    sortOrder,
    setSortOrder,
    toggleSortOrder,
  };
}
