import { variantStorageRoot, videoStorageRoots } from '../variant-storage-roots';
import { storageTargetsForAsset } from '../../services/accountStorageDeletion.service';

const hash = 'ab'.repeat(32);
const root = `variants/2026/09/ab/${hash}/`;
it('recognizes the content root of nested generations and groups their segments for deletion', () => {
  expect(variantStorageRoot(`public/${root}video-v2/generation/hls_master.m3u8`, hash)).toBe(root);
  expect(
    storageTargetsForAsset({ sha256: hash, storageKey: 'public/original' }, [
      `public/${root}video-v2/first/hls_master.m3u8`,
      `${root}video-v2/second/360p.mp4`,
    ]),
  ).toEqual([
    { kind: 'object', target: 'original', sha256: hash },
    { kind: 'prefix', target: root, sha256: hash },
  ]);
});
it('includes recorded roots from previous months and refuses cross-content or traversal prefixes', () => {
  const prior = root.replace('/09/', '/08/');
  const foreign = root.replace(hash, 'cd'.repeat(32));
  expect(
    videoStorageRoots(
      {
        sha256: hash,
        metadata: { video: { storageRoots: [prior, foreign, '../', `${root}../other`] } },
      },
      [`${root}video-v2/current/hls_master.m3u8`],
    ),
  ).toEqual([prior, root]);
  expect(variantStorageRoot(`${root}../other/master.m3u8`, hash)).toBeUndefined();
  expect(variantStorageRoot(`${foreign}video-v2/master.m3u8`, hash)).toBeUndefined();
});
