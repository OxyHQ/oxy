import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  Copy01Icon,
  Delete02Icon,
  Mic01Icon,
  SentIcon,
  Settings01Icon,
  SparklesIcon,
  StopIcon,
  TextIcon,
} from '@hugeicons/core-free-icons';
import { useAuth } from '@oxyhq/services';
import { toast } from '@oxyhq/bloom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from '@/components/ui/item';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useModelsStats } from '@/hooks/use-models';
import config from '@/lib/config';

export const Route = createFileRoute('/_layout/playground')({
  component: PlaygroundPage,
});

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface UsageStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

function PlaygroundPage() {
  const { data: modelsData, isLoading: modelsLoading } = useModelsStats();
  const { oxyServices, isAuthenticated } = useAuth();

  // Chat state
  const [messages, setMessages] = useState<Array<Message>>([]);
  const [systemPrompt, setSystemPrompt] = useState(
    'You are a helpful AI assistant.'
  );
  const [userInput, setUserInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [usage, setUsage] = useState<UsageStats | null>(null);

  // Settings state
  const [selectedModel, setSelectedModel] = useState('alia-lite');
  const [temperature, setTemperature] = useState([0.7]);
  const [maxTokens, setMaxTokens] = useState(1024);

  const abortControllerRef = useRef<AbortController | null>(null);

  const models = modelsData?.models ?? [];
  const currentModel = models.find((m) => m.id === selectedModel);

  const handleSend = useCallback(async () => {
    if (!userInput.trim() || isStreaming) return;

    if (!isAuthenticated) {
      toast.error('Please sign in to use the playground.');
      return;
    }

    let token = oxyServices.getAccessToken();
    const expSeconds = token ? oxyServices.getAccessTokenExpiry() : null;
    if (token && expSeconds !== null && expSeconds * 1000 - Date.now() < 60_000) {
      // Expiring within the next minute — refresh before this direct fetch
      // (OxyProvider's own proactive scheduler usually beats this, but a
      // manual bearer read for a raw `fetch` call still checks defensively).
      token = (await oxyServices.httpService.refreshAccessToken('preflight')) ?? token;
    }
    if (!token) {
      toast.error('Authentication expired. Please sign in again.');
      return;
    }

    const newMessages: Array<Message> = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      ...messages,
      { role: 'user' as const, content: userInput.trim() },
    ];

    setMessages([...messages, { role: 'user', content: userInput.trim() }]);
    setUserInput('');
    setIsStreaming(true);
    setStreamingContent('');
    setUsage(null);

    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(`${config.oxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: newMessages,
          temperature: temperature[0],
          max_tokens: maxTokens,
          stream: true,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Request failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let assistantContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                assistantContent += content;
                setStreamingContent(assistantContent);
              }
              if (parsed.usage) {
                setUsage(parsed.usage);
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: assistantContent },
      ]);
      setStreamingContent('');
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        toast.info('Request cancelled');
      } else {
        toast.error((error as Error).message || 'Failed to send message');
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }, [
    userInput,
    isStreaming,
    isAuthenticated,
    oxyServices,
    messages,
    systemPrompt,
    selectedModel,
    temperature,
    maxTokens,
  ]);

  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  const handleClear = () => {
    setMessages([]);
    setStreamingContent('');
    setUsage(null);
  };

  const handleCopyResponse = (content: string) => {
    navigator.clipboard.writeText(content);
    toast.success('Copied to clipboard');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          {/* Model Selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2">
                <HugeiconsIcon icon={AiBrain01Icon} size={16} />
                {currentModel?.name || 'Select Model'}
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={14}
                  className="text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64" align="start">
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                Available Models
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={selectedModel}
                onValueChange={setSelectedModel}
              >
                {modelsLoading ? (
                  <div className="flex items-center gap-2 p-2">
                    <Spinner className="size-4" />
                    <span className="text-sm text-muted-foreground">Loading...</span>
                  </div>
                ) : (
                  models.map((model) => (
                    <DropdownMenuRadioItem key={model.id} value={model.id}>
                      <Item size="xs" className="p-0">
                        <ItemContent>
                          <ItemTitle className="flex items-center gap-2">
                            {model.name}
                            <Badge variant="secondary" className="text-xs">
                              {model.tier}
                            </Badge>
                          </ItemTitle>
                          <ItemDescription className="text-xs">
                            {model.maxTokens.toLocaleString()} tokens max
                          </ItemDescription>
                        </ItemContent>
                      </Item>
                    </DropdownMenuRadioItem>
                  ))
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Auth Status */}
          <span className="text-xs text-muted-foreground">
            {isAuthenticated ? 'Using session auth' : 'Not signed in'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Usage Stats */}
          {usage && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground mr-2">
              <span>{usage.prompt_tokens} prompt</span>
              <span>{usage.completion_tokens} completion</span>
              <span className="font-medium text-foreground">
                {usage.total_tokens} total
              </span>
            </div>
          )}

          {/* Settings Popover */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="icon">
                    <HugeiconsIcon icon={Settings01Icon} size={16} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-80" align="end">
              <Card className="border-0 shadow-none">
                <CardHeader className="p-0 pb-4">
                  <CardTitle className="text-sm">Model Settings</CardTitle>
                  <CardDescription className="text-xs">
                    Configure parameters for the AI model
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel htmlFor="system-prompt">System Prompt</FieldLabel>
                      <Textarea
                        id="system-prompt"
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        placeholder="Instructions for the AI..."
                        rows={3}
                        className="resize-none text-sm"
                      />
                    </Field>
                    <Field>
                      <div className="flex items-center justify-between">
                        <FieldLabel>Temperature</FieldLabel>
                        <span className="text-sm text-muted-foreground">
                          {temperature[0]}
                        </span>
                      </div>
                      <Slider
                        value={temperature}
                        onValueChange={setTemperature}
                        min={0}
                        max={2}
                        step={0.1}
                      />
                      <FieldDescription>
                        Lower = focused, higher = creative
                      </FieldDescription>
                    </Field>
                    <Field>
                      <div className="flex items-center justify-between">
                        <FieldLabel htmlFor="max-tokens">Max Tokens</FieldLabel>
                        <span className="text-sm text-muted-foreground">
                          {maxTokens}
                        </span>
                      </div>
                      <Input
                        id="max-tokens"
                        type="number"
                        min={1}
                        max={4096}
                        value={maxTokens}
                        onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)}
                      />
                    </Field>
                  </FieldGroup>
                </CardContent>
              </Card>
            </PopoverContent>
          </Popover>

          {/* Clear Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" onClick={handleClear}>
                <HugeiconsIcon icon={Delete02Icon} size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear conversation</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Messages */}
        <ScrollArea className="flex-1">
          <div className="p-6 space-y-4 max-w-3xl mx-auto">
            {messages.length === 0 && !streamingContent && (
              <div className="text-center py-20">
                <HugeiconsIcon
                  icon={SparklesIcon}
                  size={48}
                  className="mx-auto mb-4 text-muted-foreground/50"
                />
                <p className="text-sm text-muted-foreground">
                  Start a conversation with the AI
                </p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Press <Kbd>Enter</Kbd> to send, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for new line
                </p>
              </div>
            )}

            {messages.map((message, index) => (
              <div
                key={index}
                className={`flex gap-3 ${
                  message.role === 'user' ? 'flex-row-reverse' : ''
                }`}
              >
                <Avatar className="size-8 shrink-0">
                  <AvatarFallback className={message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}>
                    {message.role === 'user' ? 'U' : 'AI'}
                  </AvatarFallback>
                </Avatar>
                <div
                  className={`max-w-[80%] rounded-lg p-3 ${
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                    {message.role === 'assistant' && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 -mt-1 -mr-1"
                            onClick={() => handleCopyResponse(message.content)}
                          >
                            <HugeiconsIcon icon={Copy01Icon} size={12} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Copy</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {streamingContent && (
              <div className="flex gap-3">
                <Avatar className="size-8 shrink-0">
                  <AvatarFallback className="bg-muted">AI</AvatarFallback>
                </Avatar>
                <div className="max-w-[80%] rounded-lg p-3 bg-muted">
                  <p className="text-sm whitespace-pre-wrap">
                    {streamingContent}
                    <span className="animate-pulse">▊</span>
                  </p>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input Area */}
        <div className="border-t border-border p-4 shrink-0">
          <div className="max-w-3xl mx-auto">
            <Field>
              <FieldLabel htmlFor="prompt" className="sr-only">
                Message
              </FieldLabel>
              <InputGroup>
                <InputGroupTextarea
                  id="prompt"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask anything..."
                  rows={2}
                  disabled={isStreaming}
                />
                <InputGroupAddon align="block-end">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InputGroupButton variant="ghost" size="icon-sm">
                        <HugeiconsIcon icon={TextIcon} size={16} />
                      </InputGroupButton>
                    </TooltipTrigger>
                    <TooltipContent>
                      Format text <Kbd>/</Kbd>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <InputGroupButton variant="ghost" size="icon-sm" className="ml-auto">
                        <HugeiconsIcon icon={Mic01Icon} size={16} />
                      </InputGroupButton>
                    </TooltipTrigger>
                    <TooltipContent>Voice input</TooltipContent>
                  </Tooltip>
                  {isStreaming ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <InputGroupButton
                          variant="destructive"
                          size="icon-sm"
                          onClick={handleStop}
                        >
                          <HugeiconsIcon icon={StopIcon} size={16} />
                        </InputGroupButton>
                      </TooltipTrigger>
                      <TooltipContent>Stop generating</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <InputGroupButton
                          variant="default"
                          size="icon-sm"
                          onClick={handleSend}
                          disabled={!userInput.trim()}
                        >
                          {isStreaming ? (
                            <Spinner className="size-4" />
                          ) : (
                            <HugeiconsIcon icon={SentIcon} size={16} />
                          )}
                        </InputGroupButton>
                      </TooltipTrigger>
                      <TooltipContent className="flex items-center gap-2">
                        Send message <Kbd>Enter</Kbd>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </div>
        </div>
      </div>
    </div>
  );
}
