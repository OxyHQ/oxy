import { Badge } from '@oxy.so/bloom/badge';

import {
  DocCode,
  DocNextSteps,
  DocP,
  DocPage,
  DocSection,
  ParamRow,
} from '@/components/docs/DocParts';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { ModelPlaceholderNotice } from '@/components/model-placeholder-notice';
import { useTranslation } from '@/lib/i18n';
import { MODEL_ID_PLACEHOLDER, MODEL_REVISION_PLACEHOLDER } from '@/lib/model-reference';

const REQUEST_FIELDS = [
  { name: 'model', type: 'string', required: true },
  { name: 'messages', type: 'array', required: true },
  { name: 'stream', type: 'boolean' },
  { name: 'temperature', type: 'number' },
  { name: 'max_tokens', type: 'integer' },
  { name: 'top_p', type: 'number' },
  { name: 'stop', type: 'string | array' },
] as const;

const MESSAGE_FIELDS = [
  { name: 'role', type: 'string', required: true },
  { name: 'content', type: 'string', required: true },
  { name: 'name', type: 'string' },
] as const;

const RESPONSE_FIELDS = [
  { name: 'id', type: 'string' },
  { name: 'object', type: 'string' },
  { name: 'created', type: 'integer' },
  { name: 'model', type: 'string' },
  { name: 'choices', type: 'array' },
  { name: 'usage', type: 'object' },
] as const;

const EXAMPLE_REQUEST = `curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer $OXY_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${MODEL_ID_PLACEHOLDER}",
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "What is the capital of France?"
      }
    ],
    "temperature": 0.7,
    "max_tokens": 150
  }'`;

const EXAMPLE_RESPONSE = `{
  "id": "chatcmpl-abc123def456",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "${MODEL_ID_PLACEHOLDER}",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 8,
    "total_tokens": 33
  }
}`;

const STREAM_REQUEST = `curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer $OXY_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${MODEL_ID_PLACEHOLDER}",
    "messages": [{"role": "user", "content": "Tell me a story"}],
    "stream": true
  }'`;

const STREAM_RESPONSE = `data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":"Once"},"index":0}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":" upon"},"index":0}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":" a"},"index":0}]}

data: [DONE]`;

export default function ChatCompletionsScreen() {
  const { t } = useTranslation();
  const modelVars = { model: MODEL_ID_PLACEHOLDER, revision: MODEL_REVISION_PLACEHOLDER };

  return (
    <DocPage
      title={t('docs.chat.title')}
      subtitle={t('docs.chat.subtitle')}
      actions={<Badge size="label-medium" variant="solid" content="POST" />}
    >
      <DocSection title={t('docs.chat.endpoint.title')}>
        <DocCode code="POST https://api.oxy.so/v1/chat/completions" />
        <InferenceAvailabilityNotice />
        <ModelPlaceholderNotice />
        <DocP>{t('docs.chat.endpoint.note')}</DocP>
      </DocSection>

      <DocSection title={t('docs.chat.request.title')}>
        {REQUEST_FIELDS.map((field) => (
          <ParamRow key={field.name} {...field}>
            {t(`docs.chat.request.fields.${field.name}`, modelVars)}
          </ParamRow>
        ))}
      </DocSection>

      <DocSection title={t('docs.chat.message.title')}>
        <DocP>{t('docs.chat.message.intro')}</DocP>
        {MESSAGE_FIELDS.map((field) => (
          <ParamRow key={field.name} {...field}>
            {t(`docs.chat.message.fields.${field.name}`)}
          </ParamRow>
        ))}
      </DocSection>

      <DocSection title={t('docs.chat.exampleRequest')}>
        <DocCode code={EXAMPLE_REQUEST} language="bash" title="cURL" />
      </DocSection>

      <DocSection title={t('docs.chat.exampleResponse')}>
        <DocCode code={EXAMPLE_RESPONSE} language="json" title={t('docs.chat.responseCaption')} />
      </DocSection>

      <DocSection title={t('docs.chat.streaming.title')}>
        <DocP>{t('docs.chat.streaming.intro')}</DocP>
        <DocCode
          code={STREAM_REQUEST}
          language="bash"
          title={t('docs.chat.streaming.requestCaption')}
        />
        <DocP>{t('docs.chat.streaming.format')}</DocP>
        <DocCode code={STREAM_RESPONSE} />
      </DocSection>

      <DocSection title={t('docs.chat.responseFields.title')}>
        {RESPONSE_FIELDS.map((field) => (
          <ParamRow key={field.name} {...field}>
            {t(`docs.chat.responseFields.fields.${field.name}`)}
          </ParamRow>
        ))}
      </DocSection>

      <DocNextSteps
        steps={[
          { href: '/documentation/models', label: t('docs.chat.next.models') },
          { href: '/examples', label: t('docs.chat.next.examples') },
        ]}
      />
    </DocPage>
  );
}
