import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  UserMultiple02Icon,
} from '@hugeicons/core-free-icons';
import { useApplications } from '@/hooks/use-applications';
import { useCredits } from '@/hooks/use-billing';
import { Button } from '@/components/ui/button';

export const Route = createFileRoute('/_layout/dashboard')({
  component: DashboardPage,
});

function DashboardPage() {
  const { data: applications = [] } = useApplications();
  const { data: credits } = useCredits();

  const hasCredits = (credits?.credits ?? 0) > 0;
  const hasApplication = applications.length > 0;

  const onboardingSteps = [
    {
      id: 'credits',
      title: 'Buy some credits',
      completed: hasCredits,
      href: '/billing',
      action: 'Purchase',
    },
    {
      id: 'application',
      title: 'Create your first application',
      completed: hasApplication,
      href: '/apps',
      action: hasApplication ? undefined : 'Create',
    },
    {
      id: 'request',
      title: 'Make your first request',
      completed: false,
      href: '/examples',
      action: 'View docs',
    },
  ];

  const allCompleted = onboardingSteps.every((step) => step.completed);

  return (
    <div className="flex-1 bg-background relative overflow-hidden h-full">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1000px] h-[1000px] opacity-[0.02]">
          <svg viewBox="0 0 800 800" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M400 50 Q600 150 550 400 Q500 650 400 750 Q300 650 250 400 Q200 150 400 50"
              stroke="currentColor"
              strokeWidth="0.5"
              className="text-foreground"
            />
            <path
              d="M100 350 Q300 380 400 400 Q500 420 700 450"
              stroke="currentColor"
              strokeWidth="0.5"
              className="text-foreground"
            />
            <path
              d="M150 250 Q350 300 400 350 Q450 400 650 550"
              stroke="currentColor"
              strokeWidth="0.5"
              className="text-foreground"
            />
          </svg>
        </div>
      </div>

      {/* Main content */}
      <div className="relative z-10 flex flex-col lg:flex-row items-center justify-center h-full px-8 py-12 gap-16 lg:gap-32">
        {/* Left side - Welcome text */}
        <div className="max-w-md text-center lg:text-left">
          <h1 className="text-3xl lg:text-4xl font-semibold text-foreground mb-4">
            Let's get you up and running
          </h1>
          <p className="text-muted-foreground text-lg">
            Welcome to your new account. Follow the steps highlighted to get up and running in
            minutes.
          </p>

          <div className="mt-12">
            <Button asChild variant="outline" className="gap-2">
              <Link to="/settings/account">
                <HugeiconsIcon icon={UserMultiple02Icon} size={18} />
                Invite your team
              </Link>
            </Button>
          </div>
        </div>

        {/* Right side - Onboarding card */}
        <div className="w-full max-w-md">
          <div className="border border-border rounded-xl bg-card/50 backdrop-blur-sm overflow-hidden">
            {onboardingSteps.map((step, index) => (
              <div
                key={step.id}
                className={`flex items-center justify-between px-6 py-5 ${
                  index < onboardingSteps.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <div className="flex items-center gap-4">
                  {step.completed ? (
                    <HugeiconsIcon
                      icon={CheckmarkCircle01Icon}
                      size={24}
                      className="text-green-500"
                    />
                  ) : (
                    <div className="w-6 h-6 rounded-full border-2 border-muted-foreground/30" />
                  )}
                  <span
                    className={`text-sm ${step.completed ? 'text-muted-foreground line-through' : 'text-foreground'}`}
                  >
                    {step.title}
                  </span>
                </div>
                {step.action && !step.completed && (
                  <Link
                    to={step.href}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {step.action}
                  </Link>
                )}
              </div>
            ))}
          </div>

          {/* Stats below card when user has activity */}
          {applications.length > 0 && (
            <div className="mt-6 grid grid-cols-1 gap-4 text-center">
              <div>
                <p className="text-2xl font-semibold text-foreground">{applications.length}</p>
                <p className="text-xs text-muted-foreground">Applications</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Quick links at bottom */}
      {allCompleted && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-6 text-sm">
            <Link
              to="/documentation"
              className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              Documentation
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
            </Link>
            <Link
              to="/examples"
              className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              Examples
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
            </Link>
            <Link
              to="/models"
              className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              Models
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
