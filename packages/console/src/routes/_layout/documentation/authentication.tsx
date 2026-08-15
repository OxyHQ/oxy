import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, ArrowLeft01Icon, ArrowRight01Icon, Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { useState } from 'react';
import { toast } from '@oxyhq/bloom/toast';
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

      {/* Credentials */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Application credentials</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Every integration authenticates as an <strong className="text-foreground">application</strong>, and
          each application holds one or more credentials. Create and manage them in
          the <Link to="/apps" className="text-primary hover:underline">Applications</Link> section.
        </p>
        <p className="text-sm text-muted-foreground mb-4">
          A credential is a <em>pair</em>, and the two halves are not interchangeable:
        </p>
        <CodeBlock
          code={`clientId      oxy_dk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx      public
clientSecret  shown once, at create and rotate time         secret`}
        />
        <div className="mt-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
          <div className="flex items-start gap-2">
            <HugeiconsIcon icon={Alert02Icon} className="size-5 text-yellow-500 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-yellow-500">
                The <code className="text-xs">oxy_dk_</code> value is a public identifier, not a key
              </p>
              <p className="text-xs text-yellow-500/80 mt-1">
                It is your OAuth <code>client_id</code>. It is designed to be shipped inside mobile
                apps and browser bundles, and Oxy serves it to anyone who asks. Sending it as a
                bearer token authenticates nothing and is always rejected — the credential that
                proves anything is the secret, or a token minted from it.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* How to authenticate */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">How to authenticate</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Whichever route you take, the value you finally put in
          the <code className="text-xs bg-muted px-1 py-0.5 rounded">Authorization</code> header is a
          short-lived <strong className="text-foreground">token</strong>:
        </p>
        <CodeBlock code="Authorization: Bearer <token>" />

        <h3 className="text-base font-semibold text-foreground mt-6 mb-2">
          Server to server — exchange your credential for a service token
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Post the credential pair to <code className="text-xs bg-muted px-1 py-0.5 rounded">/auth/service-token</code>.
          You get back a JWT valid for one hour; re-mint it when it expires. This requires
          a <code className="text-xs bg-muted px-1 py-0.5 rounded">service</code> credential on an
          application Oxy has approved for it.
        </p>
        <CodeBlock
          code={`curl https://api.oxy.so/auth/service-token \\
  -H "Content-Type: application/json" \\
  -d '{"apiKey": "$OXY_CLIENT_ID", "apiSecret": "$OXY_CLIENT_SECRET"}'

# => { "data": { "token": "<service token>", "expiresIn": 3600 } }

curl https://api.oxy.so/some/endpoint \\
  -H "Authorization: Bearer $OXY_SERVICE_TOKEN"`}
        />
        <p className="text-sm text-muted-foreground mt-4">
          To act on behalf of one of your users, add
          an <code className="text-xs bg-muted px-1 py-0.5 rounded">X-Oxy-User-Id</code> header to
          the delegated request.
        </p>

        <h3 className="text-base font-semibold text-foreground mt-6 mb-2">
          On behalf of a user — OAuth 2.0 with PKCE
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          Send the user to <code className="text-xs bg-muted px-1 py-0.5 rounded">auth.oxy.so</code> with
          your <code className="text-xs bg-muted px-1 py-0.5 rounded">client_id</code> and a PKCE
          challenge, then exchange the returned code
          at <code className="text-xs bg-muted px-1 py-0.5 rounded">/auth/oauth/token</code> for a
          user access token. Public clients (mobile, SPA) send only
          the <code className="text-xs bg-muted px-1 py-0.5 rounded">client_id</code> and prove
          possession with the PKCE verifier — never with the secret, which such a client cannot
          keep. Confidential clients send the secret from their backend.
        </p>

        <div className="p-4 rounded-lg bg-muted/50 border border-border">
          <p className="text-sm font-medium text-foreground">
            Not available yet: a single-string machine key
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            A one-value bearer credential that standard OpenAI-compatible SDKs accept without
            implementing a token exchange is being added to the credential model, and this page will
            document it when it ships. Until then, the two mechanisms above are the whole list. The
            inference endpoints under <code>/v1</code> currently accept a signed-in user's access
            token only.
          </p>
        </div>
      </div>

      {/* Scopes */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Credential scopes</h2>
        <p className="text-sm text-muted-foreground mb-4">
          A credential carries scopes that limit what tokens minted from it can do. The effective
          set is always the credential's scopes intersected with the application's, so a credential
          can never out-grant the application that owns it:
        </p>
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">inference:invoke</Badge>
            <p className="text-sm text-muted-foreground">Run inference requests, billed to the owning account</p>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">inference:models:read</Badge>
            <p className="text-sm text-muted-foreground">List available models</p>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">inference:usage:read</Badge>
            <p className="text-sm text-muted-foreground">Read this application's inference usage and costs</p>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">inference:routing:read</Badge>
            <p className="text-sm text-muted-foreground">Read routing profiles and provider descriptors</p>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">inference:providers:read</Badge>
            <p className="text-sm text-muted-foreground">Read connected inference providers, never their secrets</p>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">inference:routing:write</Badge>
            <p className="text-sm text-muted-foreground">
              Change routing profiles. Staff approval required — it decides where other tenants' requests are served from.
            </p>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
            <Badge variant="outline" className="font-mono text-xs mt-0.5">inference:providers:write</Badge>
            <p className="text-sm text-muted-foreground">
              Manage provider and BYOK connections. Staff approval required.
            </p>
          </div>
        </div>
      </div>

      {/* Rate Limits */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Rate Limits</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Each credential has configurable rate limits. When you exceed the rate limit, the API will
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
              <p className="text-sm font-medium text-yellow-500">
                The secret is the thing to protect
              </p>
              <p className="text-xs text-yellow-500/80 mt-1">
                Never put a client secret or a minted token in client-side code or a public
                repository. The <code>clientId</code> is public and needs no such care.
              </p>
            </div>
          </div>
        </div>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Store secrets in environment variables, not in code
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Use separate credentials for development, staging and production
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Rotate regularly — the previous secret stays valid for a 7-day grace window, so a
            rotation does not take your deployment down
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Request the minimum scopes each credential needs
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            Revoke a credential immediately if a secret leaks — revocation takes effect at once,
            with no grace window
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
            <p className="text-xs text-muted-foreground">
              Missing, invalid or expired token. Sending a bare <code>oxy_dk_</code> client id also
              lands here — it is an identifier, not a credential.
            </p>
          </div>
          <div className="p-3 rounded-lg border">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="destructive" className="text-xs">403</Badge>
              <span className="text-sm font-medium">Forbidden</span>
            </div>
            <p className="text-xs text-muted-foreground">
              The token's credential doesn't carry the required scope
            </p>
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
            <span className="text-sm text-foreground">Manage your applications and credentials</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
}
