/** Oxy One commercial catalogue. Source: website /one, approved by Nate 2026-10-17.
 * Display terms do not grant access: fulfillment requires verified provider evidence. */
export type PersonalPlanMode = 'individual' | 'family';
export type OneAudience = 'personal' | 'creator' | 'business';
export interface OnePlan {
  name: string;
  monthlyPrice: number;
  monthlyCredits: number;
  creditDiscount: number;
  /** Proposed shared storage in GB; does not provision a backend quota. */
  storageGB: number;
  storagePerSeatGB?: number;
  monthlySeatPrice?: number;
  creditsPerSeat?: number;
}

export const OXY_ONE_ANNUAL_DISCOUNT = 20;
export const OXY_ONE_FAMILY_MEMBERS = 6;
export const OXY_ONE_AUDIENCE_THEMES = {
  personal: 'one-plans-theme',
  creator: 'one-creator-theme',
  business: 'one-professional-theme',
} as const;

/** Approved prices and credits; proposed storage capacities for the bundle design.
 * USD minor units; credits renew monthly even on annual plans. Free 2 GB and Go 20 GB follow
 * the new product direction; existing backend quotas are not changed here. */
export const OXY_ONE_PERSONAL_PLANS = {
  Free: { monthlyPrice: 0, monthlyCredits: 0, creditDiscount: 0, storageGB: 2 },
  Go: { monthlyPrice: 1500, monthlyCredits: 4000, creditDiscount: 5, storageGB: 20 },
  Pro: { monthlyPrice: 2999, monthlyCredits: 10000, creditDiscount: 10, storageGB: 100 },
  Max: { monthlyPrice: 9900, monthlyCredits: 50000, creditDiscount: 15, storageGB: 500 },
  Ultra: { monthlyPrice: 40000, monthlyCredits: 200000, creditDiscount: 20, storageGB: 2000 },
} as const;

/** A family quota belongs to the whole group, never multiplied by member count. */
export const OXY_ONE_FAMILY_PLANS = {
  Go: { monthlyPrice: 2500, monthlyCredits: 8000, creditDiscount: 5, storageGB: 40 },
  Pro: { monthlyPrice: 4900, monthlyCredits: 20000, creditDiscount: 10, storageGB: 200 },
  Max: { monthlyPrice: 16900, monthlyCredits: 100000, creditDiscount: 15, storageGB: 1000 },
  Ultra: { monthlyPrice: 59900, monthlyCredits: 300000, creditDiscount: 20, storageGB: 4000 },
} as const;

export const OXY_ONE_BUSINESS_PLANS = {
  Go: {
    monthlyPrice: 3900,
    monthlySeatPrice: 900,
    monthlyCredits: 8000,
    creditsPerSeat: 2000,
    creditDiscount: 15,
    storageGB: 20,
    storagePerSeatGB: 5,
  },
  Pro: {
    monthlyPrice: 9999,
    monthlySeatPrice: 1900,
    monthlyCredits: 25000,
    creditsPerSeat: 5000,
    creditDiscount: 25,
    storageGB: 100,
    storagePerSeatGB: 10,
  },
  Max: {
    monthlyPrice: 19900,
    monthlySeatPrice: 2900,
    monthlyCredits: 60000,
    creditsPerSeat: 8000,
    creditDiscount: 30,
    storageGB: 500,
    storagePerSeatGB: 25,
  },
  Ultra: {
    monthlyPrice: 59900,
    monthlySeatPrice: 4900,
    monthlyCredits: 200000,
    creditsPerSeat: 15000,
    creditDiscount: 35,
    storageGB: 2000,
    storagePerSeatGB: 50,
  },
} as const;

/** Verification, basic app access and model access are not subscription gates. */
export const OXY_ONE_CREATOR_PLANS = {
  Go: { monthlyPrice: 2900, monthlyCredits: 10000, creditDiscount: 10, storageGB: 20 },
  Pro: { monthlyPrice: 6900, monthlyCredits: 25000, creditDiscount: 15, storageGB: 100 },
  Max: { monthlyPrice: 14900, monthlyCredits: 60000, creditDiscount: 20, storageGB: 500 },
  Ultra: { monthlyPrice: 49900, monthlyCredits: 250000, creditDiscount: 25, storageGB: 2000 },
} as const;

export function getOnePlans(
  audience: OneAudience,
  mode: PersonalPlanMode = 'individual',
): OnePlan[] {
  const plans =
    audience === 'business'
      ? OXY_ONE_BUSINESS_PLANS
      : audience === 'creator'
        ? OXY_ONE_CREATOR_PLANS
        : mode === 'family'
          ? OXY_ONE_FAMILY_PLANS
          : OXY_ONE_PERSONAL_PLANS;
  return Object.entries(plans).map(([name, plan]) => ({ name, ...plan }));
}

/** Each product owns its tier names; an Oxy One level selects an app subscription.
 * Bundle inclusion is a proposal and does not activate product entitlements. */
export const OXY_ONE_APP_SUBSCRIPTIONS = {
  alia: { name: 'Alia', tiers: { Free: null, Go: 'Go', Pro: 'Pro', Max: 'Max', Ultra: 'Ultra' } },
  // Product-owned names; these bundle mappings remain a proposal.
  mention: {
    name: 'Mention',
    tiers: { Free: null, Go: 'Plus', Pro: 'Plus', Max: 'Plus', Ultra: 'Plus' },
  },
  mercaria: {
    name: 'Mercaria',
    tiers: { Free: null, Go: 'Go', Pro: 'Plus', Max: 'Plus', Ultra: 'Ultra' },
    creatorTiers: { Free: null, Go: 'Creator', Pro: 'Creator', Max: 'Creator', Ultra: 'Creator' },
  },
  noted: { name: 'Noted', tiers: { Free: null, Go: '+', Pro: '+', Max: '+', Ultra: '+' } },
  clarity: {
    name: 'Clarity',
    tiers: { Free: null, Go: null, Pro: 'Plus', Max: 'Plus', Ultra: 'Plus' },
  },
  schedio: {
    name: 'Schedio',
    tiers: { Free: null, Go: null, Pro: 'Plus', Max: 'Plus', Ultra: 'Plus' },
  },
  inbox: {
    name: 'Inbox',
    tiers: { Free: null, Go: null, Pro: 'Plus', Max: 'Plus', Ultra: 'Plus' },
  },
  homiio: {
    name: 'Homiio',
    tiers: { Free: null, Go: 'Plus', Pro: 'Plus', Max: 'Plus', Ultra: 'Plus' },
  },
} as const;

/** Annual rounding follows the billable base and per-seat line items. */
export function onePlanQuote(
  plan: OnePlan,
  period: 'monthly' | 'annual',
  seats: number | undefined,
) {
  const annual = (value: number) => Math.round(value * 12 * (1 - OXY_ONE_ANNUAL_DISCOUNT / 100));
  const baseAnnual = annual(plan.monthlyPrice);
  const seatAnnual =
    plan.monthlySeatPrice === undefined ? undefined : annual(plan.monthlySeatPrice);
  const known = plan.monthlySeatPrice === undefined || seats !== undefined;
  const totalAnnual = known ? baseAnnual + (seatAnnual ?? 0) * (seats ?? 0) : undefined;
  return {
    baseMonthly: period === 'annual' ? Math.round(baseAnnual / 12) : plan.monthlyPrice,
    seatMonthly:
      seatAnnual === undefined
        ? undefined
        : period === 'annual'
          ? Math.round(seatAnnual / 12)
          : plan.monthlySeatPrice,
    totalMonthly:
      totalAnnual === undefined
        ? undefined
        : period === 'annual'
          ? Math.round(totalAnnual / 12)
          : plan.monthlyPrice + (plan.monthlySeatPrice ?? 0) * (seats ?? 0),
    totalAnnual,
    storageGB: known ? plan.storageGB + (plan.storagePerSeatGB ?? 0) * (seats ?? 0) : undefined,
    monthlyCredits: known
      ? plan.monthlyCredits + (plan.creditsPerSeat ?? 0) * (seats ?? 0)
      : undefined,
  };
}
