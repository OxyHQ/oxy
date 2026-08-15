import { Link, createFileRoute } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { MODEL_ID_PLACEHOLDER, MODEL_REVISION_PLACEHOLDER } from '@/lib/model-reference';

export const Route = createFileRoute('/_layout/documentation/models')({
  component: ModelsDocPage,
});

/**
 * How the catalogue is structured — not a list of models.
 *
 * This page used to hold a hardcoded array of four objects: `alia-lite`,
 * `alia-v1`, `alia-v1-pro` and `alia-v1-pro-max`, each with a tier, a context
 * window and a feature list. None of it was true. Those names were product tiers
 * a proxy forwarded upstream, where something else decided what actually ran, so
 * a reader could not learn who published the weights, which revision served
 * their request, what licence applied or whether their data was retained.
 *
 * ADR 0008 retires them as model identities rather than renaming them. What a
 * documentation page can honestly say before the catalogue is seeded is what the
 * identifiers MEAN, so that is what this page says; the live list lives on the
 * Models page and is empty until workstream 5 publishes into it.
 */
const CONCEPTS = [
  {
    name: 'Publisher',
    summary: 'Who released the weights, and under what licence.',
    detail:
      'A publisher is not a provider: an organisation can publish a model it serves nowhere, and a provider can serve models it published none of.',
  },
  {
    name: 'Model',
    summary: 'A named model line from a publisher — the stable thing you write in your code.',
    detail: `Written ${MODEL_ID_PLACEHOLDER}. Naming a model asks for that model, resolved to some revision by policy.`,
  },
  {
    name: 'Revision',
    summary: 'An immutable released version of a model.',
    detail: `Written ${MODEL_REVISION_PLACEHOLDER}. Once published, the reference never points at different weights — a behaviour change gets a new revision, it never mutates an existing one.`,
  },
  {
    name: 'Provider',
    summary: 'The organisation that actually runs the inference.',
    detail:
      'The same revision served by two providers is two deployments of one revision, not two models.',
  },
  {
    name: 'Deployment',
    summary: 'A concrete servable endpoint: provider, revision, region and capacity.',
    detail:
      'Deployments carry the operational facts — region, retention policy, zero-data-retention availability. Their health and availability belong to the data plane; Console shows the customer-safe projection.',
  },
  {
    name: 'Routing profile',
    summary: 'A policy object that chooses among deployments under constraints.',
    detail:
      'A profile has no publisher, no revision, no licence and no weights, and its slug can never be written as a model id. Naming a profile asks Oxy to choose; naming a model does not.',
  },
];

function ModelsDocPage() {
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
        <h1 className="text-2xl font-semibold text-foreground">Models</h1>
        <p className="text-sm text-muted-foreground mt-1">
          How Oxy names models, revisions and routing profiles
        </p>
      </div>

      {/* What is published today */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">What is published today</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Oxy publishes no models yet. The{' '}
          <Link to="/models" className="text-primary hover:underline">
            Models page
          </Link>{' '}
          reads the live catalogue, and it is the only place this Console will ever name a model.
          A model appears there once it has a current revision and a route you are allowed to
          use, carrying that route's publisher, licence, regions and data policy with it — never
          on a name alone.
        </p>
        <InferenceAvailabilityNotice />
      </div>

      {/* Identifiers */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">Identifiers</h2>
        <div className="space-y-4">
          <div className="p-4 rounded-lg border">
            <code className="text-sm font-mono text-foreground">{MODEL_ID_PLACEHOLDER}</code>
            <p className="text-sm text-muted-foreground mt-2">
              A model line. Resolved to a revision by policy, and reported back on every response
              as the concrete revision that ran.
            </p>
          </div>
          <div className="p-4 rounded-lg border">
            <code className="text-sm font-mono text-foreground">{MODEL_REVISION_PLACEHOLDER}</code>
            <p className="text-sm text-muted-foreground mt-2">
              An exact pin. Served exactly or refused — a request naming a concrete revision is
              never answered with a different model, whatever a routing policy says.
            </p>
          </div>
          <div className="p-4 rounded-lg border">
            <code className="text-sm font-mono text-foreground">{'<profile>'}</code>
            <p className="text-sm text-muted-foreground mt-2">
              A routing profile slug. A profile slug never contains a slash, which is what keeps
              "did I ask for a concrete model, or ask Oxy to choose one" decidable from the request
              alone.
            </p>
          </div>
        </div>
      </div>

      {/* Concepts */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-2">Six things, not one</h2>
        <p className="text-sm text-muted-foreground mb-4">
          A single name cannot answer who published a model, which weights ran, where they ran and
          what happened to your prompt. The catalogue keeps them apart so each question has an
          answer.
        </p>
        <div className="space-y-4">
          {CONCEPTS.map((concept) => (
            <Card key={concept.name}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{concept.name}</CardTitle>
                <CardDescription className="mt-1">{concept.summary}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{concept.detail}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Failover vs fallback */}
      <div className="px-6 py-6 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          Deployment failover is not model fallback
        </h2>
        <div className="space-y-4">
          <div className="p-4 rounded-lg border">
            <h3 className="text-sm font-medium text-foreground mb-2">Same-model failover</h3>
            <p className="text-sm text-muted-foreground">
              A different deployment of the same revision — a different provider or region running
              the identical weights. Permitted by default: you got what you asked for.
            </p>
          </div>
          <div className="p-4 rounded-lg border">
            <h3 className="text-sm font-medium text-foreground mb-2">Cross-model fallback</h3>
            <p className="text-sm text-muted-foreground">
              A different model or revision. Never silent and never the default — it requires an
              explicit routing-policy opt-in, and a permitted switch emits an event you can see.
            </p>
          </div>
        </div>
      </div>

      {/* Next Steps */}
      <div className="px-6 py-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Next Steps</h2>
        <div className="space-y-1">
          <Link
            to="/models"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Browse the catalogue</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
          <Link
            to="/documentation/chat-completions"
            className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded-lg transition-colors"
          >
            <span className="text-sm text-foreground">Chat Completions API</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} className="text-muted-foreground" />
          </Link>
        </div>
      </div>
    </div>
  );
}
