'use client';

import * as React from 'react';
import { codeToHtml } from 'shiki';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { BundledLanguage } from 'shiki';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Context for sharing code between components
interface CodeBlockContextValue {
  code: string;
  language: BundledLanguage;
  showLineNumbers: boolean;
}

const CodeBlockContext = React.createContext<CodeBlockContextValue | null>(null);

function useCodeBlock() {
  const context = React.useContext(CodeBlockContext);
  if (!context) {
    throw new Error('CodeBlock components must be used within <CodeBlock>');
  }
  return context;
}

// Root component
interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  code: string;
  language?: BundledLanguage;
  showLineNumbers?: boolean;
}

function CodeBlock({
  code,
  language = 'typescript',
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) {
  return (
    <CodeBlockContext.Provider value={{ code, language, showLineNumbers }}>
      <CodeBlockContainer className={className} {...props}>
        {children}
        <CodeBlockContent code={code} language={language} showLineNumbers={showLineNumbers} />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
}

// Container with performance optimizations
function CodeBlockContainer({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-muted/50 overflow-hidden',
        '[content-visibility:auto]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

// Header
function CodeBlockHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center justify-between px-4 py-2 border-b bg-muted/30', className)}
      {...props}
    >
      {children}
    </div>
  );
}

// Title (left side of header)
function CodeBlockTitle({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center gap-2 text-sm', className)} {...props}>
      {children}
    </div>
  );
}

// Filename
function CodeBlockFilename({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn('font-mono text-xs text-muted-foreground', className)} {...props}>
      {children}
    </span>
  );
}

// Actions (right side of header)
function CodeBlockActions({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center gap-2', className)} {...props}>
      {children}
    </div>
  );
}

// Copy button
interface CodeBlockCopyButtonProps
  extends Omit<React.ComponentProps<typeof Button>, 'onClick' | 'onError'> {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
}

function CodeBlockCopyButton({
  onCopy,
  onError,
  timeout = 2000,
  className,
  children,
  ...props
}: CodeBlockCopyButtonProps) {
  const { code } = useCodeBlock();
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      onCopy?.();
      setTimeout(() => setCopied(false), timeout);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error('Failed to copy'));
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('h-7 w-7', className)}
      onClick={handleCopy}
      {...props}
    >
      {children ?? (
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          className={cn('size-3.5', copied && 'text-green-500')}
        />
      )}
      <span className="sr-only">{copied ? 'Copied' : 'Copy code'}</span>
    </Button>
  );
}

// Language selector
interface CodeBlockLanguageSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
}

function CodeBlockLanguageSelector({
  value,
  onValueChange,
  children,
}: CodeBlockLanguageSelectorProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      {children}
    </Select>
  );
}

function CodeBlockLanguageSelectorTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn('h-7 w-auto gap-1.5 text-xs px-2 border-none bg-transparent', className)}
      {...props}
    >
      {children}
    </SelectTrigger>
  );
}

function CodeBlockLanguageSelectorValue(props: React.ComponentProps<typeof SelectValue>) {
  return <SelectValue {...props} />;
}

function CodeBlockLanguageSelectorContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectContent>) {
  return (
    <SelectContent align="end" className={className} {...props}>
      {children}
    </SelectContent>
  );
}

function CodeBlockLanguageSelectorItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectItem>) {
  return (
    <SelectItem className={cn('text-xs', className)} {...props}>
      {children}
    </SelectItem>
  );
}

// Content with syntax highlighting
interface CodeBlockContentProps {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
}

function CodeBlockContent({ code, language, showLineNumbers = false }: CodeBlockContentProps) {
  const [html, setHtml] = React.useState<string>('');
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    async function highlight() {
      try {
        const result = await codeToHtml(code, {
          lang: language,
          themes: {
            light: 'github-light',
            dark: 'github-dark',
          },
        });
        if (!cancelled) {
          setHtml(result);
          setIsLoading(false);
        }
      } catch (error) {
        // Fallback to plain text if highlighting fails
        if (!cancelled) {
          setHtml(`<pre><code>${escapeHtml(code)}</code></pre>`);
          setIsLoading(false);
        }
      }
    }

    highlight();
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (isLoading) {
    return (
      <div className="p-4">
        <pre className="text-sm font-mono text-muted-foreground">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'overflow-x-auto p-4 text-sm',
        '[&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0',
        '[&_code]:!bg-transparent [&_.shiki]:!bg-transparent',
        showLineNumbers &&
          '[&_.line]::before:content-[counter(line)] [&_.line]::before:mr-4 [&_.line]::before:text-muted-foreground/50 [&_.line]::before:text-right [&_.line]::before:w-4 [&_.line]::before:inline-block [&_pre]:counter-reset-[line] [&_.line]:counter-increment-[line]',
      )}
      // Safe: Shiki's codeToHtml escapes the input `code` string before
      // wrapping it in highlight spans; the fallback path runs the code
      // through escapeHtml(). Theme and language strings are controlled by
      // this component, not user input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// Helper to escape HTML
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export {
  CodeBlock,
  CodeBlockContainer,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockFilename,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockLanguageSelector,
  CodeBlockLanguageSelectorTrigger,
  CodeBlockLanguageSelectorValue,
  CodeBlockLanguageSelectorContent,
  CodeBlockLanguageSelectorItem,
  CodeBlockContent,
};
