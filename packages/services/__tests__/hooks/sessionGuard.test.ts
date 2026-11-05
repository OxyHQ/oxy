import { QueryClient } from '@tanstack/react-query';
import { HttpService } from '../../../core/src/HttpService';

function token(userId: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ userId, sessionId: userId })}.signature`;
}

it('prevents a pending mutation from writing A data after the account changes to B', async () => {
  const http = new HttpService({ baseURL: 'https://example.test' });
  const client = new QueryClient();
  http.setTokens(token('alice'));
  const stillAlice = http.captureSessionGuard();
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const mutation = client.getMutationCache().build(client, {
    mutationFn: () => pending,
    onSuccess: (value) => {
      if (stillAlice()) client.setQueryData(['screen'], value);
    },
  });
  const request = mutation.execute(undefined);
  await Promise.resolve();
  http.setTokens(token('bob'));
  client.clear();
  client.setQueryData(['screen'], 'bob data');
  finish('alice data');
  await request;
  expect(client.getQueryData(['screen'])).toBe('bob data');
});

it('prevents a pending failure rollback from writing after sign-out and sign-in again', async () => {
  const http = new HttpService({ baseURL: 'https://example.test' });
  const client = new QueryClient();
  http.setTokens(token('alice'));
  const stillAlice = http.captureSessionGuard();
  let fail!: (error: Error) => void;
  const pending = new Promise<string>((_resolve, reject) => {
    fail = reject;
  });
  const mutation = client.getMutationCache().build(client, {
    mutationFn: () => pending,
    onError: () => {
      if (stillAlice()) client.setQueryData(['screen'], 'old rollback');
    },
  });
  const request = mutation.execute(undefined).catch(() => {});
  await Promise.resolve();
  http.endSession();
  http.setTokens(token('bob'));
  http.setTokens(token('alice'));
  client.clear();
  client.setQueryData(['screen'], 'new alice data');
  fail(new Error('old request failed'));
  await request;
  expect(client.getQueryData(['screen'])).toBe('new alice data');
});
