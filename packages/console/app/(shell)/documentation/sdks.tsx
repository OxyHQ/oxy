import { Card } from '@oxy.so/bloom/card';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { Notice } from '@/components/content/Notice';
import { DocCode, DocP, DocPage, DocSection } from '@/components/docs/DocParts';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { ModelPlaceholderNotice } from '@/components/model-placeholder-notice';
import { useTranslation } from '@/lib/i18n';
import { MODEL_ID_PLACEHOLDER } from '@/lib/model-reference';

interface Sample {
  title: string;
  language?: string;
  code: string;
}

const NODE_USAGE = `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OXY_ACCESS_TOKEN,
  baseURL: 'https://api.oxy.so/v1',
});

async function main() {
  const completion = await client.chat.completions.create({
    model: '${MODEL_ID_PLACEHOLDER}',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
    ],
  });

  console.log(completion.choices[0].message.content);
}

main();`;

const PYTHON_USAGE = `from openai import OpenAI
import os

client = OpenAI(
    api_key=os.environ.get("OXY_ACCESS_TOKEN"),
    base_url="https://api.oxy.so/v1",
)

completion = client.chat.completions.create(
    model="${MODEL_ID_PLACEHOLDER}",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
    ],
)

print(completion.choices[0].message.content)`;

const CURL_USAGE = `curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer $OXY_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${MODEL_ID_PLACEHOLDER}",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ]
  }'`;

const NODE_STREAM = `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OXY_ACCESS_TOKEN,
  baseURL: 'https://api.oxy.so/v1',
});

async function main() {
  const stream = await client.chat.completions.create({
    model: '${MODEL_ID_PLACEHOLDER}',
    messages: [{ role: 'user', content: 'Tell me a story' }],
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    process.stdout.write(content);
  }
}

main();`;

const PYTHON_STREAM = `from openai import OpenAI
import os

client = OpenAI(
    api_key=os.environ.get("OXY_ACCESS_TOKEN"),
    base_url="https://api.oxy.so/v1",
)

stream = client.chat.completions.create(
    model="${MODEL_ID_PLACEHOLDER}",
    messages=[{"role": "user", "content": "Tell me a story"}],
    stream=True,
)

for chunk in stream:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)`;

const VERCEL_AI = `import { createOpenAI } from '@ai-sdk/openai';

const oxy = createOpenAI({
  apiKey: process.env.OXY_ACCESS_TOKEN,
  baseURL: 'https://api.oxy.so/v1',
});

// Use with streamText, generateText, etc.
const result = await streamText({
  model: oxy('${MODEL_ID_PLACEHOLDER}'),
  prompt: 'Hello!',
});`;

const LANGCHAIN = `from langchain_openai import ChatOpenAI
import os

llm = ChatOpenAI(
    model="${MODEL_ID_PLACEHOLDER}",
    api_key=os.environ.get("OXY_ACCESS_TOKEN"),
    base_url="https://api.oxy.so/v1",
)

response = llm.invoke("Hello!")
print(response.content)`;

const ENV_FILE = `OXY_CLIENT_ID=oxy_dk_your_client_id
OXY_CLIENT_SECRET=shown_once_when_you_create_the_credential
OXY_BASE_URL=https://api.oxy.so/v1`;

type Runtime = 'node' | 'python' | 'curl';

/** A runtime switcher over one code sample per runtime. */
function RuntimeTabs({ samples }: { samples: Partial<Record<Runtime, Sample>> }) {
  const { t } = useTranslation();
  const runtimes = (['node', 'python', 'curl'] as const).filter((runtime) => samples[runtime]);
  const [active, setActive] = useState<Runtime>(runtimes[0] ?? 'node');
  const sample = samples[active];

  return (
    <View className="gap-4">
      <Tabs value={active} onValueChange={(value) => setActive(value as Runtime)}>
        {runtimes.map((runtime) => (
          <TabsTrigger key={runtime} value={runtime} label={t(`docs.sdks.runtimes.${runtime}`)} />
        ))}
      </Tabs>
      {sample && <DocCode code={sample.code} language={sample.language} title={sample.title} />}
    </View>
  );
}

export default function SdksScreen() {
  const { t } = useTranslation();

  return (
    <DocPage title={t('docs.sdks.title')} subtitle={t('docs.sdks.subtitle')}>
      <DocSection title={t('docs.sdks.compat.title')}>
        <DocP>{t('docs.sdks.compat.baseUrl')}</DocP>
        <DocP>{t('docs.sdks.compat.apiKey')}</DocP>
        <Notice tone="info" title={t('docs.sdks.compat.migrate')} />
        <InferenceAvailabilityNotice />
        <ModelPlaceholderNotice />
      </DocSection>

      <DocSection title={t('docs.sdks.install.title')}>
        <RuntimeTabs
          samples={{
            node: { title: t('docs.sdks.install.caption'), code: 'npm install openai' },
            python: { title: t('docs.sdks.install.caption'), code: 'pip install openai' },
          }}
        />
        <DocP>{t('docs.sdks.install.curlNote')}</DocP>
      </DocSection>

      <DocSection title={t('docs.sdks.usage.title')}>
        <RuntimeTabs
          samples={{
            node: { title: 'index.js', language: 'javascript', code: NODE_USAGE },
            python: { title: 'main.py', language: 'python', code: PYTHON_USAGE },
            curl: {
              title: t('docs.sdks.usage.requestCaption'),
              language: 'bash',
              code: CURL_USAGE,
            },
          }}
        />
      </DocSection>

      <DocSection title={t('docs.sdks.streaming.title')}>
        <RuntimeTabs
          samples={{
            node: { title: 'streaming.js', language: 'javascript', code: NODE_STREAM },
            python: { title: 'streaming.py', language: 'python', code: PYTHON_STREAM },
          }}
        />
      </DocSection>

      <DocSection title={t('docs.sdks.frameworks.title')}>
        <View className="gap-4">
          <Card className="gap-3 p-4">
            <Text className="text-base font-semibold text-foreground">Vercel AI SDK</Text>
            <Text className="text-sm text-muted-foreground">
              {t('docs.sdks.frameworks.vercel')}
            </Text>
            <DocCode code={VERCEL_AI} language="javascript" />
          </Card>
          <Card className="gap-3 p-4">
            <Text className="text-base font-semibold text-foreground">LangChain</Text>
            <Text className="text-sm text-muted-foreground">
              {t('docs.sdks.frameworks.langchain')}
            </Text>
            <DocCode code={LANGCHAIN} language="python" />
          </Card>
        </View>
      </DocSection>

      <DocSection title={t('docs.sdks.env.title')} divider={false}>
        <DocP>{t('docs.sdks.env.body')}</DocP>
        <DocCode code={ENV_FILE} title=".env" />
      </DocSection>
    </DocPage>
  );
}
