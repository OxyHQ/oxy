import { Router, type Response } from 'express';
import {
  inboxComposeRequestSchema,
  inboxDailyBriefRequestSchema,
  inboxMessageInferenceParamsSchema,
  inboxNaturalSearchRequestSchema,
  inboxNaturalSearchResponseSchema,
  inboxSmartRepliesResponseSchema,
  inboxThreadSummaryResponseSchema,
  type InboxComposeRequest,
} from '@oxyhq/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { emailService, type MessageDto } from '../services/email.service';
import {
  executeInboxPointInference,
  inboxCompletionText,
  streamInboxPointInference,
  type InboxPointInferenceInput,
} from '../services/inboxInference.service';
import { asyncHandler } from '../utils/asyncHandler';
import { NotFoundError } from '../utils/error';
import { inferenceErrorStatus } from '../utils/inferenceEdgeErrors';

const router = Router();
const JSON_FORMAT = { type: 'json_object' as const };
const MAX_THREAD_MESSAGES = 30;
const MAX_THREAD_BODY_CHARS = 800;
const SMART_REPLY_SENSITIVE_WORDS = [
  'password', 'passcode', 'one-time code', 'one time code', 'otp', '2fa', 'mfa',
  'verification code', 'security code', 'reset', 'verify your', 'confirm your account',
  'banking', 'transaction', 'invoice', 'payment', 'credit card', 'ssn', 'social security',
] as const;
const SMART_REPLY_SENSITIVE_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b(?:code|pin|otp)\s*[:#-]?\s*\d{4,8}\b/i,
] as const;
const SIX_DIGIT_CODE_PATTERN = /\b\d{6}\b/;
const SECURITY_WORD_PATTERN = /\b(?:code|pin|otp|verify|verification)\b/i;

const inboxAiLimiter = rateLimit({
  prefix: 'rl:email:ai:',
  windowMs: 60_000,
  max: 30,
  keyGenerator: (request) => (request as AuthRequest).user?.id ?? 'unauthenticated',
});

router.use(authMiddleware, inboxAiLimiter);

function userId(request: AuthRequest): string {
  // This router deliberately accepts a human session, not an email capability.
  return request.user!.id;
}

function signalFor(response: Response): AbortSignal {
  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller.signal;
}

function messages(system: string, prompt: string) {
  return [
    { role: 'system' as const, content: [{ type: 'text' as const, text: system }] },
    { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
  ];
}

const COMPOSE_PROMPTS = {
  draft: 'Write a complete email from the supplied notes. Match the requested tone, be concise, include a greeting and sign-off where appropriate, and output only the email body.',
  polish: 'Polish the supplied email for grammar, clarity and flow while preserving meaning, tone, greeting and sign-off. Output only the revised email.',
  change_tone: 'Rewrite the supplied email in the requested tone while preserving its meaning. Output only the revised email.',
  adjust_length: 'Rewrite the supplied email to the requested length while preserving its key message, tone, greeting and sign-off. Output only the revised email.',
  suggest_subject: 'Generate one clear email subject under 60 characters. Do not use clickbait, all caps or quotation marks. Output only the subject.',
} as const;

function composePrompt(input: InboxComposeRequest): string {
  switch (input.operation) {
    case 'draft': return `Tone: ${input.tone}\n\nNotes:\n${input.prompt}`;
    case 'polish': return input.text;
    case 'change_tone': return `Tone: ${input.tone}\n\nEmail:\n${input.text}`;
    case 'adjust_length': return `Direction: ${input.direction}\n\nEmail:\n${input.text}`;
    case 'suggest_subject': return input.body;
  }
}

function composeOutputLimit(input: InboxComposeRequest): number {
  if (input.operation === 'suggest_subject') return 60;
  if (input.operation === 'adjust_length') return input.direction === 'longer' ? 1_500 : 500;
  return input.operation === 'draft' ? 800 : 1_000;
}

function textResponse(completion: Awaited<ReturnType<typeof executeInboxPointInference>>) {
  return {
    schemaVersion: 1 as const,
    requestId: completion.requestId,
    ...(completion.generationId === undefined ? {} : { generationId: completion.generationId }),
    text: inboxCompletionText(completion),
  };
}

async function streamText(response: Response, input: InboxPointInferenceInput): Promise<void> {
  let opened = false;
  for await (const frame of streamInboxPointInference(input)) {
    if (frame.kind === 'open') {
      opened = true;
      response.status(200);
      response.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      continue;
    }
    if (frame.kind === 'error') {
      if (!opened) {
        response.status(inferenceErrorStatus(frame.error.code)).json({ error: frame.error });
        return;
      }
      response.write(`data: ${JSON.stringify({ type: 'error', error: frame.error })}\n\n`);
      response.end();
      return;
    }
    const event = frame.event;
    if (event.type === 'delta' && event.channel === 'output_text' && event.text) {
      response.write(`data: ${JSON.stringify({ type: 'delta', text: event.text })}\n\n`);
    } else if (event.type === 'error') {
      response.write(`data: ${JSON.stringify({ type: 'error', error: event.error })}\n\n`);
      response.end();
      return;
    } else if (event.type === 'done') {
      response.write(`data: ${JSON.stringify({
        type: 'done', requestId: event.requestId,
        ...(event.generationId === undefined ? {} : { generationId: event.generationId }),
      })}\n\n`);
    }
    if (response.destroyed) return;
  }
  response.end();
}

router.post('/compose', validate({ body: inboxComposeRequestSchema }), asyncHandler(async (request: AuthRequest, response) => {
  const body = request.body as InboxComposeRequest;
  const input: InboxPointInferenceInput = {
    userId: userId(request),
    feature: 'compose',
    messages: messages(COMPOSE_PROMPTS[body.operation], composePrompt(body)),
    maxOutputTokens: composeOutputLimit(body),
    temperature: body.operation === 'draft' ? 0.7 : 0.5,
    signal: signalFor(response),
  };
  if (body.operation === 'draft' && body.stream === true) {
    await streamText(response, input);
    return;
  }
  response.json(textResponse(await executeInboxPointInference(input)));
}));

router.post('/daily-brief', validate({ body: inboxDailyBriefRequestSchema }), asyncHandler(async (request: AuthRequest, response) => {
  const recent = await emailService.listMessages(userId(request), null, { limit: 100, offset: 0 });
  const counts = {
    total: recent.total,
    recent: recent.data.length,
    unread: recent.data.filter((message) => !message.flags.seen).length,
    starred: recent.data.filter((message) => message.flags.starred).length,
    withAttachments: recent.data.filter((message) => message.attachments.length > 0).length,
  };
  const input: InboxPointInferenceInput = {
    userId: userId(request),
    feature: 'daily_brief',
    messages: messages(
      'Write a warm, efficient daily inbox brief in 2-4 sentences and second person. Use only the supplied aggregate counts; never imply access to senders, subjects, bodies, deadlines or action items.',
      `Aggregate counts: ${JSON.stringify(counts)}`,
    ),
    maxOutputTokens: 300,
    temperature: 0.7,
    signal: signalFor(response),
  };
  if (request.body.stream === true) {
    await streamText(response, input);
    return;
  }
  response.json(textResponse(await executeInboxPointInference(input)));
}));

router.post('/natural-search', validate({ body: inboxNaturalSearchRequestSchema }), asyncHandler(async (request: AuthRequest, response) => {
  const natural = request.body.query as string;
  const completion = await executeInboxPointInference({
    userId: userId(request), feature: 'natural_search', maxOutputTokens: 250, temperature: 0.2,
    responseFormat: JSON_FORMAT, signal: signalFor(response),
    messages: messages(
      'Convert an email search request to JSON: {"query":{q?,from?,to?,subject?,hasAttachment?,starred?,unread?,after?,before?,mailbox?},"interpretation":"..."}. Dates use YYYY-MM-DD. Mailbox is inbox, sent, drafts, trash, spam or archive. Include no other keys.',
      `Today is ${new Date().toISOString().slice(0, 10)}. Search request: ${natural}`,
    ),
  });
  const parsed = parseModelJson(inboxNaturalSearchResponseSchema, inboxCompletionText(completion));
  response.json(parsed ?? { query: { q: natural }, interpretation: `Searching for "${natural}"` });
}));

router.post('/messages/:messageId/smart-replies', validate({ params: inboxMessageInferenceParamsSchema }), asyncHandler(async (request: AuthRequest, response) => {
  const message = await emailService.getMessage(userId(request), request.params.messageId);
  if (!message) throw new NotFoundError('Message not found');
  if (shouldSkipSmartReplies(message)) {
    response.json({ replies: [] });
    return;
  }
  const completion = await executeInboxPointInference({
    userId: userId(request), feature: 'smart_replies', maxOutputTokens: 150, temperature: 0.7,
    responseFormat: JSON_FORMAT, signal: signalFor(response),
    messages: messages(
      'Generate exactly three short contextual replies, each 2-8 words and ready to send. Return only JSON {"replies":["...","...","..."]}.',
      messagePrompt(message, 1_500),
    ),
  });
  response.json(parseModelJson(inboxSmartRepliesResponseSchema, inboxCompletionText(completion)) ?? { replies: [] });
}));

router.post('/messages/:messageId/thread-summary', validate({ params: inboxMessageInferenceParamsSchema }), asyncHandler(async (request: AuthRequest, response) => {
  const thread = await emailService.getThread(userId(request), request.params.messageId);
  const bounded = thread.slice(-MAX_THREAD_MESSAGES).map((message, index) =>
    `[${index + 1}] ${message.from.name || message.from.address} | ${message.date.toISOString()}\n${plainText(message).slice(0, MAX_THREAD_BODY_CHARS)}`,
  ).join('\n\n---\n\n');
  const completion = await executeInboxPointInference({
    userId: userId(request), feature: 'thread_summary', maxOutputTokens: 600, temperature: 0.4,
    responseFormat: JSON_FORMAT, signal: signalFor(response),
    messages: messages(
      'Summarize the thread as JSON {"summary":"...","keyPoints":["..."],"actionItems":[{"text":"...","owner":null,"deadline":null}]}. State only supplied facts; use null when owner or deadline is absent.',
      bounded,
    ),
  });
  response.json(parseModelJson(inboxThreadSummaryResponseSchema, inboxCompletionText(completion)) ?? { summary: '', keyPoints: [], actionItems: [] });
}));

function plainText(message: MessageDto): string {
  return (message.text || message.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function messagePrompt(message: MessageDto, bodyLimit: number): string {
  return `From: ${message.from.name || message.from.address}\nSubject: ${message.subject || '(no subject)'}\n\n${plainText(message).slice(0, bodyLimit)}`;
}

function hasSixDigitCodeBeforeSecurityWord(content: string): boolean {
  const code = SIX_DIGIT_CODE_PATTERN.exec(content);
  if (!code) return false;
  return SECURITY_WORD_PATTERN.test(content.slice(code.index + code[0].length));
}

function shouldSkipSmartReplies(message: MessageDto): boolean {
  const sender = message.from.address.toLowerCase();
  const content = `${message.subject} ${plainText(message)}`.toLowerCase();
  if (['noreply', 'no-reply', 'donotreply', 'newsletter', 'marketing', 'promo'].some((word) => sender.includes(word))) return true;
  return SMART_REPLY_SENSITIVE_WORDS.some((word) => content.includes(word))
    || SMART_REPLY_SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))
    || hasSixDigitCodeBeforeSecurityWord(content);
}

function parseModelJson<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, raw: string): T | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    void error;
    return null;
  }
}

export default router;
