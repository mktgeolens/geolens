import { getPlan, ONBOARDING_PLAN_CODES, planDisplayName } from "@geo/core";
import { appendAuditLog, setOrgPlan } from "./commercial.js";
import { newId } from "./schema.js";
import type { DemoStore } from "./seed.js";
import { createStripeCheckoutSession } from "./stripe.js";

/** Catalog prices for checkout (cents). Mock Stripe when STRIPE_SECRET_KEY unset. */
export const PLAN_PRICES_CENTS: Record<string, number> = {
  trial: 0,
  starter: 9900,
  growth: 29900,
  agency: 79900,
  enterprise: 0, // sales-assisted — allow $0 mock / custom
};

export type CheckoutSession = {
  id: string;
  project_id: string;
  organization_id: string;
  plan_code: string;
  amount_cents: number;
  currency: string;
  status: "open" | "complete" | "expired";
  mode: "mock" | "stripe";
  checkout_url: string;
  stripe_session_id?: string;
  created_at: string;
};

const sessions = new Map<string, CheckoutSession>();

export function resetCheckoutSessions() {
  sessions.clear();
}

export function billingMode(): "mock" | "stripe" {
  return process.env.STRIPE_SECRET_KEY ? "stripe" : "mock";
}

type BillingMetadata = { checkout_session_id?: string; plan_code?: string; project_id?: string; organization_id?: string };
export type BillingEvent = {
  id?: string;
  type?: string;
  project_id?: string;
  data?: { object?: {
    id?: string; status?: string; client_reference_id?: string;
    metadata?: BillingMetadata;
    subscription_details?: { metadata?: BillingMetadata };
    parent?: { subscription_details?: { metadata?: BillingMetadata } };
  } };
};

/** Invoice metadata may live on its subscription snapshot, not the invoice. */
export function billingEventMetadata(event: BillingEvent): BillingMetadata {
  const obj = event.data?.object;
  return { ...obj?.subscription_details?.metadata, ...obj?.parent?.subscription_details?.metadata, ...obj?.metadata };
}

export async function createCheckoutSession(
  store: DemoStore,
  planCode: string,
  opts?: { success_url?: string; cancel_url?: string },
): Promise<CheckoutSession> {
  if (process.env.NODE_ENV === "production" && billingMode() !== "stripe") {
    throw new Error("stripe_not_configured");
  }
  const plan = getPlan(planCode);
  if (plan.code === "trial") {
    throw new Error("trial_not_purchasable");
  }
  const amount = PLAN_PRICES_CENTS[plan.code] ?? 0;
  if (plan.code === "enterprise" && amount === 0 && billingMode() === "stripe") {
    throw new Error("enterprise_contact_sales");
  }
  const id = newId("chk");
  const mode = billingMode();
  const webBase = process.env.WEB_URL ?? "http://127.0.0.1:3010";
  const success =
    opts?.success_url ??
    `${webBase}/${store.project.id}/billing?checkout=success&session=${id}`;
  const cancel =
    opts?.cancel_url ??
    `${webBase}/${store.project.id}/billing?checkout=cancel`;

  let checkout_url = success;
  let stripe_session_id: string | undefined;

  if (mode === "stripe") {
    if (amount <= 0) throw new Error("plan_not_priced");
    const stripe = await createStripeCheckoutSession({
      plan_code: plan.code,
      amount_cents: amount,
      currency: "usd",
      success_url: success,
      cancel_url: cancel,
      client_reference_id: id,
      metadata: {
        checkout_session_id: id,
        plan_code: plan.code,
        project_id: store.project.id,
        organization_id: store.organization.id,
      },
    });
    checkout_url = stripe.url;
    stripe_session_id = stripe.id;
  }

  const session: CheckoutSession = {
    id,
    project_id: store.project.id,
    organization_id: store.organization.id,
    plan_code: plan.code,
    amount_cents: amount,
    currency: "usd",
    status: "open",
    mode,
    checkout_url,
    stripe_session_id,
    created_at: new Date().toISOString(),
  };
  sessions.set(id, session);
  if (stripe_session_id) sessions.set(stripe_session_id, session);

  appendAuditLog(store, {
    source: "api",
    action: "billing.checkout_created",
    project_id: store.project.id,
    after: { session_id: id, plan_code: plan.code, mode, stripe_session_id },
  });
  return session;
}

export function getCheckoutSession(id: string): CheckoutSession | null {
  return sessions.get(id) ?? null;
}

/** Complete a mock (or verified) checkout and apply the plan. */
export function completeCheckout(
  store: DemoStore,
  sessionId: string,
  opts?: { verifiedByWebhook?: boolean },
): { session: CheckoutSession; summary_plan: string } {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("session_not_found");
  if (session.organization_id !== store.organization.id) {
    throw new Error("session_org_mismatch");
  }
  if (process.env.NODE_ENV === "production" && session.mode !== "stripe") {
    throw new Error("mock_checkout_disabled");
  }
  if (
    process.env.NODE_ENV === "production" &&
    session.mode === "stripe" &&
    opts?.verifiedByWebhook !== true
  ) {
    throw new Error("stripe_checkout_requires_verified_webhook");
  }
  if (session.status === "complete") {
    return { session, summary_plan: store.organization.plan_code };
  }
  session.status = "complete";
  setOrgPlan(store, session.plan_code, {
    is_agency: getPlan(session.plan_code).track === "agency",
    source: "api",
  });
  store.commercial = store.commercial ?? {
    enabled_channel_ids: [],
    countries: [store.project.default_country],
    bot_visits_used: 0,
    credits_total: null,
    project_count: 1,
  };
  store.commercial.stripe_customer_id =
    store.commercial.stripe_customer_id ?? `cus_mock_${store.organization.id}`;
  store.commercial.stripe_subscription_status = "active";
  appendAuditLog(store, {
    source: "api",
    action: "billing.checkout_completed",
    project_id: store.project.id,
    after: {
      session_id: sessionId,
      plan_code: session.plan_code,
    },
  });
  return { session, summary_plan: session.plan_code };
}

/**
 * Stripe webhook handler shape — verifies signature when STRIPE_WEBHOOK_SECRET
 * is set; otherwise accepts mock events for local demos.
 */
export function handleBillingWebhook(
  store: DemoStore,
  event: BillingEvent,
  opts?: { stripe_signature_ok?: boolean },
): { handled: boolean; plan_code?: string } {
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.STRIPE_WEBHOOK_SECRET
  ) {
    throw new Error("stripe_webhook_not_configured");
  }
  if (
    process.env.STRIPE_WEBHOOK_SECRET &&
    opts?.stripe_signature_ok !== true
  ) {
    throw new Error("invalid_signature");
  }
  const type = event.type ?? "";
  const obj = event.data?.object;
  const meta = billingEventMetadata(event);
  if (meta.project_id && meta.project_id !== store.project.id) throw new Error("billing_project_mismatch");
  if (meta.organization_id && meta.organization_id !== store.organization.id) throw new Error("billing_org_mismatch");
  const commercial = store.commercial ?? {
    enabled_channel_ids: [],
    countries: [store.project.default_country],
    bot_visits_used: 0,
    credits_total: null,
    project_count: 1,
  };
  store.commercial = commercial;

  if (type === "invoice.payment_failed") {
    commercial.stripe_subscription_status = "past_due";
    return { handled: true };
  }
  if (type === "customer.subscription.deleted") {
    commercial.stripe_subscription_status = "canceled";
    setOrgPlan(store, "trial", { source: "api" });
    return { handled: true, plan_code: "trial" };
  }
  if (type === "customer.subscription.updated") {
    if (obj?.status === "active" || obj?.status === "trialing") {
      commercial.stripe_subscription_status = "active";
      if (meta?.plan_code) setOrgPlan(store, meta.plan_code, { source: "api" });
    } else if (obj?.status === "canceled") {
      commercial.stripe_subscription_status = "canceled";
      setOrgPlan(store, "trial", { source: "api" });
    } else if (obj?.status === "past_due" || obj?.status === "unpaid") {
      commercial.stripe_subscription_status = "past_due";
    }
    return { handled: true, plan_code: store.organization.plan_code };
  }
  if (
    type === "checkout.session.completed" ||
    type === "invoice.paid" ||
    type === "mock.checkout.completed"
  ) {
    const sid =
      meta?.checkout_session_id ??
      obj?.client_reference_id ??
      obj?.id;
    if (sid && sessions.has(sid)) {
      const { session } = completeCheckout(store, sid, {
        verifiedByWebhook: true,
      });
      return { handled: true, plan_code: session.plan_code };
    }
    if (meta?.plan_code) {
      setOrgPlan(store, meta.plan_code, { source: "api" });
      commercial.stripe_subscription_status = "active";
      return { handled: true, plan_code: meta.plan_code };
    }
    if (type === "invoice.paid") {
      commercial.stripe_subscription_status = "active";
      return { handled: true, plan_code: store.organization.plan_code };
    }
  }
  return { handled: false };
}

export function listPurchasablePlans(opts?: {
  billing_period?: "monthly" | "annual";
}) {
  const period = opts?.billing_period ?? "monthly";
  return Object.entries(PLAN_PRICES_CENTS).map(([code, monthlyCents]) => {
    const plan = getPlan(code);
    const amount_cents =
      period === "annual" && monthlyCents > 0
        ? Math.round(monthlyCents * 10) // ~2 months free
        : monthlyCents;
    return {
      code: plan.code,
      name: plan.name,
      display_name: planDisplayName(code),
      track: plan.track,
      amount_cents,
      amount_cents_monthly: monthlyCents,
      billing_period: period,
      features: plan.features,
      max_active_prompts: plan.max_active_prompts,
      max_channels: plan.max_channels,
      max_countries: plan.max_countries,
    };
  });
}

export function listOnboardingPlans(billing_period: "monthly" | "annual" = "monthly") {
  return listPurchasablePlans({ billing_period }).filter((p) =>
    (ONBOARDING_PLAN_CODES as readonly string[]).includes(p.code),
  );
}
