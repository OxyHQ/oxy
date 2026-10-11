'use client';

import * as React from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArtificialIntelligence01Icon,
  Settings01Icon,
  SourceCodeIcon,
} from '@hugeicons/core-free-icons';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

// Root component
function Agent({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('rounded-lg border bg-card', className)} {...props}>
      {children}
    </div>
  );
}

// Header
interface AgentHeaderProps extends React.ComponentProps<'div'> {
  name: string;
  model?: string;
}

function AgentHeader({ name, model, className, ...props }: AgentHeaderProps) {
  return (
    <div
      className={cn('flex items-center justify-between border-b px-4 py-3', className)}
      {...props}
    >
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={ArtificialIntelligence01Icon}
          className="size-5 text-muted-foreground"
        />
        <h3 className="text-sm font-medium">{name}</h3>
      </div>
      {model && (
        <Badge variant="secondary" className="text-xs font-mono">
          {model}
        </Badge>
      )}
    </div>
  );
}

// Content
function AgentContent({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('divide-y', className)} {...props}>
      {children}
    </div>
  );
}

// Instructions
interface AgentInstructionsProps extends React.ComponentProps<'div'> {
  children: string;
}

function AgentInstructions({ children, className, ...props }: AgentInstructionsProps) {
  return (
    <div className={cn('px-4 py-3', className)} {...props}>
      <div className="flex items-center gap-2 mb-2">
        <HugeiconsIcon icon={Settings01Icon} className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Instructions
        </span>
      </div>
      <p className="text-sm text-foreground whitespace-pre-wrap">{children}</p>
    </div>
  );
}

// Tools container
interface AgentToolsProps {
  className?: string;
  children?: React.ReactNode;
}

function AgentTools({ className, children }: AgentToolsProps) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <HugeiconsIcon icon={SourceCodeIcon} className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Tools
        </span>
      </div>
      <Accordion type="multiple" className={cn('', className)}>
        {children}
      </Accordion>
    </div>
  );
}

// Individual tool
interface AgentToolProps extends Omit<React.ComponentProps<typeof AccordionItem>, 'value'> {
  tool: {
    description?: string;
    parameters?: {
      jsonSchema?: Record<string, unknown>;
    };
  };
  value: string;
}

function AgentTool({ tool, value, className, ...props }: AgentToolProps) {
  const schema = tool.parameters?.jsonSchema;
  const schemaString = schema ? JSON.stringify(schema, null, 2) : null;

  return (
    <AccordionItem value={value} className={cn('border-none', className)} {...props}>
      <AccordionTrigger className="text-sm py-2 hover:no-underline">
        <span className="font-mono text-xs">{value}</span>
        {tool.description && (
          <span className="ml-2 text-muted-foreground font-normal truncate">
            {tool.description}
          </span>
        )}
      </AccordionTrigger>
      {schemaString && (
        <AccordionContent>
          <pre className="text-xs font-mono bg-muted/50 rounded-md p-3 overflow-x-auto">
            {schemaString}
          </pre>
        </AccordionContent>
      )}
    </AccordionItem>
  );
}

// Output schema
interface AgentOutputProps extends React.ComponentProps<'div'> {
  schema: string;
}

function AgentOutput({ schema, className, ...props }: AgentOutputProps) {
  return (
    <div className={cn('px-4 py-3', className)} {...props}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Output Schema
        </span>
      </div>
      <pre className="text-xs font-mono bg-muted/50 rounded-md p-3 overflow-x-auto">{schema}</pre>
    </div>
  );
}

export { Agent, AgentHeader, AgentContent, AgentInstructions, AgentTools, AgentTool, AgentOutput };
