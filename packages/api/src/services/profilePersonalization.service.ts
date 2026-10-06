/** Product-specific cosmetic permission. Generic bundle premium is never authority. */
import {and,eq,gt,lte,inArray} from 'drizzle-orm';
import {getDb} from '../config/postgres';
import {billingSubscriptions,subscriptions,accountClosureFences} from '../db/schema';
import {loadProductBillingCatalogue} from './productBillingCatalogue.service';
import {readSubjectProductGrantSnapshot} from './productAccessPersistence.service';
export async function readProfilePersonalization(accountId:string, now=new Date()) {
  const denied={mentionMono:{allowed:false,expiresAt:null as string|null}};
  const [fence]=await getDb().select().from(accountClosureFences).where(eq(accountClosureFences.accountId,accountId));
  if(fence)return denied;
  const [billing]=await getDb().select({end:billingSubscriptions.currentPeriodEnd}).from(billingSubscriptions)
    .where(and(eq(billingSubscriptions.userId,accountId),inArray(billingSubscriptions.status,['active','trialing']),
      inArray(billingSubscriptions.planName,['pro','business']),lte(billingSubscriptions.currentPeriodStart,now),gt(billingSubscriptions.currentPeriodEnd,now)));
  const [legacy]=await getDb().select({end:subscriptions.endDate}).from(subscriptions)
    .where(and(eq(subscriptions.userId,accountId),eq(subscriptions.status,'active'),inArray(subscriptions.plan,['pro','business']),lte(subscriptions.startDate,now),gt(subscriptions.endDate,now)));
  const ends=[billing?.end,legacy?.end].filter((end):end is Date=>end instanceof Date).map(Number);
  try {
  const adapter=(await loadProductBillingCatalogue()).personalizationAdapter;
  if(adapter) {
    const snapshot=await readSubjectProductGrantSnapshot(accountId,adapter.productId,now);
    if(!snapshot.access.conflicts.some(c=>c.key===adapter.capabilityKey))
      for(const grant of snapshot.grants)if(grant.benefit.kind==='capability' && grant.benefit.key===adapter.capabilityKey
        && Date.parse(grant.period.start)<=+now && Date.parse(grant.period.end)>+now)ends.push(Date.parse(grant.period.end));
  }
  } catch { /* Missing central configuration grants nothing; independent sources remain valid. */ }
  return ends.length ? {mentionMono:{allowed:true,expiresAt:new Date(Math.max(...ends)).toISOString()}} : denied;
}
