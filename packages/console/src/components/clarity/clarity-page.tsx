import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { Job, SearchMode } from '@clarity.surf/sdk';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useClarityClient } from '@/hooks/use-clarity';
import config from '@/lib/config';

export type ClaritySection = 'overview' | 'search' | 'news' | 'indexing' | 'sites' | 'jobs' | 'usage';

const sections: Array<{ id: ClaritySection; label: string }> = [
  { id: 'overview', label: 'Overview' }, { id: 'search', label: 'Search' },
  { id: 'news', label: 'News' }, { id: 'indexing', label: 'Index URLs' },
  { id: 'sites', label: 'Sites' }, { id: 'jobs', label: 'Jobs' },
  { id: 'usage', label: 'Usage & quotas' },
];

function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert variant="destructive"><AlertTitle>Clarity request failed</AlertTitle><AlertDescription>{error instanceof Error ? error.message : 'Unexpected error'}</AlertDescription></Alert>;
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

export function ClarityPage({ section }: { section: ClaritySection }) {
  return <div className="flex-1 bg-background"><header className="border-b px-6 py-6"><div className="flex items-center gap-3"><h1 className="text-2xl font-semibold">Clarity Search</h1><Badge variant="secondary">Beta</Badge></div><p className="mt-1 text-sm text-muted-foreground">Public web search, indexing and news for your active Oxy account.</p><nav className="mt-5 flex flex-wrap gap-2" aria-label="Clarity sections">{sections.map((item) => <Button key={item.id} variant={section === item.id ? 'default' : 'outline'} size="sm" asChild><Link to={item.id === 'overview' ? '/clarity' : `/clarity/${item.id}`}>{item.label}</Link></Button>)}</nav></header><main className="mx-auto w-full max-w-6xl space-y-5 p-6">{section === 'overview' && <Overview />}{section === 'search' && <Search />}{section === 'news' && <News />}{section === 'indexing' && <Indexing />}{section === 'sites' && <Sites />}{section === 'jobs' && <Jobs />}{section === 'usage' && <Usage />}</main></div>;
}

function Overview() {
  const catalogue = useQuery({ queryKey: ['oxy-product-catalogue'], queryFn: async () => { const response = await fetch(`${config.oxyUrl}/v1/products`); if (!response.ok) throw new Error(`Oxy catalogue returned ${response.status}`); return response.json() as Promise<{ products: Array<{ id: string; name: string; status: string; scopes: Array<string>; endpoints: Array<string> }> }>; }, staleTime: 300_000 });
  const product = catalogue.data?.products.find((item) => item.id === 'clarity-search');
  return <><ErrorNotice error={catalogue.error} /><div className="grid gap-4 md:grid-cols-2"><Card><CardHeader><CardTitle>{product?.name ?? 'Clarity Search, Indexing & News'}</CardTitle><CardDescription>Product availability and contracts come from Oxy's control plane.</CardDescription></CardHeader><CardContent className="space-y-3">{catalogue.isLoading ? <p className="text-sm text-muted-foreground">Loading product catalogue…</p> : product ? <><Badge>{product.status}</Badge><div className="flex flex-wrap gap-2">{product.scopes.map((scope) => <Badge key={scope} variant="outline">{scope}</Badge>)}</div></> : <p className="text-sm text-muted-foreground">Clarity is not enabled in the current Oxy catalogue.</p>}</CardContent></Card><Card><CardHeader><CardTitle>API resources</CardTitle><CardDescription>Data is stored and served by Clarity; credentials and account access remain in Oxy.</CardDescription></CardHeader><CardContent className="grid grid-cols-2 gap-2 text-sm">{sections.slice(1).map((item) => <Link key={item.id} className="rounded-md border p-3 hover:bg-muted" to={`/clarity/${item.id}`}>{item.label}</Link>)}</CardContent></Card></div></>;
}

function Search() {
  const client = useClarityClient(); const [query, setQuery] = useState(''); const [mode, setMode] = useState<SearchMode>('hybrid');
  const search = useMutation({ mutationFn: () => client.search({ query, mode, limit: 20 }) });
  return <><Card><CardHeader><CardTitle>Search playground</CardTitle><CardDescription>Run a live query against Clarity's public index.</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-3 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (query.trim()) search.mutate(); }}><Input aria-label="Search query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the public web" /><select className="h-9 rounded-md border bg-background px-3 text-sm" value={mode} onChange={(e) => setMode(e.target.value as SearchMode)}><option value="hybrid">Hybrid</option><option value="lexical">Lexical</option><option value="semantic">Semantic</option></select><Button type="submit" disabled={search.isPending || !query.trim()}>Search</Button></form></CardContent></Card><ErrorNotice error={search.error} />{search.data?.degraded && <Alert><AlertTitle>Lexical fallback</AlertTitle><AlertDescription>{search.data.degraded.reason}</AlertDescription></Alert>}<div className="space-y-3">{search.data?.data.map((result) => <Card key={result.id}><CardHeader><CardTitle className="text-base"><a href={result.canonicalUrl} target="_blank" rel="noreferrer">{result.title ?? result.canonicalUrl}</a></CardTitle><CardDescription>{result.publisher ?? new URL(result.canonicalUrl).hostname} · {result.type}</CardDescription></CardHeader><CardContent className="text-sm">{result.snippet ?? result.description ?? 'No snippet available.'}</CardContent></Card>)}</div></>;
}

function News() {
  const client = useClarityClient(); const news = useQuery({ queryKey: ['clarity-news'], queryFn: () => client.news({ limit: 30 }) });
  return <><ErrorNotice error={news.error} /><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Latest stories</h2><Button variant="outline" onClick={() => void news.refetch()}>Refresh</Button></div>{news.isLoading && <p className="text-sm text-muted-foreground">Loading news…</p>}<div className="grid gap-4 md:grid-cols-2">{news.data?.data.map((story) => <Card key={story.id}><CardHeader><CardTitle>{story.title}</CardTitle><CardDescription>{story.sourceCount} sources · {new Date(story.lastPublishedAt).toLocaleString()}</CardDescription></CardHeader><CardContent><p className="text-sm">{story.summary ?? 'No summary available.'}</p><div className="mt-3 space-y-1">{story.articles.slice(0, 3).map((article) => <a className="block truncate text-sm underline" key={article.id} href={article.canonicalUrl} target="_blank" rel="noreferrer">{article.publisher ?? article.title ?? article.canonicalUrl}</a>)}</div></CardContent></Card>)}</div></>;
}

function Indexing() {
  const client = useClarityClient(); const [value, setValue] = useState('');
  const submit = useMutation({ mutationFn: () => client.indexing.urls({ urls: value.split(/\s+/).filter(Boolean).slice(0, 50) }, { idempotencyKey: idempotencyKey() }) });
  return <Card><CardHeader><CardTitle>Submit URLs</CardTitle><CardDescription>Queue up to 50 public URLs. Duplicate submissions are protected by an idempotency key.</CardDescription></CardHeader><CardContent className="space-y-3"><Textarea rows={8} value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://example.com/page&#10;https://example.com/another" /><Button disabled={submit.isPending || !value.trim()} onClick={() => submit.mutate()}>Queue indexing</Button><ErrorNotice error={submit.error} />{submit.data && <JobSummary job={submit.data} />}</CardContent></Card>;
}

function Sites() {
  const client = useClarityClient(); const queryClient = useQueryClient(); const sites = useQuery({ queryKey: ['clarity-sites'], queryFn: () => client.sites.list() }); const [origin, setOrigin] = useState(''); const [domainId, setDomainId] = useState('');
  const create = useMutation({ mutationFn: () => client.sites.create({ origin, verifiedDomainId: domainId }, { idempotencyKey: idempotencyKey() }), onSuccess: () => { setOrigin(''); setDomainId(''); void queryClient.invalidateQueries({ queryKey: ['clarity-sites'] }); } });
  const crawl = useMutation({ mutationFn: (id: string) => client.sites.crawl(id, { idempotencyKey: idempotencyKey() }) });
  return <><Card><CardHeader><CardTitle>Register a verified site</CardTitle><CardDescription>The domain ID must refer to a domain already verified in Oxy.</CardDescription></CardHeader><CardContent><form className="grid gap-3 md:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}><Input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://example.com" aria-label="Site origin" /><Input value={domainId} onChange={(e) => setDomainId(e.target.value)} placeholder="Oxy verified domain ID" aria-label="Verified domain ID" /><Button disabled={!origin || !domainId || create.isPending}>Register</Button></form><div className="mt-3"><ErrorNotice error={create.error} /></div></CardContent></Card><ErrorNotice error={sites.error ?? crawl.error} /><div className="space-y-3">{sites.data?.data.map((site) => <Card key={site.id}><CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6"><div><p className="font-medium">{site.origin}</p><p className="text-sm text-muted-foreground">{site.status} · next crawl {site.nextCrawlAt ? new Date(site.nextCrawlAt).toLocaleString() : 'not scheduled'}</p></div><Button variant="outline" disabled={crawl.isPending} onClick={() => crawl.mutate(site.id)}>Start crawl</Button></CardContent></Card>)}</div>{crawl.data && <JobSummary job={crawl.data} />}</>;
}

function Jobs() {
  const client = useClarityClient(); const [id, setId] = useState(''); const [requestedId, setRequestedId] = useState('');
  const job = useQuery({ queryKey: ['clarity-job', requestedId], queryFn: () => client.jobs.get(requestedId), enabled: Boolean(requestedId), refetchInterval: (query) => ['queued', 'running'].includes(query.state.data?.status ?? '') ? 2000 : false });
  const cancel = useMutation({ mutationFn: () => client.jobs.cancel(requestedId, { idempotencyKey: idempotencyKey() }), onSuccess: () => void job.refetch() });
  return <Card><CardHeader><CardTitle>Job inspector</CardTitle><CardDescription>Inspect live progress or cancel queued and running work.</CardDescription></CardHeader><CardContent className="space-y-4"><form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setRequestedId(id.trim()); }}><Input value={id} onChange={(e) => setId(e.target.value)} placeholder="Job ID" /><Button disabled={!id.trim()}>Inspect</Button></form><ErrorNotice error={job.error ?? cancel.error} />{job.data && <><JobSummary job={job.data} />{['queued', 'running'].includes(job.data.status) && <Button variant="destructive" onClick={() => cancel.mutate()}>Cancel job</Button>}</>}</CardContent></Card>;
}

function JobSummary({ job }: { job: Job }) { return <div className="rounded-md border p-4 text-sm"><div className="flex items-center justify-between"><strong>{job.kind} job</strong><Badge variant="outline">{job.status}</Badge></div><p className="mt-2 text-muted-foreground">{job.pagesCompleted} of {job.pagesDiscovered} pages completed</p><p className="mt-1 break-all text-xs text-muted-foreground">{job.id}</p></div>; }

function Usage() {
  const client = useClarityClient(); const usage = useQuery({ queryKey: ['clarity-usage'], queryFn: () => client.usage.get() }); const quotas = useQuery({ queryKey: ['clarity-quotas'], queryFn: () => client.usage.quotas() });
  return <><ErrorNotice error={usage.error ?? quotas.error} /><div className="grid gap-4 md:grid-cols-2"><Card><CardHeader><CardTitle>Sandbox quotas</CardTitle><CardDescription>Limits attached to the active Oxy account.</CardDescription></CardHeader><CardContent className="space-y-2 text-sm">{quotas.isLoading ? 'Loading…' : quotas.data && Object.entries(quotas.data).map(([key, value]) => <div key={key} className="flex justify-between border-b py-2"><span>{key}</span><strong>{value.toLocaleString()}</strong></div>)}</CardContent></Card><Card><CardHeader><CardTitle>Measured usage</CardTitle><CardDescription>Clarity's account usage ledger.</CardDescription></CardHeader><CardContent className="space-y-2 text-sm">{usage.isLoading ? 'Loading…' : usage.data?.data.length ? usage.data.data.map((row) => <div key={`${row.operation}-${row.periodStart}`} className="flex justify-between border-b py-2"><span>{row.operation}</span><strong>{row.quantity.toLocaleString()}</strong></div>) : <p className="text-muted-foreground">No usage has been recorded.</p>}</CardContent></Card></div></>;
}
