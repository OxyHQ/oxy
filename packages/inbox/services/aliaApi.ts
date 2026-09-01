/**
 * Alia AI API client
 *
 * Proxies requests through the Oxy backend API (`api.oxy.so`) which handles
 * Alia API key management server-side. That backend IS the origin the
 * OxyProvider session owner already talks to, so authentication rides the
 * SDK's own `HttpService` — no app-local token provider, interceptor, or
 * manual `Authorization` plumbing (see `@oxyhq/services` D4 contract).
 */

import type { OxyServices } from '@oxyhq/core';
import { AliaChatResponseSchema } from '@/schemas/aiSchemas';

type HttpService = OxyServices['httpService'];

const ALIA_COMPLETIONS_PATH = '/alia/chat/completions';

// Matches the OxyProvider baseURL wired in `app/_layout.tsx`; only used by the
// streaming path, which must issue a raw fetch (HttpService has no streaming
// body — it fully reads every response).
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';

export interface AliaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AliaRequestOptions {
  model?: 'alia-lite' | 'alia-v1' | 'alia-v1-pro' | 'alia-v1-pro-max';
  messages: AliaMessage[];
  maxTokens?: number;
  temperature?: number;
}

function buildRequestBody(options: AliaRequestOptions, stream: boolean) {
  return {
    model: options.model ?? 'alia-lite',
    messages: options.messages,
    max_tokens: options.maxTokens ?? 512,
    temperature: options.temperature ?? 0.7,
    stream,
  };
}

/**
 * Extract the text deltas from a run of complete SSE lines.
 *
 * Shared by the incremental reader and the buffered fallback below, so a
 * runtime without `ReadableStream` decodes exactly the same wire format
 * instead of mis-parsing an `text/event-stream` body as a JSON envelope.
 *
 * `data:` is matched with or without the conventional trailing space — the SSE
 * spec makes that space optional, and silently yielding nothing for a compliant
 * `data:{…}` frame is indistinguishable from "the model returned nothing".
 */
function scanSseLines(lines: string[]): { deltas: string[]; done: boolean } {
  const deltas: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;

    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return { deltas, done: true };

    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      // A frame that is not valid JSON is a keep-alive or a truncated chunk,
      // never a delta. Skipping it is the documented SSE behaviour.
      continue;
    }

    const parsed = AliaChatResponseSchema.safeParse(json);
    if (!parsed.success) continue;

    const choice = parsed.data.choices?.[0];
    // Streaming frames carry `delta.content`; a non-streaming envelope that
    // arrives on this channel carries `message.content`.
    const delta = choice?.delta?.content ?? choice?.message?.content;
    if (delta) deltas.push(delta);
  }

  return { deltas, done: false };
}

/**
 * Non-streaming chat completion. Returns the full response text.
 *
 * Routes through the SDK `HttpService`, which owns the bearer token
 * (auto-refresh + 401 retry). No manual `Authorization` header.
 */
export async function aliaChatCompletion(
  http: HttpService,
  options: AliaRequestOptions,
): Promise<string> {
  const response = await http.post<unknown>(
    ALIA_COMPLETIONS_PATH,
    buildRequestBody(options, false),
  );
  // Validate the transport envelope; a malformed response yields empty text
  // rather than throwing on an unexpected shape.
  const parsed = AliaChatResponseSchema.safeParse(response);
  if (!parsed.success) return '';
  return parsed.data.choices?.[0]?.message?.content ?? '';
}

/**
 * Stream a chat completion from Alia. Yields text deltas as they arrive.
 *
 * `HttpService` has no streaming path (`request()` fully reads the body), so
 * this SSE call must use a raw `fetch`. The endpoint is same-origin with the
 * session owner (`api.oxy.so`), so we borrow the SDK-owned access token for the
 * `Authorization` header — the same sanctioned same-origin pattern
 * `useInboxSocket` uses for its socket.io handshake. This is NOT an app-local
 * auth interceptor or token provider.
 */
export async function* streamAliaChatCompletion(
  http: HttpService,
  options: AliaRequestOptions,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const token = http.getAccessToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  // Handing the signal to `fetch` cancels the request itself. Abandoning the
  // generator without it leaves the response downloading in the background.
  const response = await fetch(`${API_URL}${ALIA_COMPLETIONS_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(buildRequestBody(options, true)),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Alia API error ${response.status}: ${text}`);
  }

  // Runtimes without `ReadableStream` (the React Native fetch polyfill) buffer
  // the whole body. It is still the `text/event-stream` we asked for, so decode
  // it as SSE — `response.json()` would throw a parse error on those frames and
  // surface as a mystery failure on native only.
  if (!response.body || typeof response.body.getReader !== 'function') {
    const { deltas } = scanSseLines((await response.text()).split('\n'));
    for (const delta of deltas) yield delta;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // The trailing element is whatever arrived after the last newline — an
      // incomplete frame that must wait for the next chunk.
      buffer = lines.pop() ?? '';

      const scan = scanSseLines(lines);
      for (const delta of scan.deltas) yield delta;
      if (scan.done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
