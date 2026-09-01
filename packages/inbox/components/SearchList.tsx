/**
 * Search emails list with Gmail-style search bar and filter chips.
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSearchFocus } from '@/contexts/search-focus-context';
import { useFloatingHeader } from '@/hooks/useFloatingHeader';
import { useGoBack } from '@/hooks/useGoBack';
import { useTabBarClearance } from '@/hooks/useTabBarClearance';

import { useColors } from '@/constants/theme';
import { CONTENT_MAX_WIDTH } from '@/constants/layout';
import { SPECIAL_USE } from '@/constants/mailbox';
import type { Message } from '@/services/emailApi';
import { MessageRow } from '@/components/MessageRow';
import { SearchHeader } from '@/components/SearchHeader';
import { EmptyIllustration } from '@/components/EmptyIllustration';
import { useEmailStore } from '@/hooks/useEmail';
import { useSearchMessages } from '@/hooks/queries/useSearchMessages';
import { useMessageActions } from '@/hooks/useMessageActions';
import { useMailboxes } from '@/hooks/queries/useMailboxes';
import {
  useNaturalLanguageSearch,
  quickParseSearch,
  type ParsedSearchQuery,
} from '@/hooks/queries/useNaturalLanguageSearch';

/**
 * Parse Gmail-style search operators from query string.
 * Supported operators:
 * - in:inbox, in:sent, in:spam, in:trash, in:drafts, in:archive, in:starred
 * - is:starred, is:unread, is:read
 * - from:address
 * - has:attachment
 * - label:name
 */
interface ParsedQuery {
  text: string;
  mailbox?: string;
  starred?: boolean;
  unread?: boolean;
  from?: string;
  hasAttachment?: boolean;
  label?: string;
}

function parseSearchQuery(query: string): ParsedQuery {
  const result: ParsedQuery = { text: '' };
  const textParts: string[] = [];

  // Split by spaces but keep quoted strings together
  const tokens = query.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

  for (const token of tokens) {
    const lower = token.toLowerCase();

    if (lower.startsWith('in:')) {
      const value = token.slice(3).toLowerCase();
      if (value === 'starred') {
        result.starred = true;
      } else {
        result.mailbox = value;
      }
    } else if (lower.startsWith('is:')) {
      const value = token.slice(3).toLowerCase();
      if (value === 'starred') result.starred = true;
      else if (value === 'unread') result.unread = true;
      else if (value === 'read') result.unread = false;
    } else if (lower.startsWith('from:')) {
      result.from = token.slice(5).replace(/^"|"$/g, '');
    } else if (lower === 'has:attachment') {
      result.hasAttachment = true;
    } else if (lower.startsWith('label:')) {
      result.label = token.slice(6).replace(/^"|"$/g, '');
    } else {
      // Regular search text
      textParts.push(token.replace(/^"|"$/g, ''));
    }
  }

  result.text = textParts.join(' ');
  return result;
}

/** Format NL search interpretation for display */
function formatInterpretation(opts: ParsedSearchQuery): string {
  const parts: string[] = [];
  if (opts.q) parts.push(`"${opts.q}"`);
  if (opts.from) parts.push(`from ${opts.from}`);
  if (opts.to) parts.push(`to ${opts.to}`);
  if (opts.subject) parts.push(`subject contains "${opts.subject}"`);
  if (opts.hasAttachment) parts.push('with attachments');
  if (opts.starred) parts.push('starred');
  if (opts.unread === true) parts.push('unread');
  if (opts.unread === false) parts.push('read');
  return parts.join(', ') || 'all emails';
}

interface SearchListProps {
  replaceNavigation?: boolean;
}

export function SearchList({ replaceNavigation }: SearchListProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const colors = useColors();
  const inputRef = useRef<TextInput | null>(null);
  const { registerInput } = useSearchFocus();
  // Fans the input node out to BOTH the local ref (used by `handleClear` to
  // put the caret back) and the shared context the tab bar focuses through.
  // A callback ref rather than an effect: it runs during commit and is called
  // with null on unmount, so registration cannot outlive the input.
  const setInputRef = useCallback(
    (node: TextInput | null) => {
      inputRef.current = node;
      registerInput(node);
    },
    [registerInput],
  );
  const selectedMessageId = useEmailStore((s) => s.selectedMessageId);
  const messageActions = useMessageActions();
  const { data: mailboxes = [] } = useMailboxes();

  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterHasAttachment, setFilterHasAttachment] = useState(false);
  // Measured height of the floating header stack, reused as the list's top
  // padding so the first result starts just below it.
  const { headerHeight, onHeaderLayout, floatingHeaderStyle } = useFloatingHeader();
  const [editingFilter, setEditingFilter] = useState<string | null>(null);
  const [filterInput, setFilterInput] = useState('');
  const [nlInterpretation, setNlInterpretation] = useState('');
  const [nlParsedOptions, setNlParsedOptions] = useState<ParsedSearchQuery | null>(null);

  // Natural language search hook
  const { parseQuery: parseNL, isLoading: nlParsing } = useNaturalLanguageSearch();

  // Parse the submitted query for Gmail-style operators
  const parsedQuery = useMemo(() => parseSearchQuery(submittedQuery), [submittedQuery]);

  // Map mailbox name to mailbox ID
  const mailboxIdFromName = useMemo(() => {
    if (!parsedQuery.mailbox) return undefined;
    const specialUseMap: Record<string, string> = {
      inbox: SPECIAL_USE.INBOX,
      sent: SPECIAL_USE.SENT,
      drafts: SPECIAL_USE.DRAFTS,
      trash: SPECIAL_USE.TRASH,
      spam: SPECIAL_USE.SPAM,
      junk: SPECIAL_USE.SPAM,
      archive: SPECIAL_USE.ARCHIVE,
    };
    const specialUse = specialUseMap[parsedQuery.mailbox];
    if (specialUse) {
      const mailbox = mailboxes.find((m) => m.specialUse === specialUse);
      return mailbox?._id;
    }
    // Try to match by name
    const mailbox = mailboxes.find((m) => m.name.toLowerCase() === parsedQuery.mailbox);
    return mailbox?._id;
  }, [parsedQuery.mailbox, mailboxes]);

  const searchOptions = useMemo(() => ({
    // NL parsed options take precedence, then Gmail-style operators, then filter chips
    q: nlParsedOptions?.q || parsedQuery.text || undefined,
    from: nlParsedOptions?.from || parsedQuery.from || filterFrom || undefined,
    to: nlParsedOptions?.to || undefined,
    subject: nlParsedOptions?.subject || undefined,
    hasAttachment: nlParsedOptions?.hasAttachment || parsedQuery.hasAttachment || filterHasAttachment || undefined,
    mailbox: mailboxIdFromName,
    starred: nlParsedOptions?.starred || parsedQuery.starred || undefined,
    label: parsedQuery.label || undefined,
    // Note: unread filter would need backend support
  }), [nlParsedOptions, parsedQuery, filterFrom, filterHasAttachment, mailboxIdFromName]);

  const { data: searchResult, isLoading: searching } = useSearchMessages(searchOptions);
  const results = searchResult?.data ?? [];
  const total = searchResult?.pagination?.total ?? 0;
  const hasSearched = !!(submittedQuery.trim() || nlParsedOptions || filterFrom || filterHasAttachment || mailboxIdFromName);

  /**
   * Runs the search pipeline for a given query text:
   *   1. Gmail-style operators (`from:foo`, `is:starred`) → text + filter parse.
   *   2. Quick patterns (`unread`, `from sarah`) → structured filters.
   *   3. Plain text search immediately, then optionally refined by AI.
   *
   * Accepts the text as a parameter so debounced callers can pass the latest
   * value without waiting for React state to settle.
   */
  const runSearch = useCallback(
    async (rawText: string, { allowAI }: { allowAI: boolean } = { allowAI: true }) => {
      const trimmed = rawText.trim();
      if (!trimmed) {
        setSubmittedQuery('');
        setNlInterpretation('');
        setNlParsedOptions(null);
        return;
      }

      const hasOperators = /\b(in:|is:|from:|to:|has:|label:|subject:)/i.test(trimmed);
      if (hasOperators) {
        setSubmittedQuery(trimmed);
        setNlInterpretation('');
        setNlParsedOptions(null);
        return;
      }

      const quickResult = quickParseSearch(trimmed);
      if (quickResult) {
        setNlParsedOptions(quickResult);
        setNlInterpretation(`Searching: ${formatInterpretation(quickResult)}`);
        setSubmittedQuery('');
        return;
      }

      // Run plain text search immediately so the user sees results without
      // waiting for AI parsing.
      setSubmittedQuery(trimmed);
      setNlInterpretation('');
      setNlParsedOptions(null);

      if (!allowAI) return;

      // Refine with AI in the background. Only switch from plain text to
      // structured filters if the AI returns something useful.
      try {
        const result = await parseNL(trimmed);
        const parsed = result.query;
        const hasUsefulFilters =
          !!parsed.q?.trim() ||
          !!parsed.from?.trim() ||
          !!parsed.to?.trim() ||
          !!parsed.subject?.trim() ||
          parsed.hasAttachment === true ||
          parsed.starred === true ||
          typeof parsed.unread === 'boolean' ||
          !!parsed.after ||
          !!parsed.before ||
          !!parsed.mailbox;

        if (hasUsefulFilters) {
          setNlParsedOptions(parsed);
          setNlInterpretation(
            result.interpretation || `Searching: ${formatInterpretation(parsed)}`,
          );
          setSubmittedQuery('');
        }
      } catch {
        // AI failed; plain text search is already in flight.
      }
    },
    [parseNL],
  );

  // Debounced search-as-you-type. The user pressing Enter submits immediately.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleQueryChange = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const trimmed = text.trim();
      if (!trimmed) {
        // Clear immediately when the user empties the input
        setSubmittedQuery('');
        setNlInterpretation('');
        setNlParsedOptions(null);
        return;
      }
      // Skip AI on intermediate keystrokes — AI fires on explicit submit
      debounceRef.current = setTimeout(() => {
        runSearch(text, { allowAI: false });
      }, 300);
    },
    [runSearch],
  );

  const handleSubmit = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    runSearch(query, { allowAI: true });
  }, [runSearch, query]);

  const handleMessagePress = useCallback(
    (messageId: string) => {
      messageActions.prepareOpenMessage(messageId);
      const path = {
        pathname: '/search/conversation/[id]',
        params: { id: messageId },
      } as const;
      if (replaceNavigation) {
        router.replace(path);
      } else {
        router.push(path);
      }
    },
    [router, replaceNavigation, messageActions],
  );

  const handleBack = useGoBack();

  const handleClear = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setQuery('');
    setSubmittedQuery('');
    setFilterFrom('');
    setFilterHasAttachment(false);
    setNlInterpretation('');
    setNlParsedOptions(null);
    inputRef.current?.focus();
  }, []);

  const handleFilterChipPress = useCallback((filter: string) => {
    if (filter === 'attachment') {
      setFilterHasAttachment((v) => !v);
    } else {
      setEditingFilter(filter);
      setFilterInput(filter === 'from' ? filterFrom : '');
    }
  }, [filterFrom]);

  const handleFilterSubmit = useCallback(() => {
    if (editingFilter === 'from') {
      setFilterFrom(filterInput.trim());
    }
    setEditingFilter(null);
    setFilterInput('');
  }, [editingFilter, filterInput]);

  const renderItem = useCallback(
    ({ item }: { item: Message }) => (
      <MessageRow
        message={item}
        onSelect={handleMessagePress}
        isSelected={item._id === selectedMessageId}
      />
    ),
    [handleMessagePress, selectedMessageId],
  );

  const renderEmpty = useCallback(() => {
    if (searching) return null;
    if (!hasSearched) {
      return (
        <View style={styles.emptyContainer}>
          <EmptyIllustration size={180} />
          <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
            Search your emails
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.emptyContainer}>
        <EmptyIllustration size={180} />
        <Text style={[styles.emptyText, { color: colors.secondaryText }]}>No results found</Text>
      </View>
    );
  }, [searching, hasSearched, colors]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Same scroll treatment as the inbox: the header (and the filter chips
          under it) float over the results, which scroll behind the header's
          gradient. The measured height becomes the list's top padding. */}
      <View style={floatingHeaderStyle} onLayout={onHeaderLayout}
      >
      <SearchHeader
        ref={setInputRef}
        onLeftIcon={handleBack}
        leftIcon="arrow-left"
        placeholder="Search mail"
        value={query}
        onChangeText={handleQueryChange}
        onSubmitEditing={handleSubmit}
        onClear={handleClear}
        autoFocus
      />

      {/* Filter chips */}
      <View
        style={[
          styles.filterBar,
          { paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right },
        ]}
      >
        <TouchableOpacity
          style={[
            styles.filterChip,
            { borderColor: colors.border },
            filterFrom ? { backgroundColor: colors.primary + '15', borderColor: colors.primary } : undefined,
          ]}
          onPress={() => handleFilterChipPress('from')}
          activeOpacity={0.7}
        >
          <Text style={[styles.filterChipText, { color: filterFrom ? colors.primary : colors.secondaryText }]}>
            {filterFrom ? `From: ${filterFrom}` : 'From'}
          </Text>
          {filterFrom ? (
            <TouchableOpacity onPress={() => setFilterFrom('')} hitSlop={4}>
              <MaterialCommunityIcons name="close-circle" size={14} color={colors.primary} />
            </TouchableOpacity>
          ) : null}
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.filterChip,
            { borderColor: colors.border },
            filterHasAttachment ? { backgroundColor: colors.primary + '15', borderColor: colors.primary } : undefined,
          ]}
          onPress={() => handleFilterChipPress('attachment')}
          activeOpacity={0.7}
        >
          <MaterialCommunityIcons
            name="paperclip"
            size={14}
            color={filterHasAttachment ? colors.primary : colors.secondaryText}
          />
          <Text style={[styles.filterChipText, { color: filterHasAttachment ? colors.primary : colors.secondaryText }]}>
            Has attachment
          </Text>
        </TouchableOpacity>
      </View>

      {/* NL interpretation display */}
      {(nlInterpretation || nlParsing) && (
        <View
          style={[
            styles.nlInterpretation,
            {
              backgroundColor: colors.surfaceVariant,
              marginLeft: 16 + insets.left,
              marginRight: 16 + insets.right,
            },
          ]}
        >
          <MaterialCommunityIcons
            name="robot-outline"
            size={14}
            color={colors.primary}
            style={styles.nlIcon}
          />
          {nlParsing ? (
            <View style={styles.nlParsingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.nlText, { color: colors.secondaryText }]}>
                Understanding your search...
              </Text>
            </View>
          ) : (
            <Text style={[styles.nlText, { color: colors.text }]}>
              {nlInterpretation}
            </Text>
          )}
          {nlInterpretation && !nlParsing && (
            <TouchableOpacity
              onPress={() => {
                setNlInterpretation('');
                setNlParsedOptions(null);
              }}
              hitSlop={8}
            >
              <MaterialCommunityIcons name="close" size={16} color={colors.icon} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Filter input overlay */}
      {editingFilter && (
        <View style={[styles.filterInputRow, { backgroundColor: colors.surfaceVariant }]}>
          <Text style={[styles.filterInputLabel, { color: colors.secondaryText }]}>
            {editingFilter === 'from' ? 'From:' : editingFilter}
          </Text>
          <TextInput
            style={[styles.filterInputField, { color: colors.text }]}
            value={filterInput}
            onChangeText={setFilterInput}
            autoFocus
            onSubmitEditing={handleFilterSubmit}
            returnKeyType="done"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity onPress={() => setEditingFilter(null)}>
            <MaterialCommunityIcons name="close" size={20} color={colors.icon} />
          </TouchableOpacity>
        </View>
      )}

      {/* Result count */}
      {hasSearched && !searching && results.length > 0 && (
        <View style={styles.resultCount}>
          <Text style={[styles.resultCountText, { color: colors.secondaryText }]}>
            {total} {total === 1 ? 'result' : 'results'}
          </Text>
        </View>
      )}
      </View>

      {searching ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={results}
          renderItem={renderItem}
          keyExtractor={(item) => item._id}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={{
            ...(results.length === 0 ? styles.emptyListContent : null),
            ...styles.listContent,
            paddingTop: headerHeight,
            // The floating tab bar's footprint, which already folds in the
            // bottom safe-area inset — so the last result row clears both the
            // bar and the home indicator, on every platform.
            paddingBottom: tabBarClearance,
          }}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: colors.border }]} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  // `paddingLeft` / `paddingRight` are applied inline so they can include
  // landscape `insets.left` / `insets.right`.
  filterBar: {
    flexDirection: 'row',
    paddingBottom: 8,
    gap: 8,
    flexWrap: 'wrap',
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '500',
  },
  filterInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  filterInputLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  filterInputField: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 4,
  },
  resultCount: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  resultCountText: {
    fontSize: 12,
    fontWeight: '500',
  },
  loadingContainer: {
    flex: 1,
    paddingTop: 40,
    alignItems: 'center',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 68,
  },
  // `marginLeft` / `marginRight` are applied inline so they can include
  // landscape `insets.left` / `insets.right`.
  nlInterpretation: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  nlIcon: {
    marginRight: 4,
  },
  nlText: {
    flex: 1,
    fontSize: 13,
  },
  nlParsingRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
