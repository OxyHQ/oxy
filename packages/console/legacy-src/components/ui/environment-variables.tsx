'use client';

import * as React from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';

// Context for visibility state
interface EnvironmentVariablesContextValue {
  showValues: boolean;
  setShowValues: (show: boolean) => void;
}

const EnvironmentVariablesContext = React.createContext<EnvironmentVariablesContextValue | null>(
  null,
);

function useEnvironmentVariables() {
  const context = React.useContext(EnvironmentVariablesContext);
  if (!context) {
    throw new Error('EnvironmentVariables components must be used within <EnvironmentVariables>');
  }
  return context;
}

// Context for individual variable
interface EnvironmentVariableContextValue {
  name: string;
  value: string;
}

const EnvironmentVariableContext = React.createContext<EnvironmentVariableContextValue | null>(
  null,
);

function useEnvironmentVariable() {
  const context = React.useContext(EnvironmentVariableContext);
  if (!context) {
    throw new Error('EnvironmentVariable components must be used within <EnvironmentVariable>');
  }
  return context;
}

// Root component
interface EnvironmentVariablesProps extends React.HTMLAttributes<HTMLDivElement> {
  showValues?: boolean;
  defaultShowValues?: boolean;
  onShowValuesChange?: (show: boolean) => void;
}

function EnvironmentVariables({
  showValues: controlledShowValues,
  defaultShowValues = false,
  onShowValuesChange,
  className,
  children,
  ...props
}: EnvironmentVariablesProps) {
  const [uncontrolledShowValues, setUncontrolledShowValues] = React.useState(defaultShowValues);

  const isControlled = controlledShowValues !== undefined;
  const showValues = isControlled ? controlledShowValues : uncontrolledShowValues;

  const setShowValues = React.useCallback(
    (show: boolean) => {
      if (!isControlled) {
        setUncontrolledShowValues(show);
      }
      onShowValuesChange?.(show);
    },
    [isControlled, onShowValuesChange],
  );

  return (
    <EnvironmentVariablesContext.Provider value={{ showValues, setShowValues }}>
      <div className={cn('rounded-lg border bg-card', className)} {...props}>
        {children}
      </div>
    </EnvironmentVariablesContext.Provider>
  );
}

// Header
function EnvironmentVariablesHeader({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center justify-between border-b px-4 py-3', className)}
      {...props}
    >
      {children}
    </div>
  );
}

// Title
function EnvironmentVariablesTitle({
  className,
  children = 'Environment Variables',
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-sm font-medium', className)} {...props}>
      {children}
    </h3>
  );
}

// Toggle
function EnvironmentVariablesToggle({ className, ...props }: React.ComponentProps<typeof Switch>) {
  const { showValues, setShowValues } = useEnvironmentVariables();

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Show values</span>
      <Switch
        checked={showValues}
        onCheckedChange={setShowValues}
        className={className}
        {...props}
      />
    </div>
  );
}

// Content
function EnvironmentVariablesContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('divide-y', className)} {...props}>
      {children}
    </div>
  );
}

// Individual variable
interface EnvironmentVariableProps extends React.HTMLAttributes<HTMLDivElement> {
  name: string;
  value: string;
}

function EnvironmentVariable({
  name,
  value,
  className,
  children,
  ...props
}: EnvironmentVariableProps) {
  return (
    <EnvironmentVariableContext.Provider value={{ name, value }}>
      <div
        className={cn('flex items-center justify-between gap-4 px-4 py-3', className)}
        {...props}
      >
        {children || (
          <>
            <EnvironmentVariableGroup>
              <EnvironmentVariableName />
              <EnvironmentVariableValue />
            </EnvironmentVariableGroup>
            <EnvironmentVariableCopyButton />
          </>
        )}
      </div>
    </EnvironmentVariableContext.Provider>
  );
}

// Group
function EnvironmentVariableGroup({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col gap-1 min-w-0 flex-1', className)} {...props}>
      {children}
    </div>
  );
}

// Name
function EnvironmentVariableName({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  const { name } = useEnvironmentVariable();

  return (
    <span className={cn('text-sm font-medium font-mono', className)} {...props}>
      {children ?? name}
    </span>
  );
}

// Value
function EnvironmentVariableValue({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  const { value } = useEnvironmentVariable();
  const { showValues } = useEnvironmentVariables();

  const displayValue = showValues ? value : '•'.repeat(Math.min(value.length, 32));

  return (
    <span
      className={cn(
        'text-xs text-muted-foreground font-mono truncate',
        !showValues && 'tracking-tight',
        className,
      )}
      {...props}
    >
      {children ?? displayValue}
    </span>
  );
}

// Copy button
interface EnvironmentVariableCopyButtonProps
  extends Omit<React.ComponentProps<typeof Button>, 'onClick' | 'onError'> {
  copyFormat?: 'name' | 'value' | 'export';
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
}

function EnvironmentVariableCopyButton({
  copyFormat = 'value',
  onCopy,
  onError,
  timeout = 2000,
  className,
  ...props
}: EnvironmentVariableCopyButtonProps) {
  const { name, value } = useEnvironmentVariable();
  const [copied, setCopied] = React.useState(false);

  const getCopyText = () => {
    switch (copyFormat) {
      case 'name':
        return name;
      case 'export':
        return `export ${name}="${value}"`;
      case 'value':
      default:
        return value;
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(getCopyText());
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
      className={cn('h-8 w-8 shrink-0', className)}
      onClick={handleCopy}
      {...props}
    >
      <HugeiconsIcon
        icon={copied ? Tick02Icon : Copy01Icon}
        className={cn('size-4', copied && 'text-green-500')}
      />
      <span className="sr-only">{copied ? 'Copied' : 'Copy'}</span>
    </Button>
  );
}

// Required badge
function EnvironmentVariableRequired({
  className,
  children = 'Required',
  ...props
}: React.ComponentProps<typeof Badge>) {
  return (
    <Badge variant="secondary" className={cn('text-xs', className)} {...props}>
      {children}
    </Badge>
  );
}

export {
  EnvironmentVariables,
  EnvironmentVariablesHeader,
  EnvironmentVariablesTitle,
  EnvironmentVariablesToggle,
  EnvironmentVariablesContent,
  EnvironmentVariable,
  EnvironmentVariableGroup,
  EnvironmentVariableName,
  EnvironmentVariableValue,
  EnvironmentVariableCopyButton,
  EnvironmentVariableRequired,
};
