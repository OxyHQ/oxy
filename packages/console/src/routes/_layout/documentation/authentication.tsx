import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, ArrowLeft01Icon, ArrowRight01Icon, Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { toast } from '@oxyhq/bloom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export const Route = createFileRoute('/_layout/documentation/authentication')({
  component: AuthenticationPage,
});

function CodeBlock({ code, language: _language = 'bash' }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group">
      <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm font-mono">
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

function AuthenticationPage() {
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
        <h1 className="text-2xl font-semibold text-foreground">Authentication</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Learn how to authenticate your API requests
        </p>
      </div>

      {/* API Keys */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">API Keys</h2>
        <p className="text-sm text-muted-foreground mb-4">
          All API requests require authentication using an API key. You can create and manage your
          API keys in the <Link to="/apps" className="text-primary hover:underline">API Keys</Link> section.
        </p>
        <p className="text-sm text-muted-foreground mb-4">
          API keys follow this format:
        </p>
        <CodeBlock code="oxy_dk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
      </div>

      {/* Bearer Token */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Using Bearer Tokens</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Include your API key in the <code className="text-xs bg-muted px-1 py-0.5 rounded">Authorization</code> header
          as a Bearer token:
        </p>
        <CodeBlock code="Authorization: Bearer oxy_dk_your_api_key_here" />
        <p className="text-sm text-muted-foreground mt-4">
          Example request:
        </p>
        <div className="mt-2">
          <CodeBlock
            code={`curl https://api.oxy.so/v1/chat/completions \\
  -H "Authorization: Bearer oxy_dk_your_api_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "alia-v1", "messages": [{"role": "user", "content": "Hello"}]}'`}
          />
        </div>
      </div>

      {/* Scopes */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">API Key Scopes</h2>
        <p className="text-sm text-muted-foreground mb-4">
          API keys can be configured with specific scopes to limit their capabilities:
        </p>
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">chat:read</Badge>
            <p className="text-sm text-muted-foreground">Read conversation history</p>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">chat:write</Badge>
            <p className="text-sm text-muted-foreground">Create chat completions</p>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">models:read</Badge>
            <p className="text-sm text-muted-foreground">List available models</p>
          </div>
        </div>
      </div>

      {/* Rate Limits */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Rate Limits</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Each API key has configurable rate limits. When you exceed the rate limit, the API will
          return a <code className="text-xs bg-muted px-1 py-0.5 rounded">429 Too Many Requests</code> response.
        </p>
        <p className="text-sm text-muted-foreground mb-4">
          Rate limit headers are included in every response:
        </p>
        <CodeBlock
          code={`X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1234567890`}
        />
      </div>

      {/* Security Best Practices */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Security Best Practices</h2>
        <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20 mb-4">
          <div className="flex items-start gap-2">
            <HugeiconsIcon icon={Alert02Icon} className="size-5 text-yellow-500 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-yellow-500">Keep your API keys secure</p>
              <p className="text-xs text-yellow-500/80 mt-1">
                Never expose your API keys in client-side code, public repositories, or share them publicly.
              </p>
            </div>
          </div>
        </div>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Store API keys in environment variables, not in code
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Use separate API keys for development and production
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Regularly rotate your API keys
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Use the minimum required scopes for each API key
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Set expiration dates on keys when possible
          </li>
        </ul>
      </div>

      {/* Error Handling */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Authentication Errors</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Common authentication errors:
        </p>
        <div className="space-y-3">
          <div className="p-3 rounded-lg border">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="destructive" className="text-xs">401</Badge>
              <span className="text-sm font-medium">Unauthorized</span>
            </div>
            <p className="text-xs text-muted-foreground">Missing or invalid API key</p>
          </div>
          <div className="p-3 rounded-lg border">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="destructive" className="text-xs">403</Badge>
              <span className="text-sm font-medium">Forbidden</span>
            </div>
            <p className="text-xs text-muted-foreground">API key doesn't have the required scope</p>
          </div>
          <div className="p-3 rounded-lg border">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="destructive" className="text-xs">429</Badge>
              <span className="text-sm font-medium">Too Many Requests</span>
            </div>
            <p className="text-xs text-muted-foreground">Rate limit exceeded</p>
          </div>
        </div>
      </div>

      {/* Next Steps */}
      <div className="px-6 py-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Next Steps</h2>
        <div className="space-y-1">
          <Link
            to="/documentation/chat-completions"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Chat Completions API</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
          <Link
            to="/apps"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Manage your API keys</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
}
