import { useEffect, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import type { CampaignAttribution } from '@oxy.so/contracts';
import type { StorageInterface } from '../utils/storageHelpers';
import { readCampaignAttribution, readEntryLink } from '../utils/entryLink';

/** One receiver for initial and warm native links and web entry parameters. */
export function useEntryLink({
  storage,
  storageKey,
  captureCampaign,
  onError,
}: {
  storage: StorageInterface | null;
  storageKey: string;
  captureCampaign: boolean;
  onError: (message: string, error?: unknown) => void;
}) {
  const [entry, setEntry] = useState<{
    url: string | null | undefined;
    ready: boolean;
    firstCampaign?: CampaignAttribution;
  }>({ url: undefined, ready: false });
  const [campaignAttribution, setCampaignAttribution] = useState<CampaignAttribution>();
  const [campaignReady, setCampaignReady] = useState(false);
  const captures = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    const subscription = Linking.addEventListener('url', ({ url }) => {
      setEntry((current) => ({
        ...current,
        url,
        firstCampaign: current.firstCampaign ?? readEntryLink(url).campaignAttribution,
      }));
    });
    const initialUrl =
      Platform.OS === 'web' && typeof window !== 'undefined'
        ? Promise.resolve(window.location.href)
        : Linking.getInitialURL();
    initialUrl
      .then((initial) => {
        if (active)
          setEntry((current) => ({
            url: current.url === undefined ? initial : current.url,
            ready: true,
            firstCampaign:
              readEntryLink(initial ?? null).campaignAttribution ?? current.firstCampaign,
          }));
      })
      .catch((error: unknown) => {
        onError('Failed to read the initial entry link', error);
        if (active) setEntry((current) => ({ ...current, url: current.url ?? null, ready: true }));
      });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [onError]);

  useEffect(() => {
    if (!storage || !entry.ready) return;
    let active = true;
    async function capture() {
      if (!captureCampaign) {
        if (active) setCampaignReady(true);
        return;
      }
      let stored: CampaignAttribution | undefined;
      const raw = await storage?.getItem(storageKey);
      if (raw) {
        try {
          stored = readCampaignAttribution(JSON.parse(raw));
        } catch {
          onError('Stored campaign attribution is malformed');
        }
      }
      const selected = stored ?? entry.firstCampaign;
      if (selected && !stored) await storage?.setItem(storageKey, JSON.stringify(selected));
      if (active) {
        setCampaignAttribution(selected);
        setCampaignReady(true);
      }
    }
    captures.current = captures.current.then(capture).catch((error: unknown) => {
      onError('Failed to persist campaign attribution', error);
      if (active) {
        setCampaignAttribution(entry.firstCampaign);
        setCampaignReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [captureCampaign, entry.ready, entry.firstCampaign, onError, storage, storageKey]);

  return {
    url: entry.url,
    ready: entry.ready,
    campaignAttribution,
    campaignReady: !captureCampaign || campaignReady,
  };
}
