import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { safeFetch } from '@oxy.so/core/server';

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];
type MetaNetwork = 'instagram.com' | 'threads.net';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const POLICY_VERSION = 'meta-profile-badges-2026-09-13-v1';
export type MetaProofRefusalReason = 'invalid_account' | 'upstream_unavailable' | 'oversized_document'
  | 'invalid_document' | 'missing_profile_owner' | 'ambiguous_profile_owner' | 'profile_mismatch'
  | 'missing_profile_badge' | 'ambiguous_profile_badge' | 'nonreciprocal_badges';
export interface MetaProfileObservation {
  sourceAcct: string;
  phase: 'transport' | 'response' | 'body' | 'owner' | 'badge';
  outcome: 'accepted' | 'refused';
  reason?: MetaProofRefusalReason | 'transport_error' | 'transport_timeout' | 'blocked_target'
    | 'http_status' | 'redirect' | 'unexpected_target' | 'unexpected_content_type' | 'body_timeout' | 'body_error';
  httpStatus?: number;
  documentHash?: string;
}
class ProofRefusal extends Error {
  constructor(readonly reason: MetaProofRefusalReason) { super(reason); }
}
interface ProfileBase {
  displayName: string;
  canonicalAcct: string;
  profileUrl: string;
  badgeTargetAcct: string;
  documentHash: string;
}
export interface VerifiedMetaFirstPartyPair {
  instagram: ProfileBase & { pk: string; graphId: string };
  threads: ProfileBase & { webPk: string };
  fetchedAt: string;
  evidenceHash: string;
  policyVersion: typeof POLICY_VERSION;
}
export interface ObservedInstagramProfile {
  canonicalAcct: string;
  profileUrl: string;
  displayName: string;
  pk: string;
  graphId: string;
  documentHash: string;
  fetchedAt: string;
  policyVersion: typeof POLICY_VERSION;
}
export type MetaFirstPartyProofResult = ({ status: 'verified'; pair: VerifiedMetaFirstPartyPair }
  | { status: 'refused'; sourceAcct: string; reason: MetaProofRefusalReason })
  & { instagramProfile?: ObservedInstagramProfile };

function account(value: string): { local: string; network: MetaNetwork; acct: string; url: string } {
  const match = /^([a-z0-9_][a-z0-9._]{0,63})@(instagram\.com|threads\.net|threads\.com)$/.exec(value);
  if (!match) throw new ProofRefusal('invalid_account');
  const local = match[1];
  const network = match[2] === 'instagram.com' ? 'instagram.com' : 'threads.net';
  return { local, network, acct: `${local}@${network}`, url: network === 'instagram.com'
    ? `https://www.instagram.com/${local}/` : `https://www.threads.com/@${local}` };
}
function profileAccount(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return;
    const host = url.hostname.replace(/^www\./, '');
    const pattern = host === 'instagram.com' ? /^\/([a-z0-9_][a-z0-9._]{0,63})\/?$/
      : ['threads.net', 'threads.com'].includes(host) ? /^\/@([a-z0-9_][a-z0-9._]{0,63})\/?$/ : null;
    const match = pattern?.exec(url.pathname);
    if (!match) return;
    // The observed platform Threads badge carries xmt tracking, not identity.
    if ([...url.searchParams.keys()].some(key => key !== 'xmt')) return;
    return `${match[1]}@${host === 'instagram.com' ? host : 'threads.net'}`;
  } catch { return; }
}
function element(node: Node): node is Element { return 'tagName' in node; }
function children(node: Node): Element[] { return 'childNodes' in node ? node.childNodes.filter(element) : []; }
function attr(node: Element, name: string) { return node.attrs.find(value => value.name === name)?.value; }
function descendants(node: Node): Element[] {
  const found: Element[] = [];
  const pending: Node[] = [node];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    if (element(current)) found.push(current);
    if (found.length > 100_000) throw new ProofRefusal('invalid_document');
    if ('childNodes' in current) pending.push(...current.childNodes);
  }
  return found;
}
function text(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(text).join('') : '';
}
function parent(node: Node): Element | undefined { return 'parentNode' in node && node.parentNode && element(node.parentNode) ? node.parentNode : undefined; }
function ancestors(node: Node): Element[] {
  const result: Element[] = [];
  let current = parent(node);
  while (current) { result.push(current); current = parent(current); }
  return result;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
interface Owner { username: string; fullName: string; pk: string; id: string }
function profileOwner(nodes: Element[], network: MetaNetwork): Owner {
  const prefix = network === 'instagram.com' ? 'adp_PolarisLoggedOutDesktopWWWProfileRootContentQueryRelayPreloader_'
    : 'adp_BarcelonaProfilePageDirectQueryRelayPreloader_';
  const owners: Owner[] = [];
  let visited = 0;
  for (const script of nodes.filter(node => node.tagName === 'script' && attr(node, 'type') === 'application/json' && attr(node, 'data-sjs') !== undefined)) {
    let document: unknown;
    try { document = JSON.parse(text(script)); } catch { continue; }
    const pending: unknown[] = [document];
    while (pending.length) {
      if (++visited > 100_000) throw new ProofRefusal('invalid_document');
      const current = pending.pop();
      if (Array.isArray(current)) {
        if (current[0] === 'RelayPrefetchedStreamCache' && current[1] === 'next' && Array.isArray(current[3])) {
          const [name, payload] = current[3] as unknown[];
          if (typeof name === 'string' && name.startsWith(prefix)) {
            const bbox = object(object(payload)?.__bbox);
            const data = object(object(bbox?.result)?.data);
            const user = object(data?.[network === 'instagram.com' ? 'xig_user_by_username' : 'user']);
            if (bbox?.complete !== true || !user) throw new ProofRefusal('missing_profile_owner');
            if (network === 'instagram.com' ? user.is_private !== false || user.is_unpublished !== false
              : user.has_onboarded_to_text_post_app !== true || user.text_post_app_is_private !== false) throw new ProofRefusal('missing_profile_owner');
            const { username, full_name: fullName, pk, id } = user;
            if (typeof username !== 'string' || typeof fullName !== 'string' || !fullName.trim() || fullName.length > 256 || typeof pk !== 'string' || typeof id !== 'string'
              || !/^[1-9][0-9]{0,29}$/.test(pk) || !/^[1-9][0-9]{0,29}$/.test(id)) throw new ProofRefusal('missing_profile_owner');
            if (network === 'threads.net' && pk !== id) throw new ProofRefusal('ambiguous_profile_owner');
            owners.push({ username, fullName, pk, id });
          }
        }
        pending.push(...current);
      } else if (object(current)) pending.push(...Object.values(current as Record<string, unknown>));
    }
  }
  const unique = [...new Map(owners.map(owner => [JSON.stringify(owner), owner])).values()];
  if (!unique.length) throw new ProofRefusal('missing_profile_owner');
  if (unique.length !== 1) throw new ProofRefusal('ambiguous_profile_owner');
  return unique[0];
}

/** Reviewed profile-control slots, not arbitrary branded links anywhere on a page. */
function ownedBadge(anchor: Element, network: MetaNetwork, owner: Owner): boolean {
  const chain = ancestors(anchor);
  if (chain.some(node => ['nav', 'article', 'aside'].includes(node.tagName) || attr(node, 'role') === 'navigation')) return false;
  if (network === 'instagram.com') {
    const section = chain.find(node => node.tagName === 'section');
    if (!section || !ancestors(section).some(node => node.tagName === 'header' && ancestors(node).some(ancestor => ancestor.tagName === 'main'))) return false;
    const content = children(section);
    if (content.length !== 1 || content[0].tagName !== 'div') return false;
    const slots = children(content[0]);
    // Observed owner name, dedicated Threads badge, biography, external links.
    return slots.length >= 3 && slots[0].tagName === 'div' && text(slots[0]).trim() === owner.fullName
      && slots[1].tagName === 'div' && descendants(slots[1]).includes(anchor)
      && descendants(slots[1]).filter(node => node.tagName === 'a').length === 1;
  }
  const region = chain.find(node => attr(node, 'role') === 'region' && attr(node, 'aria-label') === 'Column body');
  if (!region) return false;
  for (const panel of chain) {
    if (panel === region) break;
    const slots = children(panel);
    if (slots.length < 3) continue;
    const headings = descendants(slots[0]).filter(node => node.tagName === 'h1');
    if (headings.length !== 1 || text(headings[0]).trim() !== owner.fullName) continue;
    const footer = slots[slots.length - 1];
    const controls = children(footer);
    if (controls.length !== 2 || children(controls[1])[0] !== anchor) continue;
    // Profile tabs belong to the containing page, after the header controls.
    const page = parent(panel);
    if (!page || children(page)[0] !== panel) continue;
    const siblings = children(page).slice(1);
    const hasOwnerTabs = siblings.some(sibling => descendants(sibling).some(node => node.tagName === 'a'
      && attr(node, 'aria-label') === 'Replies' && attr(node, 'href') === `/@${owner.username}/replies`));
    if (hasOwnerTabs) return true;
  }
  return false;
}

function parseOwnedProfile(html: string, sourceAcct: string) {
  const source = account(sourceAcct);
  if (Buffer.byteLength(html) > MAX_BYTES) throw new ProofRefusal('oversized_document');
  const nodes = descendants(parse(html));
  const canonical = nodes.filter(node => node.tagName === 'link' && attr(node, 'rel') === 'canonical').map(node => profileAccount(attr(node, 'href') ?? ''));
  if (canonical.length !== 1 || canonical[0] !== source.acct) throw new ProofRefusal('profile_mismatch');
  const owner = profileOwner(nodes, source.network);
  if (owner.username !== source.local) throw new ProofRefusal('profile_mismatch');
  return { source, nodes, owner, documentHash: createHash('sha256').update(html).digest('hex') };
}

function parseProfileBadge(parsed: ReturnType<typeof parseOwnedProfile>) {
  const { source, nodes, owner, documentHash } = parsed;
  const label = source.network === 'instagram.com' ? 'Threads' : 'Instagram';
  const badges = nodes.filter(node => node.tagName === 'a' && attr(node, 'role') === 'link' && attr(node, 'target') === '_blank'
    && descendants(node).some(child => child.tagName === 'svg' && attr(child, 'aria-label') === label)
    && ownedBadge(node, source.network, owner));
  if (!badges.length) throw new ProofRefusal('missing_profile_badge');
  if (badges.length !== 1) throw new ProofRefusal('ambiguous_profile_badge');
  const badgeTargetAcct = profileAccount(attr(badges[0], 'href') ?? '');
  if (!badgeTargetAcct || account(badgeTargetAcct).network === source.network) throw new ProofRefusal('missing_profile_badge');
  return { canonicalAcct: source.acct, profileUrl: source.url, badgeTargetAcct, displayName: owner.fullName, pk: owner.pk, id: owner.id,
    documentHash };
}

export function parseMetaFirstPartyProfile(html: string, sourceAcct: string) {
  return parseProfileBadge(parseOwnedProfile(html, sourceAcct));
}

async function fetchProfile(sourceAcct: string, observe: (profile: ReturnType<typeof parseOwnedProfile>) => void, observations: MetaProfileObservation[]) {
  const source = account(sourceAcct);
  const observation: MetaProfileObservation = { sourceAcct: source.acct, phase: 'transport', outcome: 'refused', reason: 'transport_error' };
  observations.push(observation);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof safeFetch>> | undefined;
  let bodyTimedOut = false;
  try {
    response = await safeFetch(source.url, { method: 'GET', headers: { Accept: 'text/html', 'Accept-Language': 'en' },
      maxRedirects: 0, headersTimeoutMs: TIMEOUT_MS, signal });
    observation.phase = 'response';
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) observation.httpStatus = response.status;
    if (response.status !== 200) {
      observation.reason = response.status >= 300 && response.status < 400 ? 'redirect' : 'http_status';
      throw new ProofRefusal('upstream_unavailable');
    }
    if (response.finalUrl !== source.url) { observation.reason = 'unexpected_target'; throw new ProofRefusal('upstream_unavailable'); }
    if (!String(response.headers['content-type'] ?? '').toLowerCase().startsWith('text/html')) {
      observation.reason = 'unexpected_content_type'; throw new ProofRefusal('upstream_unavailable');
    }
    observation.phase = 'body';
    observation.reason = 'body_error';
    const chunks: Buffer[] = [];
    let bytes = 0;
    const body = response.response;
    const timer = setTimeout(() => { bodyTimedOut = true; body.destroy(new Error('Profile body deadline')); }, TIMEOUT_MS);
    try {
      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BYTES) throw new ProofRefusal('oversized_document');
        chunks.push(buffer);
      }
    } finally { clearTimeout(timer); }
    const document = Buffer.concat(chunks);
    observation.documentHash = createHash('sha256').update(document).digest('hex');
    observation.phase = 'owner';
    observation.reason = 'invalid_document';
    const parsed = parseOwnedProfile(document.toString('utf8'), source.acct);
    observe(parsed);
    observation.phase = 'badge';
    const profile = parseProfileBadge(parsed);
    observation.outcome = 'accepted';
    delete observation.reason;
    return profile;
  } catch (error) {
    if (error instanceof ProofRefusal && error.reason !== 'upstream_unavailable') observation.reason = error.reason;
    else if (bodyTimedOut || (observation.phase === 'body' && signal.aborted)) observation.reason = 'body_timeout';
    else if (observation.phase === 'transport') {
      if (signal.aborted) observation.reason = 'transport_timeout';
      else if (error instanceof Error && error.name === 'SsrfRejection') observation.reason = 'blocked_target';
      else if (error instanceof Error && error.name === 'UpstreamError' && ['too many redirects', 'redirect without location', 'redirect loop exhausted'].includes(error.message)) observation.reason = 'redirect';
    }
    throw error;
  } finally { response?.response.destroy(); }
}

/** Two fresh source-owned documents; AP/DID binding is deliberately not inferred here. */
async function resolveMetaFirstPartyProfilePair(input: { sourceAcct: string; expectedCounterpartAcct?: string }, observations: MetaProfileObservation[]): Promise<MetaFirstPartyProofResult> {
  const fetchedAt = new Date().toISOString();
  let instagramProfile: ObservedInstagramProfile | undefined;
  const observe = ({ source, owner, documentHash }: ReturnType<typeof parseOwnedProfile>) => {
    if (source.network !== 'instagram.com') return;
    instagramProfile = { canonicalAcct: source.acct, profileUrl: source.url, displayName: owner.fullName,
      pk: owner.pk, graphId: owner.id, documentHash, fetchedAt, policyVersion: POLICY_VERSION };
  };
  try {
    const source = account(input.sourceAcct);
    const first = await fetchProfile(source.acct, observe, observations);
    if (input.expectedCounterpartAcct && account(input.expectedCounterpartAcct).acct !== first.badgeTargetAcct) throw new ProofRefusal('nonreciprocal_badges');
    const second = await fetchProfile(first.badgeTargetAcct, observe, observations);
    if (second.badgeTargetAcct !== first.canonicalAcct) throw new ProofRefusal('nonreciprocal_badges');
    const ig = source.network === 'instagram.com' ? first : second;
    const th = source.network === 'threads.net' ? first : second;
    const { pk: igPk, id: graphId, ...instagram } = ig;
    const { pk: webPk, id: _webId, ...threads } = th;
    const evidence: Omit<VerifiedMetaFirstPartyPair, 'fetchedAt' | 'evidenceHash'> = { instagram: { ...instagram, pk: igPk, graphId }, threads: { ...threads, webPk }, policyVersion: POLICY_VERSION };
    return { status: 'verified', ...(instagramProfile ? { instagramProfile } : {}), pair: { ...evidence, fetchedAt, evidenceHash: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') } };
  } catch (error) {
    return { status: 'refused', ...(instagramProfile ? { instagramProfile } : {}), sourceAcct: input.sourceAcct, reason: error instanceof ProofRefusal ? error.reason : 'upstream_unavailable' };
  }
}

/** Existing live result contract is unchanged; diagnostics are internal and per call. */
export async function fetchMetaFirstPartyProfilePair(input: { sourceAcct: string; expectedCounterpartAcct?: string }): Promise<MetaFirstPartyProofResult> {
  return resolveMetaFirstPartyProfilePair(input, []);
}

/** Same reads and parser as live resolution, without any registry or DB access. */
export async function inspectMetaFirstPartyProfilePair(sourceAcct: string) {
  const observations: MetaProfileObservation[] = [];
  const result = await resolveMetaFirstPartyProfilePair({ sourceAcct }, observations);
  const identity = (profile: ProfileBase) => ({ canonicalAcct: profile.canonicalAcct, profileUrl: profile.profileUrl,
    badgeTargetAcct: profile.badgeTargetAcct, documentHash: profile.documentHash });
  return { status: result.status, policyVersion: POLICY_VERSION, observations,
    ...(result.status === 'refused' ? { reason: result.reason } : { evidenceHash: result.pair.evidenceHash,
      pair: { instagram: { ...identity(result.pair.instagram), pk: result.pair.instagram.pk, graphId: result.pair.instagram.graphId },
        threads: { ...identity(result.pair.threads), webPk: result.pair.threads.webPk } } }) };
}
