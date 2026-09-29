import { resetDemoStore } from "@geo/db";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildServer } from "./index.js";

describe("API memory mode", () => {
  it("verifies Stripe webhooks against the exact raw request body", async () => {
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_raw_body_test";
    resetDemoStore();
    const app = await buildServer({ databaseUrl: undefined });
    await app.ready();
    try {
      const raw = JSON.stringify({
        id: "evt_raw_body_test",
        type: "customer.subscription.updated",
        data: {
          object: {
            status: "active",
            metadata: { project_id: "prj_demo", plan_code: "starter" },
          },
        },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", "whsec_raw_body_test")
        .update(`${timestamp}.${raw}`)
        .digest("hex");
      const response = await app.inject({
        method: "POST",
        url: "/v1/billing/webhook",
        headers: {
          "content-type": "application/json",
          "stripe-signature": `t=${timestamp},v1=${signature}`,
        },
        payload: raw,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().handled).toBe(true);
    } finally {
      await app.close();
      if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("fails closed for production demo writes, CORS, and unverified SAML", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousCors = process.env.CORS_ORIGINS;
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.geolens.example";
    resetDemoStore();
    const app = await buildServer({ databaseUrl: undefined });
    await app.ready();
    try {
      const read = await app.inject({
        method: "GET",
        url: "/v1/projects/prj_demo/prompts",
        headers: { origin: "https://app.geolens.example" },
      });
      expect(read.statusCode).toBe(200);
      expect(read.headers["access-control-allow-origin"]).toBe(
        "https://app.geolens.example",
      );
      expect(read.headers["x-content-type-options"]).toBe("nosniff");
      expect(read.headers["strict-transport-security"]).toContain(
        "max-age=31536000",
      );

      const deniedOrigin = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "https://attacker.example" },
      });
      expect(deniedOrigin.headers["access-control-allow-origin"]).toBeUndefined();

      const write = await app.inject({
        method: "POST",
        url: "/v1/projects/prj_demo/prompts",
        payload: { text: "must not mutate the public demo" },
      });
      expect(write.statusCode).toBe(403);
      expect(write.json().error).toBe("demo_read_only");

      const saml = await app.inject({ method: "GET", url: "/v1/saml/metadata" });
      expect(saml.statusCode).toBe(501);
      expect(saml.json().error).toBe("verified_saml_not_configured");
    } finally {
      await app.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousCors === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = previousCors;
    }
  });

  it("health and brands report return consistent metrics", async () => {
    delete process.env.DATABASE_URL;
    resetDemoStore();
    const app = await buildServer({ databaseUrl: undefined });
    await app.ready();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().backend).toBe("memory");

    const report = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/reports/brands",
    });
    expect(report.statusCode).toBe(200);
    const body = report.json() as {
      rows: { share_of_voice: number }[];
    };
    const sov = body.rows.reduce((s, r) => s + r.share_of_voice, 0);
    expect(sov).toBeCloseTo(1, 5);

    await app.close();
  }, 60_000);

  it("prompts CRUD and chat detail work in memory mode", async () => {
    delete process.env.DATABASE_URL;
    resetDemoStore();
    const app = await buildServer({ databaseUrl: undefined });
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/prompts",
      payload: {
        text: "which CRM has the best mobile app",
        country_code: "US",
      },
    });
    expect(created.statusCode).toBe(200);
    const promptId = (created.json() as { prompt: { id: string } }).prompt.id;

    const listed = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/prompts",
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json() as {
      rows: { id: string }[];
      metrics: Record<
        string,
        { attempts: number; eligible_answers: number; mention_rate: number | null }
      >;
    };
    const prompts = listedBody.rows;
    expect(prompts.some((p) => p.id === promptId)).toBe(true);
    expect(listedBody.metrics[promptId]).toEqual({
      attempts: 0,
      eligible_answers: 0,
      mentioned_answers: 0,
      failed_attempts: 0,
      mention_rate: null,
    });

    const archived = await app.inject({
      method: "PATCH",
      url: `/v1/projects/prj_demo/prompts/${promptId}`,
      payload: { status: "archived" },
    });
    expect(archived.statusCode).toBe(200);
    expect(
      (archived.json() as { prompt: { status: string } }).prompt.status,
    ).toBe("archived");

    const chats = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/chats?limit=5",
    });
    expect(chats.statusCode).toBe(200);
    const chatRows = (
      chats.json() as { rows: { id: string; prompt_text: string | null }[] }
    ).rows;
    expect(chatRows.length).toBeGreaterThan(0);
    expect(chatRows[0]?.prompt_text).toBeTruthy();

    const detail = await app.inject({
      method: "GET",
      url: `/v1/projects/prj_demo/chats/${chatRows[0]!.id}`,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      chat: { id: string };
      mentions: unknown[];
      sources: unknown[];
    };
    expect(body.chat.id).toBe(chatRows[0]!.id);
    expect(Array.isArray(body.mentions)).toBe(true);
    expect(Array.isArray(body.sources)).toBe(true);

    const domains = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/reports/domains",
    });
    expect(domains.statusCode).toBe(200);
    const domainRows = (
      domains.json() as { rows: { domain: string; retrieval_rate: number }[] }
    ).rows;
    expect(domainRows.length).toBeGreaterThan(0);

    const gaps = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/reports/gaps",
    });
    expect(gaps.statusCode).toBe(200);
    const gapBody = gaps.json() as { domains: unknown[]; urls: unknown[] };
    expect(gapBody.domains.length + gapBody.urls.length).toBeGreaterThan(0);

    const discovery = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/discovery/generate",
      payload: { countries: ["US"], topics: ["Pricing & plans"] },
    });
    expect(discovery.statusCode).toBe(200);
    expect(
      (discovery.json() as { prompts: unknown[] }).prompts.length,
    ).toBeGreaterThan(0);

    const competitors = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/competitors/suggestions",
    });
    expect(competitors.statusCode).toBe(200);
    expect(
      (competitors.json() as { rows: unknown[] }).rows.length,
    ).toBeGreaterThan(0);

    const insights = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/insights/brand",
    });
    expect(insights.statusCode).toBe(200);
    const insightsBody = insights.json() as {
      matrix: { cells: unknown[]; colKeys: string[] };
      kpis: { strongest_channel: string | null };
    };
    expect(insightsBody.matrix.colKeys.length).toBeGreaterThanOrEqual(2);
    expect(insightsBody.matrix.cells.length).toBeGreaterThan(0);

    const fanouts = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/reports/fanouts",
    });
    expect(fanouts.statusCode).toBe(200);
    expect(
      (fanouts.json() as { total_occurrences: number }).total_occurrences,
    ).toBeGreaterThan(0);

    const ads = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/reports/ads",
    });
    expect(ads.statusCode).toBe(200);

    const createdView = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/views",
      payload: { name: "Public board" },
    });
    expect(createdView.statusCode).toBe(200);
    const viewId = (createdView.json() as { view: { id: string } }).view.id;

    const shared = await app.inject({
      method: "GET",
      url: `/v1/shared/${viewId}`,
    });
    expect(shared.statusCode).toBe(200);
    expect((shared.json() as { read_only: boolean }).read_only).toBe(true);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/projects/prj_demo/views/${viewId}`,
    });
    expect(revoked.statusCode).toBe(200);
    const sharedAfterRevoke = await app.inject({
      method: "GET",
      url: `/v1/shared/${viewId}`,
    });
    expect(sharedAfterRevoke.statusCode).toBe(404);

    const genActions = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/actions/generate",
      payload: { force: true },
    });
    expect(genActions.statusCode).toBe(200);
    const actionRows = (
      genActions.json() as {
        rows: { id: string; status: string; evidence: unknown[] }[];
      }
    ).rows;
    expect(actionRows.length).toBeGreaterThan(0);
    expect(actionRows.every((a) => a.evidence.length > 0)).toBe(true);

    const listedNew = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/actions?status=new",
    });
    expect(listedNew.statusCode).toBe(200);
    const newRows = (
      listedNew.json() as { rows: { id: string }[] }
    ).rows;
    expect(newRows.length).toBeGreaterThan(0);
    const targetId = newRows[0]!.id;

    const accept = await app.inject({
      method: "POST",
      url: `/v1/projects/prj_demo/actions/${targetId}/transition`,
      payload: { verb: "accept" },
    });
    expect(accept.statusCode).toBe(200);

    const complete = await app.inject({
      method: "POST",
      url: `/v1/projects/prj_demo/actions/${targetId}/transition`,
      payload: { verb: "complete" },
    });
    expect(complete.statusCode).toBe(200);

    const impact = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/impact",
    });
    expect(impact.statusCode).toBe(200);
    expect(
      (impact.json() as { markers: unknown[] }).markers.length,
    ).toBeGreaterThan(0);

    const channels = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/reports/channels",
    });
    expect(channels.statusCode).toBe(200);
    const channelBody = channels.json() as {
      rows: { channel_id: string; surface_kind: string; visibility: number }[];
    };
    expect(channelBody.rows.length).toBeGreaterThanOrEqual(3);
    expect(
      channelBody.rows.every((r) => r.surface_kind === "api"),
    ).toBe(true);
    const vis = channelBody.rows.map((r) => r.visibility);
    expect(Math.max(...vis) - Math.min(...vis)).toBeGreaterThan(0.01);

    const catalog = await app.inject({ method: "GET", url: "/v1/channels" });
    expect(catalog.statusCode).toBe(200);
    const catalogBody = catalog.json() as {
      api_default: string[];
      rows: {
        id: string;
        description: string;
        collection: { route_note: string } | null;
      }[];
    };
    expect(catalogBody.api_default.length).toBeGreaterThanOrEqual(3);
    expect(
      catalogBody.rows
        .filter((row) => row.collection)
        .every((row) => row.description === row.collection?.route_note),
    ).toBe(true);
    const runtime = await app.inject({
      method: "GET",
      url: "/v1/adapters/runtime",
    });
    expect(runtime.statusCode).toBe(200);
    const rt = runtime.json() as {
      channels: { channel_id: string; mode: string }[];
    };
    expect(rt.channels.length).toBeGreaterThanOrEqual(3);
    expect(rt.channels.every((c) => c.mode === "fixture" || c.mode === "live")).toBe(
      true,
    );

    const market = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/perception/market",
    });
    expect(market.statusCode).toBe(200);
    const marketBody = market.json() as {
      summary: { biggest_gap: { statement: string; label: string } | null };
    };
    expect(marketBody.summary.biggest_gap?.label).toBe("Reliability");
    expect(marketBody.summary.biggest_gap?.statement).toMatch(/#1 → #9/);

    const factcheck = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/perception/factcheck",
    });
    expect(factcheck.statusCode).toBe(200);
    const fcBody = factcheck.json() as {
      contradicted: { claim: { statement: string } }[];
    };
    expect(
      fcBody.contradicted.some(
        (c) => /\$9/.test(c.claim.statement) || /9\/mo/.test(c.claim.statement),
      ),
    ).toBe(true);

    const shopping = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/shopping/summary",
    });
    expect(shopping.statusCode).toBe(200);
    const shopBody = shopping.json() as {
      price_drift: { price_drift: number | null }[];
      top_products: unknown[];
    };
    expect(shopBody.price_drift.length).toBeGreaterThan(0);
    expect(shopBody.top_products.length).toBeGreaterThan(0);

    const shopCatalog = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/shopping/catalog",
      payload: {
        csv: "title,brand,price,currency,category\nAcme CRM Team,Acme,79,USD,CRM > Team\n",
      },
    });
    expect(shopCatalog.statusCode).toBe(200);
    const catBody = shopCatalog.json() as {
      added: number;
      price_drift_visible: boolean;
    };
    expect(catBody.added).toBe(1);
    expect(catBody.price_drift_visible).toBe(true);

    const collect = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/collect",
      payload: {
        run_date: "2026-09-05",
        force_inline: true,
        channel_ids: ["openai-1"],
      },
    });
    expect(collect.statusCode).toBe(200);
    const collectBody = collect.json() as {
      chats_written: number;
      queue_mode: string;
    };
    expect(collectBody.chats_written).toBeGreaterThan(0);
    expect(collectBody.queue_mode).toBe("inline");

    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect((openapi.json() as { openapi: string }).openapi).toMatch(/^3\./);

    const keyRes = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/api-keys",
      payload: { name: "parity" },
    });
    expect(keyRes.statusCode).toBe(200);
    const keyBody = keyRes.json() as { api_key: string };
    expect(keyBody.api_key.startsWith("geo_")).toBe(true);

    const dash = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/reports/brands",
    });
    const dashRows = (dash.json() as { rows: { brand_id: string; visibility: number }[] })
      .rows;

    const publicReport = await app.inject({
      method: "POST",
      url: "/customer/v1/reports/brands",
      headers: { "x-api-key": keyBody.api_key },
      payload: { project_id: "prj_demo" },
    });
    expect(publicReport.statusCode).toBe(200);
    const pubRows = (
      publicReport.json() as { data: { brand_id: string; visibility: number }[] }
    ).data;
    expect(pubRows.map((r) => r.visibility)).toEqual(
      dashRows.map((r) => r.visibility),
    );

    const mcp = await app.inject({
      method: "POST",
      url: "/v1/mcp/tools/reports.brands",
      payload: { project_id: "prj_demo" },
    });
    expect(mcp.statusCode).toBe(200);
    const mcpRows = (
      mcp.json() as { data: { brand_id: string; visibility: number }[] }
    ).data;
    expect(mcpRows.map((r) => r.visibility)).toEqual(
      dashRows.map((r) => r.visibility),
    );

    await app.close();
  }, 60_000);

  it("Phase 11: quota, pause, GDPR, trace-id, report p95", async () => {
    delete process.env.DATABASE_URL;
    resetDemoStore();
    const app = await buildServer({ databaseUrl: undefined });
    await app.ready();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.headers["x-trace-id"]).toBeTruthy();

    await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/billing/plan",
      payload: { plan_code: "trial" },
    });

    const billing = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/billing",
    });
    expect(billing.statusCode).toBe(200);
    expect((billing.json() as { plan: { code: string } }).plan.code).toBe(
      "trial",
    );

    for (let i = 0; i < 20; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/projects/prj_demo/prompts",
        payload: { text: `quota filler ${i}` },
      });
      if (r.statusCode === 409) {
        expect((r.json() as { error: string }).error).toBe("prompt_quota");
        break;
      }
    }
    const over = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/prompts",
      payload: { text: "one too many" },
    });
    expect(over.statusCode).toBe(409);

    const pauseDenied = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/pause",
      payload: { acknowledge_data_loss: false },
    });
    expect(pauseDenied.statusCode).toBe(400);

    const paused = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/pause",
      payload: { acknowledge_data_loss: true },
    });
    expect(paused.statusCode).toBe(200);

    const collect = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/collect",
      payload: { force_inline: true },
    });
    expect(collect.statusCode).toBe(409);

    await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/unpause",
    });

    const gdpr = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/gdpr/export",
    });
    expect(gdpr.statusCode).toBe(200);
    expect(
      (gdpr.json() as { organization: { id: string } }).organization.id,
    ).toBe("org_demo");

    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const r = await app.inject({
        method: "GET",
        url: "/v1/projects/prj_demo/reports/brands",
      });
      expect(r.statusCode).toBe(200);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    expect(p95).toBeLessThan(800);

    const checkout = await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/billing/checkout",
      payload: { plan_code: "growth" },
    });
    expect(checkout.statusCode).toBe(200);
    const sessionId = (checkout.json() as { session: { id: string } }).session
      .id;
    const completed = await app.inject({
      method: "POST",
      url: `/v1/projects/prj_demo/billing/checkout/${sessionId}/complete`,
    });
    expect(completed.statusCode).toBe(200);
    expect(
      (completed.json() as { billing: { plan: { code: string } } }).billing.plan
        .code,
    ).toBe("growth");

    const keys = await app.inject({
      method: "GET",
      url: "/v1/projects/prj_demo/api-keys",
    });
    expect(keys.statusCode).toBe(200);

    const meta = await app.inject({ method: "GET", url: "/v1/saml/metadata" });
    expect(meta.statusCode).toBe(200);
    expect(meta.body).toContain("EntityDescriptor");

    const acs = await app.inject({
      method: "POST",
      url: "/v1/saml/acs",
      payload: {
        SAMLResponse: Buffer.from(
          "<Response><NameID>demo@acme.example</NameID></Response>",
        ).toString("base64"),
        RelayState: "prj_demo",
      },
    });
    expect([302, 401]).toContain(acs.statusCode);

    const ops = await app.inject({ method: "GET", url: "/v1/ops/metrics" });
    expect(ops.statusCode).toBe(200);
    expect(
      (ops.json() as { ui_adapters: { enabled: boolean } }).ui_adapters.enabled,
    ).toBe(false);

    const ssoDenied = await app.inject({
      method: "PUT",
      url: "/v1/projects/prj_demo/sso",
      payload: {
        idp_entity_id: "https://idp.example",
        idp_sso_url: "https://idp.example/sso",
      },
    });
    expect(ssoDenied.statusCode).toBe(403);

    await app.inject({
      method: "POST",
      url: "/v1/projects/prj_demo/billing/plan",
      payload: { plan_code: "enterprise" },
    });
    const ssoOk = await app.inject({
      method: "PUT",
      url: "/v1/projects/prj_demo/sso",
      payload: {
        idp_entity_id: "https://idp.example",
        idp_sso_url: "https://idp.example/sso",
      },
    });
    expect(ssoOk.statusCode).toBe(200);
    expect((ssoOk.json() as { configured: boolean }).configured).toBe(true);

    await app.close();
  }, 60_000);
});

const pgUrl =
  process.env.DATABASE_URL ?? "postgres://geo:geo@localhost:5432/geo";

describe("API postgres auth", () => {
  it("signup creates org+project and session cookie", async () => {
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      app = await buildServer({ databaseUrl: pgUrl });
    } catch {
      return;
    }
    await app.ready();

    const email = `user_${Date.now()}@example.com`;
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: {
        email,
        password: "password123",
        name: "Test User",
        org_name: "Test Org",
        project_name: "Test Project",
      },
    });
    expect(signup.statusCode).toBe(200);
    const body = signup.json() as {
      project: { id: string };
      user: { email: string };
    };
    expect(body.user.email).toBe(email);
    expect(body.project.id).toMatch(/^prj_/);
    expect(signup.cookies.some((c) => c.name === "geo_session")).toBe(true);

    const cookie = signup.cookies.find((c) => c.name === "geo_session")!;
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      cookies: { geo_session: cookie.value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().projects.length).toBeGreaterThan(0);

    const projectId = body.project.id;
    const shopping = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/shopping/summary`,
      cookies: { geo_session: cookie.value },
    });
    expect(shopping.statusCode).toBe(200);
    const shopBody = shopping.json() as {
      data_state: string;
      empty_reason?: string | null;
      price_drift: unknown[];
      top_products: unknown[];
    };
    // A fresh signup has no catalog yet, so shopping must report an honest
    // empty state instead of seeded demo products.
    expect(shopBody.data_state).toBe("empty");
    expect(shopBody.empty_reason).toBeTruthy();
    expect(shopBody.price_drift.length).toBe(0);
    expect(shopBody.top_products.length).toBe(0);

    const denied = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/shopping/summary`,
    });
    expect(denied.statusCode).toBe(401);

    await app.close();
  }, 60_000);
});
