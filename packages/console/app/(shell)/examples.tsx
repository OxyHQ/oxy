import { Card } from '@oxy.so/bloom/card';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { ContentScreen } from '@/components/content/ContentScreen';
import { Section } from '@/components/content/Section';
import { DocCode } from '@/components/docs/DocParts';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { ModelPlaceholderNotice } from '@/components/model-placeholder-notice';
import { useTranslation } from '@/lib/i18n';
import { MODEL_ID_PLACEHOLDER } from '@/lib/model-reference';

const examples = {
  javascript: `const response = await fetch('https://api.oxy.so/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + process.env.OXY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '${MODEL_ID_PLACEHOLDER}',
    messages: [
      { role: 'user', content: 'Hello!' }
    ],
  }),
});

const data = await response.json();
console.log(data.choices[0].message.content);`,

  python: `import openai
import os

client = openai.OpenAI(
    api_key=os.environ.get("OXY_ACCESS_TOKEN"),
    base_url="https://api.oxy.so/v1"
)

response = client.chat.completions.create(
    model="${MODEL_ID_PLACEHOLDER}",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)

print(response.choices[0].message.content)`,

  nodejs: `import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OXY_ACCESS_TOKEN,
  baseURL: 'https://api.oxy.so/v1',
});

const completion = await openai.chat.completions.create({
  model: '${MODEL_ID_PLACEHOLDER}',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
});

console.log(completion.choices[0].message.content);`,

  curl: `curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer $OXY_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${MODEL_ID_PLACEHOLDER}",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`,

  streaming: `const response = await fetch('https://api.oxy.so/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + process.env.OXY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: '${MODEL_ID_PLACEHOLDER}',
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: true,
  }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split('\\n').filter(line => line.startsWith('data: '));

  for (const line of lines) {
    const data = JSON.parse(line.slice(6));
    if (data.choices[0].delta.content) {
      process.stdout.write(data.choices[0].delta.content);
    }
  }
}`,

  functionCalling: `import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OXY_ACCESS_TOKEN,
  baseURL: 'https://api.oxy.so/v1',
});

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather in a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City and country' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
        },
        required: ['location']
      }
    }
  }
];

const completion = await openai.chat.completions.create({
  model: '${MODEL_ID_PLACEHOLDER}',
  messages: [{ role: 'user', content: 'What is the weather in Madrid?' }],
  tools,
  tool_choice: 'auto',
});

console.log(completion.choices[0].message.tool_calls);`,
};

type ExampleKey = keyof typeof examples;

const TABS: Array<{ value: ExampleKey; label: string; language: string }> = [
  { value: 'javascript', label: 'JavaScript', language: 'javascript' },
  { value: 'python', label: 'Python', language: 'python' },
  { value: 'nodejs', label: 'Node.js', language: 'typescript' },
  { value: 'curl', label: 'cURL', language: 'bash' },
];

// Sample agent configuration: its prose lives in the dictionary, only the shape stays here.
const sampleAgent = {
  model: MODEL_ID_PLACEHOLDER,
  tools: {
    get_weather: {
      parameters: {
        jsonSchema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
            unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
          },
          required: ['location'],
        },
      },
    },
    get_forecast: {
      parameters: {
        jsonSchema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
            days: { type: 'number', description: 'Number of days' },
          },
          required: ['location'],
        },
      },
    },
  },
};

/** A sample agent: its model, its instructions and the tools it may call. */
function AgentCard() {
  const { t } = useTranslation();
  return (
    <Card className="max-w-lg gap-4 p-4">
      <View className="gap-0.5">
        <Text className="text-base font-semibold text-foreground">
          {t('examplesPage.agent.name')}
        </Text>
        <Text selectable className="font-mono text-xs text-muted-foreground">
          {sampleAgent.model}
        </Text>
      </View>
      <View className="gap-1">
        <Text className="text-xs text-muted-foreground">
          {t('examplesPage.agent.instructions')}
        </Text>
        <Text className="text-sm text-foreground">{t('examplesPage.agent.instructionsText')}</Text>
      </View>
      <View className="gap-2">
        <Text className="text-xs text-muted-foreground">{t('examplesPage.agent.tools')}</Text>
        {Object.entries(sampleAgent.tools).map(([name, tool]) => (
          <View key={name} className="gap-2 rounded-lg border border-border p-3">
            <Text className="font-mono text-sm text-foreground">{name}</Text>
            <Text className="text-xs text-muted-foreground">
              {t(`examplesPage.agent.toolDescriptions.${name}`)}
            </Text>
            <DocCode code={JSON.stringify(tool.parameters.jsonSchema, null, 2)} language="json" />
          </View>
        ))}
      </View>
    </Card>
  );
}

export default function ExamplesScreen() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ExampleKey>('javascript');
  const active = TABS.find((tab) => tab.value === activeTab) ?? TABS[0];

  return (
    <ContentScreen title={t('examplesPage.title')} subtitle={t('examplesPage.subtitle')}>
      <View className="gap-3">
        <InferenceAvailabilityNotice />
        <ModelPlaceholderNotice />
      </View>

      <Section
        title={t('examplesPage.basic.title')}
        description={t('examplesPage.basic.description')}
        className="gap-4 border-b border-border pb-6"
      >
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ExampleKey)}>
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} label={tab.label} />
          ))}
        </Tabs>
        <DocCode code={examples[active.value]} language={active.language} title={active.label} />
      </Section>

      <Section
        title={t('examplesPage.streaming.title')}
        description={t('examplesPage.streaming.description')}
        className="gap-4 border-b border-border pb-6"
      >
        <DocCode
          code={examples.streaming}
          language="javascript"
          title={t('examplesPage.streaming.caption')}
        />
      </Section>

      <Section
        title={t('examplesPage.functionCalling.title')}
        description={t('examplesPage.functionCalling.description')}
        className="gap-4 border-b border-border pb-6"
      >
        <DocCode
          code={examples.functionCalling}
          language="typescript"
          title={t('examplesPage.functionCalling.caption')}
        />
      </Section>

      <Section
        title={t('examplesPage.agent.title')}
        description={t('examplesPage.agent.description')}
        className="gap-4"
      >
        <AgentCard />
      </Section>
    </ContentScreen>
  );
}
