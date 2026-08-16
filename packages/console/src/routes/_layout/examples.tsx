import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { SourceCodeIcon } from '@hugeicons/core-free-icons';
import type { BundledLanguage } from 'shiki';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block';
import {
  Agent,
  AgentContent,
  AgentHeader,
  AgentInstructions,
  AgentTool,
  AgentTools,
} from '@/components/ui/agent';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { ModelPlaceholderNotice } from '@/components/model-placeholder-notice';
import { MODEL_ID_PLACEHOLDER } from '@/lib/model-reference';

export const Route = createFileRoute('/_layout/examples')({
  component: ExamplesPage,
});

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

const tabs: Array<{ value: ExampleKey; label: string }> = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python', label: 'Python' },
  { value: 'nodejs', label: 'Node.js' },
  { value: 'curl', label: 'cURL' },
];

const languageMap: Record<ExampleKey, BundledLanguage> = {
  javascript: 'javascript',
  python: 'python',
  nodejs: 'typescript',
  curl: 'bash',
  streaming: 'javascript',
  functionCalling: 'typescript',
};

// Sample agent configuration
const sampleAgent = {
  name: 'Weather Assistant',
  model: MODEL_ID_PLACEHOLDER,
  instructions: `You are a helpful weather assistant. When the user asks about the weather, use the get_weather tool to fetch current conditions. Always be friendly and provide helpful weather-related advice.`,
  tools: {
    get_weather: {
      description: 'Get current weather for a location',
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
      description: 'Get weather forecast for the next 7 days',
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

function ExamplesPage() {
  const [activeTab, setActiveTab] = useState<ExampleKey>('javascript');

  return (
    <ScrollArea className="flex-1 bg-background">
      <div className="max-w-4xl">
        {/* Header */}
        <div className="px-6 py-6 border-b border-border">
          <h1 className="text-2xl font-semibold text-foreground">Code Examples</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Example code for integrating with the Oxy API
          </p>
          <InferenceAvailabilityNotice className="mt-4" />
          <ModelPlaceholderNotice className="mt-3" />
        </div>

        {/* Basic Chat Completion */}
        <div className="px-6 py-6 border-b border-border">
          <p className="text-sm font-semibold text-foreground mb-1">Basic Chat Completion</p>
          <p className="text-sm text-muted-foreground mb-4">
            Make a simple chat completion request
          </p>

          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ExampleKey)}>
            <TabsList className="mb-4">
              {tabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((tab) => (
              <TabsContent key={tab.value} value={tab.value}>
                <CodeBlock code={examples[tab.value]} language={languageMap[tab.value]}>
                  <CodeBlockHeader>
                    <CodeBlockTitle>
                      <HugeiconsIcon icon={SourceCodeIcon} size={14} className="text-muted-foreground" />
                      <CodeBlockFilename>{tab.label}</CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              </TabsContent>
            ))}
          </Tabs>
        </div>

        {/* Streaming Response */}
        <div className="px-6 py-6 border-b border-border">
          <p className="text-sm font-semibold text-foreground mb-1">Streaming Response</p>
          <p className="text-sm text-muted-foreground mb-4">
            Stream responses for real-time output
          </p>
          <CodeBlock code={examples.streaming} language="javascript">
            <CodeBlockHeader>
              <CodeBlockTitle>
                <HugeiconsIcon icon={SourceCodeIcon} size={14} className="text-muted-foreground" />
                <CodeBlockFilename>Streaming Example</CodeBlockFilename>
              </CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
        </div>

        {/* Function Calling */}
        <div className="px-6 py-6 border-b border-border">
          <p className="text-sm font-semibold text-foreground mb-1">Function Calling</p>
          <p className="text-sm text-muted-foreground mb-4">
            Define custom tools and let the model call them
          </p>
          <CodeBlock code={examples.functionCalling} language="typescript">
            <CodeBlockHeader>
              <CodeBlockTitle>
                <HugeiconsIcon icon={SourceCodeIcon} size={14} className="text-muted-foreground" />
                <CodeBlockFilename>Function Calling</CodeBlockFilename>
              </CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
        </div>

        {/* Agent Configuration Example */}
        <div className="px-6 py-6">
          <p className="text-sm font-semibold text-foreground mb-1">Agent Configuration</p>
          <p className="text-sm text-muted-foreground mb-4">
            Build intelligent agents with custom tools and instructions
          </p>
          <Agent className="max-w-lg">
            <AgentHeader name={sampleAgent.name} model={sampleAgent.model} />
            <AgentContent>
              <AgentInstructions>{sampleAgent.instructions}</AgentInstructions>
              <AgentTools>
                {Object.entries(sampleAgent.tools).map(([name, tool]) => (
                  <AgentTool key={name} value={name} tool={tool} />
                ))}
              </AgentTools>
            </AgentContent>
          </Agent>
        </div>
      </div>
    </ScrollArea>
  );
}
