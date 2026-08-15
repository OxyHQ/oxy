import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon, SourceCodeIcon } from '@hugeicons/core-free-icons';
import {
  EnvironmentVariable,
  EnvironmentVariables,
  EnvironmentVariablesContent,
  EnvironmentVariablesHeader,
  EnvironmentVariablesTitle,
  EnvironmentVariablesToggle,
} from '@/components/ui/environment-variables';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block';

export const Route = createFileRoute('/_layout/documentation/quickstart')({
  component: QuickStartPage,
});

function QuickStartPage() {
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
        <h1 className="text-2xl font-semibold text-foreground">Quick Start</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Get up and running with the Oxy API in minutes
        </p>
      </div>

      {/* Step 1 */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            1
          </span>
          <h2 className="text-lg font-semibold text-foreground">Create an application credential</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Go to the <Link to="/apps" className="text-primary hover:underline">Applications</Link> section,
          create an application, and add a credential. You get back a pair: a
          public <code className="text-xs bg-muted px-1 py-0.5 rounded">clientId</code> beginning
          with <code className="text-xs bg-muted px-1 py-0.5 rounded">oxy_dk_</code>, and a secret
          shown exactly once. The <code className="text-xs bg-muted px-1 py-0.5 rounded">clientId</code> is
          a public identifier and never authenticates on its own — see
          the <Link to="/documentation/authentication" className="text-primary hover:underline">authentication guide</Link>.
        </p>
        <EnvironmentVariables className="max-w-md">
          <EnvironmentVariablesHeader>
            <EnvironmentVariablesTitle>Your credential</EnvironmentVariablesTitle>
            <EnvironmentVariablesToggle />
          </EnvironmentVariablesHeader>
          <EnvironmentVariablesContent>
            <EnvironmentVariable name="OXY_CLIENT_ID" value="oxy_dk_your_client_id" />
            <EnvironmentVariable name="OXY_CLIENT_SECRET" value="shown once when you create it" />
          </EnvironmentVariablesContent>
        </EnvironmentVariables>
      </div>

      {/* Step 2 */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            2
          </span>
          <h2 className="text-lg font-semibold text-foreground">Install the SDK (Optional)</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          The Oxy API is compatible with OpenAI's SDK. You can use any OpenAI-compatible library:
        </p>
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Node.js / JavaScript</p>
            <CodeBlock code="npm install openai" language="bash">
              <CodeBlockHeader>
                <CodeBlockTitle>
                  <HugeiconsIcon icon={SourceCodeIcon} size={14} className="text-muted-foreground" />
                  <CodeBlockFilename>Terminal</CodeBlockFilename>
                </CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockCopyButton />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Python</p>
            <CodeBlock code="pip install openai" language="bash">
              <CodeBlockHeader>
                <CodeBlockTitle>
                  <HugeiconsIcon icon={SourceCodeIcon} size={14} className="text-muted-foreground" />
                  <CodeBlockFilename>Terminal</CodeBlockFilename>
                </CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockCopyButton />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          </div>
        </div>
      </div>

      {/* Step 3 */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            3
          </span>
          <h2 className="text-lg font-semibold text-foreground">Make Your First Request</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Every request carries a <strong className="text-foreground">token</strong> in
          the <code className="text-xs bg-muted px-1 py-0.5 rounded">Authorization</code> header —
          never the <code className="text-xs bg-muted px-1 py-0.5 rounded">clientId</code>. Mint a
          service token from your credential first:
        </p>
        <CodeBlock
          language="bash"
          code={`OXY_ACCESS_TOKEN=$(curl -s https://api.oxy.so/auth/service-token \\
  -H "Content-Type: application/json" \\
  -d "{\\"apiKey\\": \\"$OXY_CLIENT_ID\\", \\"apiSecret\\": \\"$OXY_CLIENT_SECRET\\"}" \\
  | jq -r .data.token)`}
        >
          <CodeBlockHeader>
            <CodeBlockTitle>
              <HugeiconsIcon icon={SourceCodeIcon} size={14} className="text-muted-foreground" />
              <CodeBlockFilename>Mint a token</CodeBlockFilename>
            </CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton />
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
        <p className="text-sm text-muted-foreground mt-4 mb-4">
          Then call the API with it:
        </p>
        <CodeBlock
          language="bash"
          code={`curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer $OXY_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "alia-v1",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`}
        >
          <CodeBlockHeader>
            <CodeBlockTitle>
              <HugeiconsIcon icon={SourceCodeIcon} size={14} className="text-muted-foreground" />
              <CodeBlockFilename>cURL Request</CodeBlockFilename>
            </CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton />
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
      </div>

      {/* Step 4 */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
            4
          </span>
          <h2 className="text-lg font-semibold text-foreground">Handle the Response</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          You'll receive a response like this:
        </p>
        <CodeBlock
          language="json"
          code={`{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "alia-v1",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}`}
        >
          <CodeBlockHeader>
            <CodeBlockTitle>
              <HugeiconsIcon icon={SourceCodeIcon} size={14} className="text-muted-foreground" />
              <CodeBlockFilename>Response</CodeBlockFilename>
            </CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton />
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
      </div>

      {/* Next Steps */}
      <div className="px-6 py-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Next Steps</h2>
        <div className="space-y-1">
          <Link
            to="/documentation/authentication"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Learn about authentication</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
          <Link
            to="/documentation/chat-completions"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Explore Chat Completions API</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
          <Link
            to="/examples"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">View code examples</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
}
