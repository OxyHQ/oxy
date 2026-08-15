import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowRight01Icon,
  ArtificialIntelligence01Icon,
  Book02Icon,
  Key01Icon,
  Message01Icon,
  RocketIcon,
  SourceCodeIcon,
} from '@hugeicons/core-free-icons';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/_layout/documentation/')({
  component: DocumentationIndexPage,
});

const sections = [
  {
    title: 'Quick Start',
    description: 'Get up and running in minutes',
    href: '/documentation/quickstart',
    icon: RocketIcon,
  },
  {
    title: 'Authentication',
    description: 'Learn how to authenticate your API requests',
    href: '/documentation/authentication',
    icon: Key01Icon,
  },
  {
    title: 'Chat Completions',
    description: 'Create chat completions with our models',
    href: '/documentation/chat-completions',
    icon: Message01Icon,
  },
  {
    title: 'Models',
    description: 'Available models and their capabilities',
    href: '/documentation/models',
    icon: ArtificialIntelligence01Icon,
  },
  {
    title: 'SDKs & Libraries',
    description: 'Official and community SDKs',
    href: '/documentation/sdks',
    icon: SourceCodeIcon,
  },
];

function DocumentationIndexPage() {
  return (
    <div className="flex-1 bg-background">
      {/* Header */}
      <div className="px-6 py-6 border-b border-border">
        <div className="flex items-center gap-2 mb-2">
          <HugeiconsIcon icon={Book02Icon} className="size-6 text-muted-foreground" />
          <h1 className="text-2xl font-semibold text-foreground">Documentation</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Everything you need to integrate with the Oxy API
        </p>
      </div>

      {/* Documentation Sections */}
      <div className="p-6">
        <div className="grid gap-4 md:grid-cols-2">
          {sections.map((section) => (
            <Link key={section.href} to={section.href}>
              <Card className="h-full hover:bg-muted/50 transition-colors cursor-pointer">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <HugeiconsIcon
                      icon={section.icon}
                      className="size-8 text-primary mb-2"
                    />
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      className="size-4 text-muted-foreground"
                    />
                  </div>
                  <CardTitle className="text-base">{section.title}</CardTitle>
                  <CardDescription>{section.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>

        {/* Quick Links */}
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-foreground mb-4">Quick Links</h2>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/apps"
              className="text-sm text-primary hover:underline"
            >
              Create an application
            </Link>
            <span className="text-muted-foreground">•</span>
            <Link
              to="/examples"
              className="text-sm text-primary hover:underline"
            >
              View Examples
            </Link>
            <span className="text-muted-foreground">•</span>
            <Link
              to="/models"
              className="text-sm text-primary hover:underline"
            >
              Model Statistics
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
