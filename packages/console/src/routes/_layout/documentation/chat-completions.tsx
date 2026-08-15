import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon, Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { toast } from '@oxyhq/bloom/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';

export const Route = createFileRoute('/_layout/documentation/chat-completions')({
  component: ChatCompletionsPage,
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

function ParamRow({
  name,
  type,
  required,
  children,
}: {
  name: string;
  type: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="py-4 border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 mb-1">
        <code className="text-sm font-mono font-medium text-foreground">{name}</code>
        <Badge variant="outline" className="text-xs font-mono">
          {type}
        </Badge>
        {required && (
          <Badge variant="secondary" className="text-xs">
            Required
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function ChatCompletionsPage() {
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
        <div className="flex items-center gap-3">
          <Badge className="text-xs">POST</Badge>
          <h1 className="text-2xl font-semibold text-foreground">Chat Completions</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Create a chat completion with the Oxy API
        </p>
      </div>

      {/* Endpoint */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Endpoint</h2>
        <CodeBlock code="POST https://api.oxy.so/v1/chat/completions" />
        <InferenceAvailabilityNotice className="mt-4" />
        <p className="text-sm text-muted-foreground mt-4">
          The request and response shapes below are the contract this endpoint keeps; the examples
          are written the way a call will look, not the way one succeeds today.
        </p>
      </div>

      {/* Request Body */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Request Body</h2>
        <div>
          <ParamRow name="model" type="string" required>
            ID of the model to use (e.g., "alia-v1", "alia-v1-pro")
          </ParamRow>
          <ParamRow name="messages" type="array" required>
            A list of messages comprising the conversation so far
          </ParamRow>
          <ParamRow name="stream" type="boolean">
            If set to true, partial message deltas will be sent as server-sent events. Default: false
          </ParamRow>
          <ParamRow name="temperature" type="number">
            Sampling temperature between 0 and 2. Higher values make output more random. Default: 1
          </ParamRow>
          <ParamRow name="max_tokens" type="integer">
            Maximum number of tokens to generate in the response
          </ParamRow>
          <ParamRow name="top_p" type="number">
            Nucleus sampling parameter. Consider tokens with top_p probability mass. Default: 1
          </ParamRow>
          <ParamRow name="stop" type="string | array">
            Sequences where the API will stop generating tokens
          </ParamRow>
        </div>
      </div>

      {/* Message Object */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Message Object</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Each message in the messages array should have the following structure:
        </p>
        <div>
          <ParamRow name="role" type="string" required>
            The role of the message author: "system", "user", or "assistant"
          </ParamRow>
          <ParamRow name="content" type="string" required>
            The content of the message
          </ParamRow>
          <ParamRow name="name" type="string">
            An optional name for the participant (useful for multi-user conversations)
          </ParamRow>
        </div>
      </div>

      {/* Example Request */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Example Request</h2>
        <CodeBlock
          title="cURL"
          code={`curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer $OXY_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "alia-v1",
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
  }'`}
        />
      </div>

      {/* Example Response */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Example Response</h2>
        <CodeBlock
          title="Response"
          code={`{
  "id": "chatcmpl-abc123def456",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "alia-v1",
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
}`}
        />
      </div>

      {/* Streaming */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Streaming</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Set <code className="text-xs bg-muted px-1 py-0.5 rounded">stream: true</code> to receive
          responses as server-sent events (SSE):
        </p>
        <CodeBlock
          title="Streaming Request"
          code={`curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer $OXY_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "alia-v1",
    "messages": [{"role": "user", "content": "Tell me a story"}],
    "stream": true
  }'`}
        />
        <p className="text-sm text-muted-foreground mt-4 mb-2">
          Streaming response format:
        </p>
        <CodeBlock
          code={`data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":"Once"},"index":0}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":" upon"},"index":0}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":" a"},"index":0}]}

data: [DONE]`}
        />
      </div>

      {/* Response Fields */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Response Fields</h2>
        <div>
          <ParamRow name="id" type="string">
            A unique identifier for the chat completion
          </ParamRow>
          <ParamRow name="object" type="string">
            The object type, always "chat.completion"
          </ParamRow>
          <ParamRow name="created" type="integer">
            Unix timestamp of when the completion was created
          </ParamRow>
          <ParamRow name="model" type="string">
            The model used for the completion
          </ParamRow>
          <ParamRow name="choices" type="array">
            A list of chat completion choices
          </ParamRow>
          <ParamRow name="usage" type="object">
            Token usage statistics for the request
          </ParamRow>
        </div>
      </div>

      {/* Next Steps */}
      <div className="px-6 py-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Next Steps</h2>
        <div className="space-y-1">
          <Link
            to="/documentation/models"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Available Models</span>
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
