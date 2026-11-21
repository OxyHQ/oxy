/**
 * The assets `useAssets` holds (`data/assets.ts`): partial answers merge into
 * what is held, link changes the server did not echo are recorded, and a reset
 * forgets everything.
 */
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import type { Asset as AssetRecord } from '@oxy.so/core';
import {
  Asset,
  AssetActivity,
  addAssetLink,
  HELD_ASSETS_KEY,
  HeldAssets,
  mergeAsset,
  removeAsset,
  removeAssetLink,
  resetAssets,
  setAssetLoading,
} from '../assets';

beforeEach(() => {
  setActiveStore(new Store());
});

const asset = {
  id: 'a1',
  sha256: 'x',
  size: 1,
  mime: 'image/png',
  ext: 'png',
  links: [],
} as unknown as AssetRecord;

describe('held assets', () => {
  it('merges a partial answer into the held record and lists it once', () => {
    mergeAsset(asset);
    mergeAsset({ id: 'a1', size: 2 });
    expect(Asset.get('a1')).toMatchObject({ sha256: 'x', size: 2 });
    expect(HeldAssets.get(HELD_ASSETS_KEY)?.ids).toEqual(['a1']);
  });

  it('records a link once, and its removal leaves the file held but unused', () => {
    mergeAsset(asset);
    const link = { app: 'mention', entityType: 'post', entityId: 'p1', createdAt: 'now' };
    addAssetLink('a1', link);
    addAssetLink('a1', link);
    expect(Asset.get('a1')).toMatchObject({ usageCount: 1, inUse: true });
    removeAssetLink('a1', 'mention', 'post', 'p1');
    expect(Asset.get('a1')).toMatchObject({ links: [], usageCount: 0, inUse: false });
  });

  it('drops a removed asset from the held list, and a reset forgets everything', () => {
    mergeAsset(asset);
    mergeAsset({ ...asset, id: 'a2' });
    removeAsset('a1');
    expect(HeldAssets.get(HELD_ASSETS_KEY)?.ids).toEqual(['a2']);
    setAssetLoading('uploading', true);
    resetAssets();
    expect(Asset.get('a2')).toBeUndefined();
    expect(HeldAssets.get(HELD_ASSETS_KEY)).toBeUndefined();
    expect(AssetActivity.get()).toBeUndefined();
  });
});
