/**
 * `OxyServer.assets` — stage 4c of ADR 0042: a person's private media from a
 * service, audio rendition options, play sessions, recording targets
 * (LiveKit egress) and imports of sources over 40 MiB that Oxy fetches in the
 * background.
 *
 * Stubs `serviceRequest`, the service-token transport, so each test pins what
 * a call sends and how the SDK follows a `202`.
 */
import { OxyServer } from '../OxyServer';
import { OxyApiError } from '../../OxyServices.errors';

const userMediaFile = {
  id: 'file-1',
  sha256: 'a'.repeat(64),
  size: 4,
  mime: 'audio/mpeg',
  visibility: 'private' as const,
};
const importAnswer = {
  file: { ...userMediaFile, status: 'active' },
  outcome: 'downloaded',
  deduplicated: false,
  source: { host: 'feeds.example', fetchedAt: '2026-10-16T00:00:00.000Z' },
};

describe('OxyServer.assets — stage 4c', () => {
  let oxy: OxyServer;
  let serviceRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    oxy = new OxyServer({ baseURL: 'http://test.invalid' });
    serviceRequestSpy = jest.spyOn(oxy, 'serviceRequest');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Run `work` while fake time advances in poll-sized steps until it settles. */
  async function settle<T>(work: Promise<T>, maxSteps = 2_000): Promise<T> {
    let done = false;
    const tracked = work.finally(() => {
      done = true;
    });
    tracked.catch(() => undefined);
    for (let step = 0; step < maxSteps && !done; step++) {
      await jest.advanceTimersByTimeAsync(1_000);
    }
    return tracked;
  }

  describe('private person-owned media', () => {
    it('uploadUserMedia sends x-visibility and x-audio-options with the owner', async () => {
      serviceRequestSpy.mockResolvedValueOnce({ file: userMediaFile });
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await expect(
        oxy.assets.uploadUserMedia('user-1', bytes, 'audio/mpeg', {
          visibility: 'private',
          audio: { normalizeLoudness: true, previewStartSeconds: 45 },
        }),
      ).resolves.toEqual(userMediaFile);
      const [method, url, body, options] = serviceRequestSpy.mock.calls[0];
      expect([method, url, body]).toEqual(['POST', '/assets/service/user-media', bytes]);
      expect(options.headers).toEqual({
        'Content-Type': 'audio/mpeg',
        'x-audio-options': JSON.stringify({ normalizeLoudness: true, previewStartSeconds: 45 }),
        'x-visibility': 'private',
        'x-owner-user-id': 'user-1',
      });
    });

    it('uploadUserMedia leaves visibility to the server default when none is given', async () => {
      serviceRequestSpy.mockResolvedValueOnce({ file: userMediaFile });
      await oxy.assets.uploadUserMedia('user-1', new Uint8Array([1]), 'image/png');
      expect(serviceRequestSpy.mock.calls[0][3].headers).toEqual({
        'Content-Type': 'image/png',
        'x-owner-user-id': 'user-1',
      });
    });

    it('uploadAppFile carries the audio options', async () => {
      serviceRequestSpy.mockResolvedValueOnce({ file: {}, deduplicated: false });
      await oxy.assets.uploadAppFile(new Uint8Array([1]), 'audio/flac', {
        visibility: 'private',
        audio: { normalizeLoudness: false },
      });
      expect(serviceRequestSpy.mock.calls[0][3].headers).toEqual({
        'Content-Type': 'audio/flac',
        'x-audio-options': JSON.stringify({ normalizeLoudness: false }),
        'x-visibility': 'private',
      });
    });
  });

  describe('play sessions', () => {
    const session = {
      sessionId: 'ps_1',
      fileId: 'file-1',
      kind: 'audio',
      status: 'active',
      encryption: 'aes-128',
      keyAuthorization: 'webhook',
      endUserId: 'user-9',
      expiresAt: '2026-10-16T01:00:00.000Z',
      masterUrl: 'https://api.oxy.so/assets/streams/ps_1.tok/master.m3u8',
      renditions: [],
    };

    it('create POSTs the file and options, not retried', async () => {
      serviceRequestSpy.mockResolvedValueOnce(session);
      await expect(
        oxy.assets.streams.create('file-1', {
          endUserId: 'user-9',
          ttlSeconds: 7200,
          encryption: 'aes-128',
          keyAuthorization: 'webhook',
        }),
      ).resolves.toEqual(session);
      const [method, url, body, options] = serviceRequestSpy.mock.calls[0];
      expect([method, url, body]).toEqual([
        'POST',
        '/assets/service/streams',
        {
          fileId: 'file-1',
          endUserId: 'user-9',
          ttlSeconds: 7200,
          encryption: 'aes-128',
          keyAuthorization: 'webhook',
        },
      ]);
      expect(options).toMatchObject({ cache: false, retry: false });
    });

    it('create sends only the file when no option is given', async () => {
      serviceRequestSpy.mockResolvedValueOnce(session);
      await oxy.assets.streams.create('file-1');
      expect(serviceRequestSpy.mock.calls[0][2]).toEqual({ fileId: 'file-1' });
    });

    it('create refuses a lifetime outside 60–43200 seconds before any request', async () => {
      for (const ttlSeconds of [59, 43_201, 1.5]) {
        await expect(oxy.assets.streams.create('file-1', { ttlSeconds })).rejects.toThrow(
          RangeError,
        );
      }
      expect(serviceRequestSpy).not.toHaveBeenCalled();
    });

    it('get, revoke and revokeWhere address the session routes', async () => {
      serviceRequestSpy
        .mockResolvedValueOnce({ ...session, status: 'revoked' })
        .mockResolvedValueOnce({ sessionId: 'ps/1', revoked: true })
        .mockResolvedValueOnce({ revoked: 3 });
      await oxy.assets.streams.get('ps_1');
      await expect(oxy.assets.streams.revoke('ps/1')).resolves.toEqual({
        sessionId: 'ps/1',
        revoked: true,
      });
      await expect(oxy.assets.streams.revokeWhere({ endUserId: 'user-9' })).resolves.toEqual({
        revoked: 3,
      });
      expect(serviceRequestSpy.mock.calls.map((call) => call.slice(0, 3))).toEqual([
        ['GET', '/assets/service/streams/ps_1', undefined],
        ['DELETE', '/assets/service/streams/ps%2F1', undefined],
        ['POST', '/assets/service/streams/revoke', { endUserId: 'user-9' }],
      ]);
    });

    it('revokeWhere needs a file or an end user', async () => {
      await expect(oxy.assets.streams.revokeWhere({})).rejects.toThrow(/fileId, an endUserId/);
      expect(serviceRequestSpy).not.toHaveBeenCalled();
    });
  });

  describe('recording targets', () => {
    const created = {
      targetId: 'rt_1',
      status: 'awaiting_upload',
      expiresAt: '2026-10-17T00:00:00.000Z',
      filepath: 'rt_1/recording.mp4',
      s3: {
        accessKey: 'rt_1',
        secret: 's',
        region: 'us-east-1',
        endpoint: 'https://api.oxy.so/assets/recording-ingest',
        bucket: 'oxy-recordings',
        forcePathStyle: true,
      },
      livekit: {
        filepath: 'rt_1/recording.mp4',
        s3: {
          access_key: 'rt_1',
          secret: 's',
          region: 'us-east-1',
          endpoint: 'https://api.oxy.so/assets/recording-ingest',
          bucket: 'oxy-recordings',
          force_path_style: true,
        },
      },
    };

    it('createAppRecordingTarget POSTs the options, naming no owner, not retried', async () => {
      serviceRequestSpy.mockResolvedValueOnce(created);
      await expect(
        oxy.assets.createAppRecordingTarget({
          visibility: 'private',
          filename: 'standup.mp4',
          reference: { entityType: 'room', entityId: 'r1' },
          maxBytes: 1024,
          expiresInSeconds: 3600,
          audio: { normalizeLoudness: true },
        }),
      ).resolves.toEqual(created);
      const [method, url, body, options] = serviceRequestSpy.mock.calls[0];
      expect([method, url, body]).toEqual([
        'POST',
        '/assets/service/app/recording-targets',
        {
          visibility: 'private',
          filename: 'standup.mp4',
          reference: { entityType: 'room', entityId: 'r1' },
          maxBytes: 1024,
          expiresInSeconds: 3600,
          audio: { normalizeLoudness: true },
        },
      ]);
      expect(options).toMatchObject({ cache: false, retry: false });
      expect(options.headers).toBeUndefined();
    });

    it('createUserRecordingTarget names the owner on the user-media route', async () => {
      serviceRequestSpy.mockResolvedValueOnce(created);
      await oxy.assets.createUserRecordingTarget('user-1');
      const [method, url, body, options] = serviceRequestSpy.mock.calls[0];
      expect([method, url, body]).toEqual([
        'POST',
        '/assets/service/user-media/recording-targets',
        {},
      ]);
      expect(options.headers).toEqual({ 'x-owner-user-id': 'user-1' });
    });

    it('get and abort address the target, with the owner when there is one', async () => {
      serviceRequestSpy
        .mockResolvedValueOnce({ targetId: 'rt_1', status: 'receiving' })
        .mockResolvedValueOnce({ targetId: 'rt_1', status: 'aborted' });
      await oxy.assets.getRecordingTarget('rt_1', { ownerUserId: 'user-1' });
      await oxy.assets.abortRecordingTarget('rt_1');
      expect(serviceRequestSpy.mock.calls[0].slice(0, 2)).toEqual([
        'GET',
        '/assets/service/user-media/recording-targets/rt_1',
      ]);
      expect(serviceRequestSpy.mock.calls[0][3].headers).toEqual({ 'x-owner-user-id': 'user-1' });
      expect(serviceRequestSpy.mock.calls[1].slice(0, 2)).toEqual([
        'DELETE',
        '/assets/service/app/recording-targets/rt_1',
      ]);
    });

    it('completeRecordingTarget polls while Oxy verifies, then returns the file', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      const completed = { targetId: 'rt_1', status: 'completed', file: userMediaFile };
      serviceRequestSpy
        .mockResolvedValueOnce({ targetId: 'rt_1', status: 'verifying' })
        .mockResolvedValueOnce({ targetId: 'rt_1', status: 'verifying' })
        .mockResolvedValueOnce(completed);
      await expect(settle(oxy.assets.completeRecordingTarget('rt_1'))).resolves.toEqual(completed);
      expect(serviceRequestSpy.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        ['POST', '/assets/service/app/recording-targets/rt_1/complete'],
        ['GET', '/assets/service/app/recording-targets/rt_1'],
        ['GET', '/assets/service/app/recording-targets/rt_1'],
      ]);
    });

    it('a target that failed while polled raises the error complete answers', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      const refusal = new OxyApiError('Blocked', { status: 451, code: 'CONTENT_BLOCKED' });
      serviceRequestSpy
        .mockResolvedValueOnce({ targetId: 'rt_1', status: 'verifying' })
        .mockResolvedValueOnce({
          targetId: 'rt_1',
          status: 'failed',
          error: { code: 'CONTENT_BLOCKED' },
        })
        .mockRejectedValueOnce(refusal);
      await expect(settle(oxy.assets.completeRecordingTarget('rt_1'))).rejects.toBe(refusal);
      expect(serviceRequestSpy.mock.calls[2].slice(0, 2)).toEqual([
        'POST',
        '/assets/service/app/recording-targets/rt_1/complete',
      ]);
    });

    it('stops waiting after waitMs with RECORDING_WAIT_TIMEOUT', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      serviceRequestSpy.mockResolvedValue({ targetId: 'rt_1', status: 'verifying' });
      await expect(
        settle(oxy.assets.completeRecordingTarget('rt_1', { waitMs: 30_000 })),
      ).rejects.toMatchObject({ code: 'RECORDING_WAIT_TIMEOUT', details: { targetId: 'rt_1' } });
    });

    it('a recording not yet written rejects at once (409 propagates)', async () => {
      const refusal = new OxyApiError('Nothing yet', {
        status: 409,
        code: 'RECORDING_NOT_RECEIVED',
      });
      serviceRequestSpy.mockRejectedValueOnce(refusal);
      await expect(oxy.assets.completeRecordingTarget('rt_1')).rejects.toBe(refusal);
      expect(serviceRequestSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('imports Oxy fetches in the background', () => {
    const pending = { importId: 'imp_1', status: 'importing', source: { host: 'feeds.example' } };

    it('sends the audio options, never waitMs or the signal', async () => {
      serviceRequestSpy.mockResolvedValueOnce(importAnswer);
      await oxy.assets.importAppFile('https://feeds.example/ep.mp3', {
        visibility: 'public',
        audio: { normalizeLoudness: true },
        waitMs: 5,
        signal: new AbortController().signal,
      });
      expect(serviceRequestSpy.mock.calls[0][2]).toEqual({
        sourceUrl: 'https://feeds.example/ep.mp3',
        visibility: 'public',
        audio: { normalizeLoudness: true },
      });
    });

    it('importUserMedia follows a 202 and resolves to the import result, the owner on every call', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      serviceRequestSpy
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce({ ...pending, status: 'importing' })
        .mockResolvedValueOnce({ ...pending, status: 'verifying' })
        .mockResolvedValueOnce({
          importId: 'imp_1',
          status: 'completed',
          ...importAnswer,
          reference: { result: 'created' },
        });
      await expect(
        settle(
          oxy.assets.importUserMedia('user-1', 'https://feeds.example/ep.mp3', {
            visibility: 'private',
          }),
        ),
      ).resolves.toEqual({ ...importAnswer, reference: { result: 'created' } });
      const polls = serviceRequestSpy.mock.calls.slice(1);
      expect(polls.map((call) => call.slice(0, 2))).toEqual(
        Array(3).fill(['GET', '/assets/service/user-media/imports/imp_1']),
      );
      for (const call of serviceRequestSpy.mock.calls) {
        expect(call[3].headers).toEqual({ 'x-owner-user-id': 'user-1' });
      }
    });

    it('backs the poll interval off from 2 s to 10 s', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      const at: number[] = [];
      serviceRequestSpy.mockImplementation(async (method: string) => {
        at.push(Date.now());
        if (method === 'POST') return pending;
        return at.length > 8
          ? { importId: 'imp_1', status: 'completed', ...importAnswer }
          : pending;
      });
      await settle(
        oxy.assets.importAppFile('https://feeds.example/ep.mp3', { visibility: 'public' }),
      );
      const gaps = at.slice(1).map((time, index) => time - at[index]);
      expect(gaps[0]).toBe(2_000);
      expect(gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1])).toBe(true);
      expect(Math.max(...gaps)).toBe(10_000);
    });

    it('a failed import rejects with the OxyApiError of its status and code', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      serviceRequestSpy.mockResolvedValueOnce(pending).mockResolvedValueOnce({
        ...pending,
        status: 'failed',
        error: { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Too large' },
      });
      const failure = settle(
        oxy.assets.importAppFile('https://feeds.example/ep.mp3', { visibility: 'public' }),
      );
      await expect(failure).rejects.toBeInstanceOf(OxyApiError);
      await expect(failure).rejects.toMatchObject({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Too large',
        details: { importId: 'imp_1' },
      });
    });

    it('stops waiting after waitMs with IMPORT_WAIT_TIMEOUT naming the import', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      serviceRequestSpy.mockResolvedValue(pending);
      await expect(
        settle(
          oxy.assets.importAppFile('https://feeds.example/ep.mp3', {
            visibility: 'public',
            waitMs: 15_000,
          }),
        ),
      ).rejects.toMatchObject({ code: 'IMPORT_WAIT_TIMEOUT', details: { importId: 'imp_1' } });
    });

    it('an abort stops the wait', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      const controller = new AbortController();
      serviceRequestSpy.mockResolvedValue(pending);
      const work = oxy.assets.importAppFile('https://feeds.example/ep.mp3', {
        visibility: 'public',
        signal: controller.signal,
      });
      work.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(3_000);
      controller.abort(new Error('stop'));
      await expect(work).rejects.toThrow('stop');
      const calls = serviceRequestSpy.mock.calls.length;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(serviceRequestSpy.mock.calls.length).toBe(calls);
    });

    it('importAppFiles waits for pending items and answers each in place', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      serviceRequestSpy.mockImplementation(async (method: string, url: string) => {
        if (method === 'POST') {
          return {
            results: [
              { index: 0, ok: true, ...importAnswer },
              { index: 1, ok: true, pending: true, ...pending },
              { index: 2, ok: true, pending: true, ...pending, importId: 'imp_2' },
            ],
          };
        }
        return url.endsWith('imp_1')
          ? { importId: 'imp_1', status: 'completed', ...importAnswer }
          : {
              importId: 'imp_2',
              status: 'failed',
              source: pending.source,
              error: { status: 502, code: 'SOURCE_FETCH_FAILED', message: 'gone' },
            };
      });
      const results = await settle(
        oxy.assets.importAppFiles(
          ['a', 'b', 'c'].map((name) => ({
            sourceUrl: `https://feeds.example/${name}.mp3`,
            visibility: 'public' as const,
          })),
        ),
      );
      expect(results).toEqual([
        { index: 0, ok: true, ...importAnswer },
        { index: 1, ok: true, ...importAnswer },
        {
          index: 2,
          ok: false,
          error: { status: 502, code: 'SOURCE_FETCH_FAILED', message: 'gone' },
        },
      ]);
    });

    it('getImport reads one import, on the owner family it names', async () => {
      serviceRequestSpy.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending);
      await oxy.assets.getImport('imp_1');
      await oxy.assets.getImport('imp_1', { ownerUserId: 'user-1' });
      expect(serviceRequestSpy.mock.calls[0].slice(0, 2)).toEqual([
        'GET',
        '/assets/service/app/imports/imp_1',
      ]);
      expect(serviceRequestSpy.mock.calls[1].slice(0, 2)).toEqual([
        'GET',
        '/assets/service/user-media/imports/imp_1',
      ]);
      expect(serviceRequestSpy.mock.calls[1][3].headers).toEqual({ 'x-owner-user-id': 'user-1' });
    });
  });
});
