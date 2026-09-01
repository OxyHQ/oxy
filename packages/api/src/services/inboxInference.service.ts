/**
 * Stateless inference policy for Inbox point actions only.
 *
 * This is intentionally not an Alia chat adapter: its contract has no
 * conversation, agent, tool or memory fields. Alia-powered conversational UI
 * must keep calling Alia, which remains responsible for those capabilities
 * before it reaches Kaana.
 */
import {
  OxyInferenceClient,
  OxyInferenceError,
  OxyServices,
  type OxyInferenceResponse,
  type OxyResponsesRequest,
} from '@oxyhq/core';
import type { InferenceMessage, InferenceStreamEvent } from '@oxyhq/contracts';
import { ENV_DEFAULTS } from '../config/env';
import { ApiError, ErrorCodes } from '../utils/error';
import type { InboxInferenceRequest, InboxInferenceResponse } from '../schemas/inboxInference.schemas';

interface InboxInferenceConfiguration {
  apiKey: string;
  apiSecret: string;
  baseURL: string;
}

interface ConfiguredInferenceClient extends InboxInferenceConfiguration {
  oxy: OxyServices;
  inference: OxyInferenceClient;
}

let configuredClient: ConfiguredInferenceClient | undefined;

export class InboxInferenceUnavailableError extends ApiError {
  constructor(message = 'Inbox inference is not configured') {
    super(503, message, ErrorCodes.SERVICE_UNAVAILABLE);
    this.name = 'InboxInferenceUnavailableError';
  }
}

function readConfiguration(): InboxInferenceConfiguration {
  const apiKey = process.env.INBOX_INFERENCE_SERVICE_API_KEY?.trim();
  const apiSecret = process.env.INBOX_INFERENCE_SERVICE_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    throw new InboxInferenceUnavailableError();
  }
  if (!apiKey.startsWith('oxy_dk_')) {
    throw new InboxInferenceUnavailableError('Inbox inference has an invalid application credential');
  }

  const configuredBaseURL = process.env.INBOX_INFERENCE_EDGE_BASE_URL?.trim();
  const baseURL = configuredBaseURL || `http://127.0.0.1:${process.env.PORT || ENV_DEFAULTS.PORT}`;
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new InboxInferenceUnavailableError('Inbox inference edge URL is invalid');
  }

  const isLoopback = ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new InboxInferenceUnavailableError('Inbox inference edge URL is invalid');
  }

  return {
    apiKey,
    apiSecret,
    baseURL: parsed.toString().replace(/\/$/, ''),
  };
}

function clientForConfiguration(): ConfiguredInferenceClient {
  const configuration = readConfiguration();
  if (
    configuredClient?.apiKey === configuration.apiKey &&
    configuredClient.apiSecret === configuration.apiSecret &&
    configuredClient.baseURL === configuration.baseURL
  ) {
    return configuredClient;
  }

  const oxy = new OxyServices({
    baseURL: configuration.baseURL,
    enableCache: false,
    enableRetry: false,
  });
  oxy.configureServiceAuth(configuration.apiKey, configuration.apiSecret);
  configuredClient = {
    ...configuration,
    oxy,
    inference: new OxyInferenceClient({
      baseURL: configuration.baseURL,
      credential: () => oxy.getServiceToken(),
    }),
  };
  return configuredClient;
}

function textMessage(role: InferenceMessage['role'], text: string): InferenceMessage {
  return { role, content: [{ type: 'text', text }] };
}

interface FeatureRequest {
  request: OxyResponsesRequest;
  streamable: boolean;
}

/**
 * Translate product data into the public edge request. Every instruction,
 * ceiling, sampling control and label is chosen here; the browser never sends
 * any of them and cannot select a model or routing profile. The dedicated
 * Inbox application's routing policy owns the default target. This function
 * must not be used to translate Alia conversations into generic responses.
 */
export function buildInboxInferenceRequest(input: InboxInferenceRequest): FeatureRequest {
  const feature = input.feature;
  const base = {
    labels: { product: 'inbox', feature },
  } as const;

  switch (input.feature) {
    case 'compose-draft':
      return {
        streamable: true,
        request: {
          ...base,
          input: [
            textMessage(
              'system',
              'Write a complete email body from the supplied notes. Match the requested tone, preserve the user intent, include a greeting and sign-off when appropriate, and output only the email body.',
            ),
            textMessage('user', `Tone: ${input.tone}\n\nNotes:\n${input.prompt}`),
          ],
          maxOutputTokens: 800,
          temperature: 0.7,
        },
      };
    case 'compose-polish':
      return {
        streamable: false,
        request: {
          ...base,
          input: [
            textMessage(
              'system',
              'Improve grammar, clarity and flow while preserving meaning, tone, greeting, sign-off and approximate length. Output only the polished email body.',
            ),
            textMessage('user', input.text),
          ],
          maxOutputTokens: 1_000,
          temperature: 0.5,
        },
      };
    case 'compose-change-tone':
      return {
        streamable: false,
        request: {
          ...base,
          input: [
            textMessage(
              'system',
              'Rewrite the supplied email in the requested tone while preserving its core message. Output only the rewritten email body.',
            ),
            textMessage('user', `Tone: ${input.tone}\n\nEmail:\n${input.text}`),
          ],
          maxOutputTokens: 1_000,
          temperature: 0.6,
        },
      };
    case 'compose-adjust-length':
      return {
        streamable: false,
        request: {
          ...base,
          input: [
            textMessage(
              'system',
              'Rewrite the supplied email to the requested length while preserving its key message, tone, greeting and sign-off. Output only the rewritten email body.',
            ),
            textMessage('user', `Direction: ${input.direction}\n\nEmail:\n${input.text}`),
          ],
          maxOutputTokens: input.direction === 'longer' ? 1_500 : 500,
          temperature: 0.5,
        },
      };
    case 'compose-subject':
      return {
        streamable: false,
        request: {
          ...base,
          input: [
            textMessage(
              'system',
              'Generate one specific email subject under 60 characters. Do not use clickbait or all caps. Output only the subject without quotes.',
            ),
            textMessage('user', input.body),
          ],
          maxOutputTokens: 60,
          temperature: 0.6,
        },
      };
    case 'daily-brief':
      return {
        streamable: true,
        request: {
          ...base,
          input: [
            textMessage(
              'system',
              'Write a concise two-to-four sentence inbox brief using only the aggregate counts supplied. Never claim knowledge of senders, subjects, message contents, deadlines or action items. Use second person and output only the brief.',
            ),
            textMessage(
              'user',
              `${input.counts.total} total emails, ${input.counts.unread} unread, ${input.counts.starred} starred, ${input.counts.withAttachments} with attachments.`,
            ),
          ],
          maxOutputTokens: 300,
          temperature: 0.7,
        },
      };
    case 'natural-language-search':
      return {
        streamable: false,
        request: {
          ...base,
          input: [
            textMessage(
              'system',
              'Convert the search request into a JSON object with only these optional keys: q, from, to, subject, hasAttachment, starred, unread, after, before, mailbox, interpretation. Dates use YYYY-MM-DD. Omit unknown fields.',
            ),
            textMessage('user', input.query),
          ],
          maxOutputTokens: 500,
          temperature: 0.2,
          responseFormat: { type: 'json_object' },
        },
      };
    case 'smart-replies':
      return {
        streamable: false,
        request: {
          ...base,
          input: [
            textMessage(
              'system',
              'Return a JSON object with one key, "replies", containing exactly three concise, contextually appropriate email reply suggestions. Return only that JSON object.',
            ),
            textMessage(
              'user',
              `From: ${input.message.sender}\nSubject: ${input.message.subject}\n\n${input.message.body}`,
            ),
          ],
          maxOutputTokens: 150,
          temperature: 0.7,
          responseFormat: { type: 'json_object' },
        },
      };
    case 'thread-summary':
      return {
        streamable: false,
        request: {
          ...base,
          input: [
            textMessage(
              'system',
              'Return a JSON object with summary, keyPoints and actionItems. Each action item has text, owner and deadline; use null when owner or deadline is unknown. Do not invent facts.',
            ),
            textMessage(
              'user',
              input.messages
                .map(
                  (message) =>
                    `From: ${message.sender}${message.sentAt ? `\nDate: ${message.sentAt}` : ''}\n\n${message.body}`,
                )
                .join('\n\n---\n\n'),
            ),
          ],
          maxOutputTokens: 600,
          temperature: 0.5,
          responseFormat: { type: 'json_object' },
        },
      };
  }
}

function responseText(response: OxyInferenceResponse): string {
  return response.output
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .flatMap((part) => (part.type === 'text' || part.type === 'refusal' ? [part.text] : []))
    .join('');
}

function mapUpstreamFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof OxyInferenceError) {
    const status = error.status === 429 ? 429 : 503;
    return new ApiError(status, 'Inbox inference is temporarily unavailable', error.code, {
      requestId: error.requestId,
      retryable: error.retryable,
    });
  }
  return new InboxInferenceUnavailableError('Inbox inference is temporarily unavailable');
}

export async function runInboxInference(
  input: InboxInferenceRequest,
  userId: string,
  signal: AbortSignal,
): Promise<InboxInferenceResponse> {
  const { inference, oxy } = clientForConfiguration();
  const { request } = buildInboxInferenceRequest(input);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await inference.respond(request, {
        delegatedUserId: userId,
        signal,
      });
      return { text: responseText(response), requestId: response.requestId };
    } catch (error) {
      if (attempt === 0 && error instanceof OxyInferenceError && error.status === 401) {
        oxy.invalidateServiceToken();
        continue;
      }
      throw mapUpstreamFailure(error);
    }
  }

  throw new InboxInferenceUnavailableError('Inbox inference authentication failed');
}

export async function* streamInboxInference(
  input: InboxInferenceRequest,
  userId: string,
  signal: AbortSignal,
): AsyncGenerator<InferenceStreamEvent> {
  const { inference, oxy } = clientForConfiguration();
  const built = buildInboxInferenceRequest(input);
  if (!built.streamable) {
    throw new ApiError(400, `${input.feature} does not support streaming`, ErrorCodes.BAD_REQUEST);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let emitted = false;
    try {
      for await (const event of inference.stream(built.request, {
        delegatedUserId: userId,
        signal,
      })) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      if (!emitted && attempt === 0 && error instanceof OxyInferenceError && error.status === 401) {
        oxy.invalidateServiceToken();
        continue;
      }
      throw mapUpstreamFailure(error);
    }
  }

  throw new InboxInferenceUnavailableError('Inbox inference authentication failed');
}

export function resetInboxInferenceClientForTests(): void {
  configuredClient = undefined;
}
