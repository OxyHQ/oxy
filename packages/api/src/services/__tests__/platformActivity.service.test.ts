import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { Namespace } from 'socket.io';
import {
  initializePlatformActivity,
  PLATFORM_ACTIVITY_EVENT,
  platformActivityMiddleware,
  stopPlatformActivity,
} from '../platformActivity.service';

describe('platform activity', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.AWS_REGION = 'us-west-2';
  });

  afterEach(() => {
    stopPlatformActivity();
    jest.useRealTimers();
  });

  it('emits aggregate incoming requests and observed outgoing responses with an edge origin', () => {
    const namespace = { emit: jest.fn() } as unknown as Namespace;
    initializePlatformActivity(namespace);

    for (let index = 0; index < 5; index += 1) {
      const response = new EventEmitter() as unknown as Response;
      Object.defineProperty(response, 'statusCode', { value: 200 });
      platformActivityMiddleware(
        {
          path: `/messages/private-id-${index}`,
          headers: { 'cf-ray': '7f00deadbeef-CDG' },
        } as unknown as Request,
        response,
        jest.fn(),
      );
      response.emit('finish');
    }

    jest.advanceTimersByTime(2_000);

    expect(namespace.emit).toHaveBeenCalledWith(
      PLATFORM_ACTIVITY_EVENT,
      expect.objectContaining({
        direction: 'inbound',
        region: 'us-west-2',
        sourceRegion: 'edge-cdg',
        targetRegion: 'us-west-2',
        requests: 5,
        activeClients: 0,
        service: 'oxy-api',
        activityType: 'communication',
        scope: 'external',
      }),
    );
    expect(namespace.emit).toHaveBeenCalledWith(PLATFORM_ACTIVITY_EVENT, expect.objectContaining({ direction: 'outbound', sourceRegion: 'us-west-2', targetRegion: 'edge-cdg', requests: 5 }));
    expect(JSON.stringify((namespace.emit as jest.Mock).mock.calls)).not.toContain('private-id');
  });

  it('includes failed HTTP responses because they are real network activity', () => {
    const namespace = { emit: jest.fn() } as unknown as Namespace;
    initializePlatformActivity(namespace);
    const response = new EventEmitter() as unknown as Response;
    Object.defineProperty(response, 'statusCode', { value: 500 });
    platformActivityMiddleware(
      { path: '/files/a-private-file-id', headers: {} } as unknown as Request,
      response,
      jest.fn(),
    );
    response.emit('finish');

    jest.advanceTimersByTime(2_000);

    expect(namespace.emit).toHaveBeenCalledWith(PLATFORM_ACTIVITY_EVENT, expect.objectContaining({ direction: 'inbound', requests: 1, activityType: 'media' }));
    expect(namespace.emit).toHaveBeenCalledWith(PLATFORM_ACTIVITY_EVENT, expect.objectContaining({ direction: 'outbound', requests: 1, activityType: 'media' }));
  });

  it('uses the validated SDK edge region when the API is not behind Cloudflare', () => {
    const namespace = { emit: jest.fn() } as unknown as Namespace;
    initializePlatformActivity(namespace);

    for (let index = 0; index < 5; index += 1) {
      const response = new EventEmitter() as unknown as Response;
      Object.defineProperty(response, 'statusCode', { value: 204 });
      platformActivityMiddleware(
        {
          path: '/session/status',
          headers: { 'x-oxy-edge-region': 'MAD' },
        } as unknown as Request,
        response,
        jest.fn(),
      );
      response.emit('finish');
    }

    jest.advanceTimersByTime(2_000);

    expect(namespace.emit).toHaveBeenCalledWith(
      PLATFORM_ACTIVITY_EVENT,
      expect.objectContaining({ sourceRegion: 'edge-mad', requests: 5 }),
    );
  });

  it('counts an active client once across repeated requests', () => {
    const namespace = { emit: jest.fn() } as unknown as Namespace;
    initializePlatformActivity(namespace);

    for (let index = 0; index < 3; index += 1) {
      const response = new EventEmitter() as unknown as Response;
      Object.defineProperty(response, 'statusCode', { value: 200 });
      platformActivityMiddleware(
        {
          path: '/messages',
          headers: {
            'x-oxy-edge-region': 'MAD',
            'x-oxy-activity-id': 'anonymous-runtime-a1',
          },
        } as unknown as Request,
        response,
        jest.fn(),
      );
      response.emit('finish');
    }

    jest.advanceTimersByTime(2_000);
    expect(namespace.emit).toHaveBeenCalledWith(
      PLATFORM_ACTIVITY_EVENT,
      expect.objectContaining({ sourceRegion: 'edge-mad', requests: 3, activeClients: 1 }),
    );
  });

  it('rejects an invalid forwarded edge region', () => {
    const namespace = { emit: jest.fn() } as unknown as Namespace;
    initializePlatformActivity(namespace);

    for (let index = 0; index < 5; index += 1) {
      const response = new EventEmitter() as unknown as Response;
      Object.defineProperty(response, 'statusCode', { value: 200 });
      platformActivityMiddleware(
        {
          path: '/messages',
          headers: { 'x-oxy-edge-region': 'private-location' },
        } as unknown as Request,
        response,
        jest.fn(),
      );
      response.emit('finish');
    }

    jest.advanceTimersByTime(2_000);
    expect(namespace.emit).toHaveBeenCalledWith(
      PLATFORM_ACTIVITY_EVENT,
      expect.objectContaining({ sourceRegion: undefined, direction: 'inbound' }),
    );
  });
});
