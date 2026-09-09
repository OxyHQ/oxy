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

  it('emits only k-anonymous, route-grouped inbound buckets', () => {
    const namespace = { emit: jest.fn() } as unknown as Namespace;
    initializePlatformActivity(namespace);

    for (let index = 0; index < 5; index += 1) {
      const response = new EventEmitter() as unknown as Response;
      Object.defineProperty(response, 'statusCode', { value: 200 });
      platformActivityMiddleware(
        { path: `/messages/private-id-${index}` } as Request,
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
        requests: 5,
        service: 'messages',
      }),
    );
    expect(JSON.stringify((namespace.emit as jest.Mock).mock.calls)).not.toContain('private-id');
  });

  it('does not emit a service bucket below the privacy threshold', () => {
    const namespace = { emit: jest.fn() } as unknown as Namespace;
    initializePlatformActivity(namespace);
    const response = new EventEmitter() as unknown as Response;
    Object.defineProperty(response, 'statusCode', { value: 200 });
    platformActivityMiddleware({ path: '/files/a-private-file-id' } as Request, response, jest.fn());
    response.emit('finish');

    jest.advanceTimersByTime(2_000);

    expect(namespace.emit).not.toHaveBeenCalled();
  });
});
