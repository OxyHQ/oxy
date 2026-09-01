import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { toast } from '@oxyhq/bloom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const Route = createFileRoute('/_layout/documentation/sdks')({
  component: SDKsPage,
});

function CodeBlock({ code, title }: { code: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group">
      {title && (
        <div className="flex items-center justify-between bg-muted/70 px-4 py-2 rounded-t-lg border-b border-border">
          <span className="text-xs font-medium text-muted-foreground">{title}</span>
        </div>
      )}
      <pre className={`bg-muted p-4 overflow-x-auto text-sm font-mono ${title ? 'rounded-b-lg' : 'rounded-lg'}`}>
        {code}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleCopy}
      >
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          className={`size-4 ${copied ? 'text-green-500' : ''}`}
        />
      </Button>
    </div>
  );
}

function SDKsPage() {
  return (
    <div className="flex-1 bg-background max-w-4xl">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <Link
          to="/documentation"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
          Documentation
        </Link>
        <h1 className="text-2xl font-semibold text-foreground">SDKs & Libraries</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Use the Oxy API with your favorite programming language
        </p>
      </div>

      {/* OpenAI Compatibility */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">OpenAI SDK Compatibility</h2>
        <p className="text-sm text-muted-foreground mb-4">
          The Oxy API is fully compatible with OpenAI's SDK. You can use any OpenAI-compatible
          library by simply changing the base URL to <code className="text-xs bg-muted px-1 py-0.5 rounded">https://api.oxy.so/v1</code>.
        </p>
        <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
          <p className="text-sm text-primary">
            This means you can migrate existing OpenAI integrations to Oxy with minimal code changes!
          </p>
        </div>
      </div>

      {/* Installation */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Installation</h2>
        <Tabs defaultValue="node" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="node">Node.js</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
            <TabsTrigger value="curl">cURL</TabsTrigger>
          </TabsList>

          <TabsContent value="node">
            <CodeBlock title="Install" code="npm install openai" />
          </TabsContent>

          <TabsContent value="python">
            <CodeBlock title="Install" code="pip install openai" />
          </TabsContent>

          <TabsContent value="curl">
            <p className="text-sm text-muted-foreground mb-4">
              No installation required. cURL is available on most systems.
            </p>
          </TabsContent>
        </Tabs>
      </div>

      {/* Usage Examples */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Usage Examples</h2>
        <Tabs defaultValue="node" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="node">Node.js</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
            <TabsTrigger value="curl">cURL</TabsTrigger>
          </TabsList>

          <TabsContent value="node">
            <CodeBlock
              title="index.js"
              code={`import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OXY_API_KEY,
  baseURL: 'https://api.oxy.so/v1',
});

async function main() {
  const completion = await client.chat.completions.create({
    model: 'alia-v1',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
    ],
  });

  console.log(completion.choices[0].message.content);
}

main();`}
            />
          </TabsContent>

          <TabsContent value="python">
            <CodeBlock
              title="main.py"
              code={`from openai import OpenAI
import os

client = OpenAI(
    api_key=os.environ.get("OXY_API_KEY"),
    base_url="https://api.oxy.so/v1",
)

completion = client.chat.completions.create(
    model="alia-v1",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
    ],
)

print(completion.choices[0].message.content)`}
            />
          </TabsContent>

          <TabsContent value="curl">
            <CodeBlock
              title="Request"
              code={`curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer $OXY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "alia-v1",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ]
  }'`}
            />
          </TabsContent>
        </Tabs>
      </div>

      {/* Streaming */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Streaming Example</h2>
        <Tabs defaultValue="node" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="node">Node.js</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
          </TabsList>

          <TabsContent value="node">
            <CodeBlock
              title="streaming.js"
              code={`import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OXY_API_KEY,
  baseURL: 'https://api.oxy.so/v1',
});

async function main() {
  const stream = await client.chat.completions.create({
    model: 'alia-v1',
    messages: [{ role: 'user', content: 'Tell me a story' }],
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    process.stdout.write(content);
  }
}

main();`}
            />
          </TabsContent>

          <TabsContent value="python">
            <CodeBlock
              title="streaming.py"
              code={`from openai import OpenAI
import os

client = OpenAI(
    api_key=os.environ.get("OXY_API_KEY"),
    base_url="https://api.oxy.so/v1",
)

stream = client.chat.completions.create(
    model="alia-v1",
    messages=[{"role": "user", "content": "Tell me a story"}],
    stream=True,
)

for chunk in stream:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)`}
            />
          </TabsContent>
        </Tabs>
      </div>

      {/* Framework Integration */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Framework Integration</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Vercel AI SDK</CardTitle>
              <CardDescription>
                Use Oxy with the Vercel AI SDK for React/Next.js apps
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock
                code={`import { createOpenAI } from '@ai-sdk/openai';

const oxy = createOpenAI({
  apiKey: process.env.OXY_API_KEY,
  baseURL: 'https://api.oxy.so/v1',
});

// Use with streamText, generateText, etc.
const result = await streamText({
  model: oxy('alia-v1'),
  prompt: 'Hello!',
});`}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">LangChain</CardTitle>
              <CardDescription>
                Integrate Oxy with LangChain for complex workflows
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock
                code={`from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="alia-v1",
    api_key="your-api-key",
    base_url="https://api.oxy.so/v1",
)

response = llm.invoke("Hello!")
print(response.content)`}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Environment Variables */}
      <div className="px-6 py-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Environment Variables</h2>
        <p className="text-sm text-muted-foreground mb-4">
          We recommend storing your API key in an environment variable:
        </p>
        <CodeBlock
          title=".env"
          code={`OXY_API_KEY=oxy_dk_your_api_key_here
OXY_BASE_URL=https://api.oxy.so/v1`}
        />
      </div>
    </div>
  );
}
