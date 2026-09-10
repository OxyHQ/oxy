import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { toast } from '@oxy.so/bloom';
import { useOxy } from '@oxy.so/services';
import * as Contacts from 'expo-contacts';
import type { User } from '@oxy.so/core';
import { useTranslation } from '@/lib/i18n';
import { hashContacts } from '@/lib/contacts/hash';

/**
 * A resolved Oxy profile for a contact that matched, paired with the local
 * display name from the device address book (so the UI can show "Jane (Mom)"
 * when the user's contact name differs from their Oxy display name).
 */
export interface ContactMatch {
  user: User;
  localDisplayName?: string;
}

export interface UseContactSyncResult {
  contactsPermission: Contacts.PermissionStatus | null;
  isSyncingContacts: boolean;
  deviceContactsCount: number | null;
  contactMatches: ContactMatch[];
  handleSyncContacts: () => Promise<void>;
}

/**
 * Owns the native-only contact-sync flow and its state.
 *
 * Extracted verbatim from the People & Sharing screen: checks the
 * `expo-contacts` permission on mount, and runs the full discovery flow on
 * demand (read address book → SHA-256 hash locally → `/contacts/discover` →
 * resolve matched Oxy profiles). Raw email/phone never leaves the device — only
 * the hex digests do, and the result lives in memory until unmount.
 */
export function useContactSync(): UseContactSyncResult {
  const { oxyServices } = useOxy();
  const { t } = useTranslation();

  const [contactsPermission, setContactsPermission] = useState<Contacts.PermissionStatus | null>(null);
  const [isSyncingContacts, setIsSyncingContacts] = useState(false);
  const [deviceContactsCount, setDeviceContactsCount] = useState<number | null>(null);
  const [contactMatches, setContactMatches] = useState<ContactMatch[]>([]);

  // Check contacts permission on mount (native only)
  useEffect(() => {
    if (Platform.OS === 'web') return;

    const checkPermission = async () => {
      const { status } = await Contacts.getPermissionsAsync();
      setContactsPermission(status);
    };
    checkPermission();
  }, []);

  /**
   * Run the full contact-sync flow:
   *   1. Request `expo-contacts` permission.
   *   2. Read the user's address book.
   *   3. Hash emails+phones locally with SHA-256 (see `lib/contacts/hash.ts`).
   *   4. POST hashes to `/contacts/discover` via the core SDK.
   *   5. For each match, fetch the Oxy profile (parallel) and store the list
   *      in component state for the UI to render.
   *
   * Privacy posture: raw email/phone NEVER leaves the device — only the
   * 64-char SHA-256 hex digests do. The server returns only Oxy user IDs.
   */
  const handleSyncContacts = useCallback(async () => {
    if (Platform.OS === 'web') return;
    if (!oxyServices) return;

    try {
      let { status } = await Contacts.getPermissionsAsync();
      if (status !== 'granted') {
        const permissionResult = await Contacts.requestPermissionsAsync();
        status = permissionResult.status;
        setContactsPermission(status);
      }

      if (status !== 'granted') {
        toast.warning(t('sharing.contacts.permissionMessage'));
        return;
      }

      setIsSyncingContacts(true);
      setContactMatches([]);

      const { data: deviceContacts } = await Contacts.getContactsAsync({
        fields: [
          Contacts.Fields.Name,
          Contacts.Fields.Emails,
          Contacts.Fields.PhoneNumbers,
        ],
      });

      if (deviceContacts.length === 0) {
        toast.info(t('sharing.contacts.noContactsMessage'));
        setIsSyncingContacts(false);
        return;
      }

      setDeviceContactsCount(deviceContacts.length);

      // Shape device contacts into the form the hash util expects.
      const hashInput = deviceContacts.map((c) => ({
        id: c.id ?? `${c.name ?? 'contact'}-${Math.random().toString(36).slice(2)}`,
        displayName: c.name ?? '',
        emails: (c.emails ?? []).map((e) => e.email),
        phones: (c.phoneNumbers ?? []).map((p) => p.number),
      }));

      const batch = await hashContacts(hashInput);

      if (batch.hashedEmails.length === 0 && batch.hashedPhones.length === 0) {
        // No usable identifiers — nothing to discover. Treat as empty result.
        setContactMatches([]);
        setIsSyncingContacts(false);
        return;
      }

      const { matches } = await oxyServices.discoverContacts(
        batch.hashedEmails,
        batch.hashedPhones,
      );

      // De-dupe by userId — a single user may match on both email AND phone,
      // but the UI should only show them once.
      const uniqueUserIds = Array.from(new Set(matches.map((m) => m.userId)));

      // Build a userId -> local display name lookup so the UI can show the
      // device contact name alongside the Oxy profile.
      const userIdToLocalName = new Map<string, string>();
      for (const match of matches) {
        const contactsForHash = batch.hashToContacts.get(match.hashedIdentifier);
        if (!contactsForHash || contactsForHash.length === 0) continue;
        const localName = contactsForHash[0].displayName;
        if (localName && !userIdToLocalName.has(match.userId)) {
          userIdToLocalName.set(match.userId, localName);
        }
      }

      const profiles = await Promise.all(
        uniqueUserIds.map(async (id) => {
          try {
            const user = await oxyServices.getUserById(id);
            const entry: ContactMatch = { user };
            const localName = userIdToLocalName.get(id);
            if (localName) entry.localDisplayName = localName;
            return entry;
          } catch {
            return null;
          }
        }),
      );

      const resolved: ContactMatch[] = [];
      for (const profile of profiles) {
        if (profile !== null) resolved.push(profile);
      }

      setContactMatches(resolved);
    } catch {
      // Non-fatal — surface a friendly message and let the user retry.
      toast.error(t('sharing.contacts.syncFailed'));
    } finally {
      setIsSyncingContacts(false);
    }
  }, [oxyServices, t]);

  return {
    contactsPermission,
    isSyncingContacts,
    deviceContactsCount,
    contactMatches,
    handleSyncContacts,
  };
}
