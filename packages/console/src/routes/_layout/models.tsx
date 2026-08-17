import { Link, createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, CheckmarkCircle01Icon } from '@hugeicons/core-free-icons';
import type {
  InferenceModality,
  ModelCatalogueEntry,
  RoutingProfile,
} from '@oxyhq/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InferenceAvailabilityNotice } from '@/components/inference-availability-notice';
import { useModelCatalogue, useRoutingProfiles } from '@/hooks/use-models';
import {
  EMPTY_CATALOGUE_FILTERS,
  PRICE_CAP_PER,
  catalogueFacets,
  filterCatalogue,
  isEmptyFilterSet,
} from '@/lib/model-catalogue-filters';
import { formatMoney } from '@/lib/money';

export const Route = createFileRoute('/_layout/models')({
  component: ModelsPage,
});

/**
 * The Models page, rendered from the real catalogue (issue #972, workstream 5).
 *
 * Two tabs, because a routing profile is not a model and putting them in one
 * list is the conflation ADR 0008 exists to remove. A model is a named line from
 * a publisher, resolvable as `<publisher>/<model>`; a profile is a POLICY object
 * with its own identifier space that selects among deployments.
 *
 * Nothing here is fabricated. The catalogue is empty until workstream 5 seeds
 * it, and an empty catalogue renders as an empty state that says so — not a
 * spinner, not a placeholder row, and not the four retired `alia-*` tiers.
 */
function ModelsPage() {
  return (
    <ScrollArea className="flex-1 bg-background">
      <div className="px-6 py-6 border-b border-border">
        <h1 className="text-2xl font-semibold text-foreground">Models</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The models Oxy can serve, and the routing profiles that choose between them
        </p>
      </div>

      <div className="px-6 py-6">
        <Tabs defaultValue="models" className="gap-6">
          <TabsList variant="line">
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="profiles">Routing profiles</TabsTrigger>
          </TabsList>

          <TabsContent value="models">
            <CatalogueTab />
          </TabsContent>

          <TabsContent value="profiles">
            <RoutingProfilesTab />
          </TabsContent>
        </Tabs>
      </div>
    </ScrollArea>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-6 py-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-3">
          <Skeleton.Box width={192} height={20} />
          <Skeleton.Box width={256} height={16} />
          <div className="flex gap-8">
            {[1, 2, 3].map((j) => (
              <Skeleton.Box key={j} width={72} height={28} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function LoadFailed({ what }: { what: string }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium text-foreground mb-1">Could not load {what}</p>
      <p className="text-sm text-muted-foreground">
        The catalogue is served by the Oxy API. Reload the page to try again.
      </p>
    </div>
  );
}

function CatalogueTab() {
  const { data: entries, isLoading, isError } = useModelCatalogue();
  const [filters, setFilters] = useState(EMPTY_CATALOGUE_FILTERS);

  const catalogue = useMemo(() => entries ?? [], [entries]);
  const facets = useMemo(() => catalogueFacets(catalogue), [catalogue]);
  const visible = useMemo(() => filterCatalogue(catalogue, filters), [catalogue, filters]);

  if (isLoading) {
    return <LoadingRows />;
  }

  if (isError) {
    return <LoadFailed what="the model catalogue" />;
  }

  if (catalogue.length === 0) {
    return (
      <div className="py-12">
        <div className="max-w-lg mx-auto text-center">
          <p className="text-sm font-medium text-foreground mb-1">No models published yet</p>
          <p className="text-sm text-muted-foreground">
            A model is listed here once it has a current revision and a route you are allowed to
            use, and it carries that route's publisher, licence, regions and data policy with it.
            Nothing is listed on a name alone, so this page never names a model whose provenance
            it cannot answer for.
          </p>
          {/*
            The question an empty catalogue actually raises is "so can I call
            anything?", and the answer already exists as one component. Reused
            rather than re-worded, so the two pages cannot drift.
          */}
          <InferenceAvailabilityNotice className="mt-6 text-left" />
          <Link
            to="/documentation/models"
            className="inline-block mt-6 text-sm text-primary hover:underline"
          >
            How the catalogue is structured
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <CatalogueFilterBar
        facets={facets}
        filters={filters}
        onChange={setFilters}
        total={catalogue.length}
        shown={visible.length}
      />

      {visible.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm font-medium text-foreground mb-1">No models match these filters</p>
          <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_CATALOGUE_FILTERS)}>
            Clear filters
          </Button>
        </div>
      ) : (
        <div>
          {visible.map((entry, index) => (
            <CatalogueEntryRow
              key={entry.modelId}
              entry={entry}
              isLast={index === visible.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The filter bar, with options derived from the loaded catalogue.
 *
 * Every control here is shown only when the loaded catalogue could actually be
 * narrowed by it — a select needs more than one value to choose between, and the
 * price cap needs at least one published input-token price. So the bar never
 * offers a filter whose every setting returns the same list, which is the state
 * a price filter would have been in before the API published prices at all.
 */
function CatalogueFilterBar({
  facets,
  filters,
  onChange,
  total,
  shown,
}: {
  facets: ReturnType<typeof catalogueFacets>;
  filters: typeof EMPTY_CATALOGUE_FILTERS;
  onChange: (next: typeof EMPTY_CATALOGUE_FILTERS) => void;
  total: number;
  shown: number;
}) {
  const ANY = '__any__';

  return (
    <div className="mb-6 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="model-search" className="text-xs text-muted-foreground">
            Search
          </Label>
          <Input
            id="model-search"
            value={filters.query}
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
            placeholder="Model or publisher"
          />
        </div>

        {facets.inputModalities.length > 1 && (
          <div className="w-44 space-y-1.5">
            <Label htmlFor="model-modality" className="text-xs text-muted-foreground">
              Input modality
            </Label>
            <Select
              value={filters.inputModality ?? ANY}
              onValueChange={(value) =>
                onChange({
                  ...filters,
                  inputModality: value === ANY ? null : (value as InferenceModality),
                })
              }
            >
              <SelectTrigger id="model-modality">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any modality</SelectItem>
                {facets.inputModalities.map((modality) => (
                  <SelectItem key={modality} value={modality}>
                    {modality}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {facets.outputModalities.length > 1 && (
          <div className="w-44 space-y-1.5">
            <Label htmlFor="model-output-modality" className="text-xs text-muted-foreground">
              Output modality
            </Label>
            <Select
              value={filters.outputModality ?? ANY}
              onValueChange={(value) =>
                onChange({
                  ...filters,
                  outputModality: value === ANY ? null : (value as InferenceModality),
                })
              }
            >
              <SelectTrigger id="model-output-modality">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any modality</SelectItem>
                {facets.outputModalities.map((modality) => (
                  <SelectItem key={modality} value={modality}>
                    {modality}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {facets.regions.length > 1 && (
          <div className="w-44 space-y-1.5">
            <Label htmlFor="model-region" className="text-xs text-muted-foreground">
              Region
            </Label>
            <Select
              value={filters.region ?? ANY}
              onValueChange={(value) =>
                onChange({ ...filters, region: value === ANY ? null : value })
              }
            >
              <SelectTrigger id="model-region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any region</SelectItem>
                {facets.regions.map((region) => (
                  <SelectItem key={region} value={region}>
                    {region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {facets.providers.length > 1 && (
          <div className="w-52 space-y-1.5">
            <Label htmlFor="model-provider" className="text-xs text-muted-foreground">
              Provider
            </Label>
            <Select
              value={filters.provider ?? ANY}
              onValueChange={(value) =>
                onChange({ ...filters, provider: value === ANY ? null : value })
              }
            >
              <SelectTrigger id="model-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any provider</SelectItem>
                {facets.providers.map((provider) => (
                  <SelectItem key={provider.slug} value={provider.slug}>
                    {provider.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/*
          A text input, not `type="number"`: the value is an exact decimal
          compared against the ledger's own exact decimals, and a number input
          hands back a value that has been through a float. `inputMode` still
          gets the numeric keypad on a phone without that cost.
        */}
        {facets.hasInputTokenPricing && (
          <div className="w-52 space-y-1.5">
            <Label htmlFor="model-max-price" className="text-xs text-muted-foreground">
              Max price / {PRICE_CAP_PER.toLocaleString()} input tokens
            </Label>
            <Input
              id="model-max-price"
              inputMode="decimal"
              value={filters.maxPricePerMillionInputTokens ?? ''}
              onChange={(e) =>
                onChange({
                  ...filters,
                  maxPricePerMillionInputTokens: e.target.value === '' ? null : e.target.value,
                })
              }
              placeholder="3.00"
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <Switch
            id="model-tools"
            checked={filters.toolsOnly}
            onCheckedChange={(checked) => onChange({ ...filters, toolsOnly: checked === true })}
          />
          <Label htmlFor="model-tools" className="text-sm font-normal">
            Supports tools
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="model-zdr"
            checked={filters.zeroRetentionOnly}
            onCheckedChange={(checked) =>
              onChange({ ...filters, zeroRetentionOnly: checked === true })
            }
          />
          <Label htmlFor="model-zdr" className="text-sm font-normal">
            Zero data retention available
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="model-no-training"
            checked={filters.noTrainingOnly}
            onCheckedChange={(checked) =>
              onChange({ ...filters, noTrainingOnly: checked === true })
            }
          />
          <Label htmlFor="model-no-training" className="text-sm font-normal">
            No training on customer data
          </Label>
        </div>

        <p className="text-xs text-muted-foreground ml-auto">
          {isEmptyFilterSet(filters)
            ? `${total} model${total === 1 ? '' : 's'}`
            : `${shown} of ${total}`}
        </p>
      </div>
    </div>
  );
}

function Capability({ label, supported }: { label: string; supported: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-sm">
      <HugeiconsIcon
        icon={supported ? CheckmarkCircle01Icon : Cancel01Icon}
        size={14}
        className={supported ? 'text-green-500' : 'text-muted-foreground'}
      />
      <span className={supported ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className="text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

/**
 * One catalogue entry.
 *
 * Everything rendered here is a field the API serves. There is no wholesale
 * cost, no internal route id and no provider secret in `ModelCatalogueEntry` to
 * render — the customer-safe projection is built from an allow-list of columns
 * server-side, so this component has nothing unsafe available to it.
 */
function CatalogueEntryRow({ entry, isLast }: { entry: ModelCatalogueEntry; isLast: boolean }) {
  const { capabilities, dataPolicy, deprecation, license, provenance, pricing } = entry;

  return (
    <div className={`py-6 ${isLast ? '' : 'border-b border-border'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground">{entry.displayName}</p>
            {deprecation.status !== 'active' && (
              <Badge variant="secondary" className="text-xs">
                {deprecation.status}
              </Badge>
            )}
          </div>
          <p className="text-xs font-mono text-muted-foreground mt-0.5">{entry.modelId}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Published by {entry.publisher.displayName}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Current revision</p>
          <p className="text-xs font-mono text-foreground">
            {entry.modelId}@{entry.currentRevision}
          </p>
          {entry.availableRevisions.length > 1 && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {entry.availableRevisions.length} revisions pinnable
            </p>
          )}
        </div>
      </div>

      {entry.description !== undefined && (
        <p className="text-sm text-muted-foreground mb-4">{entry.description}</p>
      )}

      <div className="flex flex-wrap gap-8 mb-4">
        <Fact label="Context" value={`${capabilities.maxContextTokens.toLocaleString()} tokens`} />
        <Fact
          label="Max output"
          value={`${capabilities.maxOutputTokens.toLocaleString()} tokens`}
        />
        <Fact label="Input" value={capabilities.inputModalities.join(', ')} />
        <Fact label="Output" value={capabilities.outputModalities.join(', ')} />
        {/*
          The UNION of every serving route's regions — the same field the region
          filter matches on. Without it a customer can narrow by a region the row
          never shows, and the per-provider badges below only say which regions
          THAT provider covers.
        */}
        {entry.regions.length > 0 && <Fact label="Regions" value={entry.regions.join(', ')} />}
        <Fact label="Licence" value={license.displayName} />
        <Fact label="Release" value={provenance.releaseKind.replace(/_/g, ' ')} />
        {entry.knowledgeCutoff !== undefined && (
          <Fact label="Knowledge cutoff" value={entry.knowledgeCutoff} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-4">
        <Capability label="Tools" supported={capabilities.tools} />
        <Capability label="Vision" supported={capabilities.inputModalities.includes('image')} />
        <Capability label="Reasoning" supported={capabilities.reasoning} />
        <Capability label="Structured output" supported={capabilities.structuredOutput} />
        <Capability label="Streaming" supported={capabilities.streaming} />
        <Capability label="Prompt caching" supported={capabilities.promptCaching} />
      </div>

      {entry.servingProviders.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-muted-foreground mb-2">Served by</p>
          <div className="flex flex-wrap gap-1.5">
            {entry.servingProviders.map((provider) => (
              <Badge key={provider.slug} variant="outline" className="text-xs">
                {provider.displayName}
                {provider.regions.length > 0 && ` · ${provider.regions.join(', ')}`}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="mb-2">
        <p className="text-xs text-muted-foreground mb-2">Data policy</p>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-xs">
            {dataPolicy.retainsPayloads
              ? `Retains payloads for ${dataPolicy.retentionDays} days`
              : 'Retains no payloads'}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {dataPolicy.trainsOnCustomerData
              ? 'Trains on customer data'
              : 'No training on customer data'}
          </Badge>
          {dataPolicy.zeroDataRetentionAvailable && (
            <Badge variant="outline" className="text-xs">
              Zero data retention available
            </Badge>
          )}
          {dataPolicy.subprocessors.map((subprocessor) => (
            <Badge key={subprocessor} variant="outline" className="text-xs">
              Subprocessor: {subprocessor}
            </Badge>
          ))}
        </div>
      </div>

      {/*
        The published price for the PRIMARY route — the same route whose data
        policy and terms this row reports. `formatMoney` groups the digits as
        text; the amount never passes through a `Number`, so a per-token price of
        `0.000003000000` renders as `0.000003` rather than as a `0.00` that reads
        like nothing is charged.

        The price VERSION id is shown because it is the record a later invoice can
        be re-priced against — a customer disputing a charge quotes it.
      */}
      {pricing !== undefined && (
        <div className="mt-4">
          <p className="text-xs text-muted-foreground mb-2">
            Price · version <code className="font-mono">{pricing.priceVersionId}</code>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {pricing.unitPrices.map((unitPrice) => (
              <Badge key={unitPrice.unit} variant="outline" className="text-xs">
                {formatMoney(unitPrice.amount, unitPrice.currency)} per{' '}
                {unitPrice.per.toLocaleString()} {unitPrice.unit.replace(/_/g, ' ')}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {deprecation.status !== 'active' && deprecation.replacementModelReference !== undefined && (
        <p className="text-xs text-muted-foreground mt-4">
          Replaced by{' '}
          <code className="font-mono">{deprecation.replacementModelReference}</code>
          {deprecation.sunsetAt !== undefined &&
            ` · sunsets ${new Date(deprecation.sunsetAt).toLocaleDateString()}`}
        </p>
      )}

      {entry.modelCardUrl !== undefined && (
        <a
          href={entry.modelCardUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block mt-4 text-sm text-primary hover:underline"
        >
          Model card
        </a>
      )}
    </div>
  );
}

function RoutingProfilesTab() {
  const { data: profiles, isLoading, isError } = useRoutingProfiles();

  if (isLoading) {
    return <LoadingRows />;
  }

  if (isError) {
    return <LoadFailed what="routing profiles" />;
  }

  const list = profiles ?? [];

  if (list.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm font-medium text-foreground mb-1">No routing profiles published</p>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          A routing profile is a policy that picks among deployments of the models in the
          catalogue — it is never a model itself, and it cannot exist before the models it would
          choose between.
        </p>
      </div>
    );
  }

  return (
    <div>
      {list.map((profile, index) => (
        <RoutingProfileRow
          key={profile.routingProfileId}
          profile={profile}
          isLast={index === list.length - 1}
        />
      ))}
    </div>
  );
}

function RoutingProfileRow({ profile, isLast }: { profile: RoutingProfile; isLast: boolean }) {
  return (
    <div className={`py-6 ${isLast ? '' : 'border-b border-border'}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground">{profile.displayName}</p>
            {profile.isProductPreset && (
              <Badge variant="secondary" className="text-xs">
                Product preset
              </Badge>
            )}
          </div>
          <p className="text-xs font-mono text-muted-foreground mt-0.5">{profile.slug}</p>
        </div>
        <Badge variant="outline" className="text-xs">
          Optimises for {profile.optimiseFor}
        </Badge>
      </div>

      {profile.description !== undefined && (
        <p className="text-sm text-muted-foreground mb-4">{profile.description}</p>
      )}

      <p className="text-xs text-muted-foreground mb-2">
        Candidates, in priority order — the response always reports which one actually ran
      </p>
      <div className="flex flex-wrap gap-1.5">
        {[...profile.candidates]
          .sort((left, right) => left.priority - right.priority)
          .map((candidate) => (
            <Badge key={candidate.modelReference} variant="outline" className="text-xs font-mono">
              {candidate.modelReference}
            </Badge>
          ))}
      </div>
    </div>
  );
}
