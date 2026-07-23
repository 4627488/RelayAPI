import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

type TenantService = typeof import("@/src/server/services/tenants");
type ApiKeyService = typeof import("@/src/server/services/apiKeys");
type TenantRepository = typeof import("@/src/server/repositories/tenants");
type SubscriptionRepository =
  typeof import("@/src/server/repositories/tenantSubscriptions");
type CodexCredentialRepository =
  typeof import("@/src/server/repositories/codexCredentials");
type GrokCredentialRepository =
  typeof import("@/src/server/repositories/grokCredentials");
type TenantQuotaService = typeof import("@/src/server/services/tenantQuota");
type SubscriptionService =
  typeof import("@/src/server/services/tenantSubscriptions");
type ChannelService = typeof import("@/src/server/services/channels");
type ProviderCredentialService =
  typeof import("@/src/server/services/providerCredentials");
type QuotaAccountingRepository =
  typeof import("@/src/server/repositories/quotaAccounting");
type QuotaCalibrationService =
  typeof import("@/src/server/services/quotaCalibration");

let tenants: TenantService;
let apiKeys: ApiKeyService;
let tenantRepository: TenantRepository;
let subscriptions: SubscriptionRepository;
let codexCredentials: CodexCredentialRepository;
let grokCredentials: GrokCredentialRepository;
let tenantQuota: TenantQuotaService;
let subscriptionService: SubscriptionService;
let channelService: ChannelService;
let providerCredentialService: ProviderCredentialService;
let quotaAccounting: QuotaAccountingRepository;
let quotaCalibration: QuotaCalibrationService;

describe("tenant subscription user access", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "relay-subscription-access-"),
    );
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");

    tenants = await import("@/src/server/services/tenants");
    apiKeys = await import("@/src/server/services/apiKeys");
    tenantRepository = await import("@/src/server/repositories/tenants");
    subscriptions = await import(
      "@/src/server/repositories/tenantSubscriptions"
    );
    codexCredentials = await import(
      "@/src/server/repositories/codexCredentials"
    );
    grokCredentials = await import("@/src/server/repositories/grokCredentials");
    tenantQuota = await import("@/src/server/services/tenantQuota");
    subscriptionService = await import(
      "@/src/server/services/tenantSubscriptions"
    );
    channelService = await import("@/src/server/services/channels");
    providerCredentialService = await import(
      "@/src/server/services/providerCredentials"
    );
    quotaAccounting = await import(
      "@/src/server/repositories/quotaAccounting"
    );
    quotaCalibration = await import(
      "@/src/server/services/quotaCalibration"
    );
  });

  test("only exposes a parent credential to the assigned tenant user", () => {
    const created = tenants.createTenant({
      name: "Assigned user",
      ownerEmail: "assigned@example.com",
    });
    const tenant = tenantRepository.getTenantById(created.id)!;
    const user = tenantRepository.getTenantOwnerUser(tenant.id)!;
    const now = new Date().toISOString();

    codexCredentials.upsertCodexCredential({
      id: "parent-credential-assigned",
      email: "parent@example.com",
      accountId: "parent-account",
      planType: "pro",
      tokens: {
        access_token: "access",
        refresh_token: "refresh",
        id_token: "id",
        expired: new Date(Date.now() + 60_000).toISOString(),
        last_refresh: now,
      },
    });

    const assigned = subscriptionService.createSubscription({
      tenantId: tenant.id,
      credentialId: "parent-credential-assigned",
      name: "Assigned subscription",
      units: 1,
    });
    expect(assigned.tenantUserId).toBe(user.id);
    subscriptions.insertTenantSubscription({
      id: "sub-other-user",
      tenantId: tenant.id,
      tenantUserId: "tuser-other",
      credentialId: "parent-credential-other",
      name: "Other user subscription",
      units: 1,
      unitsPerCredential: 20,
      enabled: true,
      priority: 100,
      startsAt: now,
      expiresAt: null,
    });

    expect(
      tenantQuota.eligibleCredentialIdsForTenant(tenant.id, user.id),
    ).toEqual(["parent-credential-assigned"]);
    expect(
      tenantQuota.eligibleCredentialIdsForTenant(tenant.id, "tuser-other"),
    ).toEqual(["parent-credential-other"]);
    expect(
      subscriptionService
        .listSubscriptions(tenant.id, user.id)
        .map((item) => item.id),
    ).toEqual([assigned.id]);
    expect(() =>
      tenantQuota.admitTenantRequest({
        tenantId: tenant.id,
        tenantUserId: "tuser-other",
        credentialId: "parent-credential-assigned",
        requestId: "request-cross-user",
        model: "gpt-5.5",
      }),
    ).toThrowError(/No active subscription is assigned/);
  });

  test("attributes tenant API keys to the tenant user", () => {
    const tenant = tenantRepository.getTenantById(
      tenantRepository.getTenantUserByEmail("assigned@example.com")!.tenantId,
    )!;
    const user = tenantRepository.getTenantOwnerUser(tenant.id)!;
    const created = apiKeys.createTenantApiKey(tenant, { name: "User key" });
    const context = apiKeys.authenticateRelayRequest(
      new Request("https://relay.example/v1/responses", {
        headers: { authorization: `Bearer ${created.key}` },
      }),
    );

    expect(context.tenantId).toBe(tenant.id);
    expect(context.tenantUserId).toBe(user.id);
  });

  test("splits a Grok parent subscription and exposes its models to one Codex client", async () => {
    const tenant = tenantRepository.getTenantById(
      tenantRepository.getTenantUserByEmail("assigned@example.com")!.tenantId,
    )!;
    grokCredentials.saveGrokCredential({
      id: "grok-parent-split",
      authType: "api_key",
      email: "grok@example.com",
      subject: "grok-parent",
      planType: "supergrok",
      tokens: {
        access_token: "",
        refresh_token: "",
        id_token: "",
        token_type: "Bearer",
        expired: "",
        token_endpoint: "",
        api_key: "grok-key",
      },
    });

    const subscription = subscriptionService.createSubscription({
      tenantId: tenant.id,
      credentialId: "grok-parent-split",
      units: 1,
      unitsPerCredential: 5,
    });
    const grokChannel = channelService.createChannel({
      provider: "grok",
      name: "Grok shared pool",
      credentialIds: ["grok-parent-split"],
      modelAllowlist: ["grok-shared-model"],
    });
    expect(grokChannel.baseUrl).toBe("https://api.x.ai/v1");

    expect(subscription.units).toBe(1);
    expect(subscription.unitsPerCredential).toBe(5);
    const pool = subscriptionService
      .getSubscriptionAllocationOverview()
      .pools.find((item) => item.id === "grok-parent-split")!;
    expect(pool.capacityUnits).toBe(1);
    expect(pool.automaticQuotaSupported).toBe(false);
    expect(pool.quotaResetStrategy).toBe("rolling");
    expect(pool.allocatedUnits).toBeCloseTo(0.2);
    expect(pool.subscriptions[0].allocatedPoolUnits).toBeCloseTo(0.2);
    const resources = await tenants.getTenantResources(
      tenant,
      tenantRepository.getTenantOwnerUser(tenant.id)!.id,
    );
    expect(resources.models).toContain("grok-shared-model");
    expect(resources.channels).toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: "grok" })]),
    );
  });

  test("enforces saved Grok parent estimates through provider-qualified pricing", () => {
    const tenant = tenantRepository.getTenantById(
      tenantRepository.getTenantUserByEmail("assigned@example.com")!.tenantId,
    )!;
    const user = tenantRepository.getTenantOwnerUser(tenant.id)!;
    const subscription = subscriptionService
      .listSubscriptions()
      .find((item) => item.credentialId === "grok-parent-split")!;
    quotaCalibration.setCredentialQuotaEstimates("grok-parent-split", {
      "5h": 1_000n,
      "7d": 5_000n,
    });

    expect(tenantQuota.subscriptionQuotaLimits(subscription)).toEqual({
      "5h": 200n,
      "7d": 1_000n,
    });
    const admission = tenantQuota.admitTenantRequest({
      tenantId: tenant.id,
      tenantUserId: user.id,
      credentialId: "grok-parent-split",
      requestId: "grok-priced-admission",
      model: "grok-4.5",
      now: new Date("2026-07-23T10:00:00.000Z"),
    });
    expect(admission.price).toMatchObject({ pricedModel: "xai/grok-4.5" });
    expect(admission.state?.windows["5h"].limitNanoUsd).toBe(200n);
    expect(admission.state?.windows["7d"].limitNanoUsd).toBe(1_000n);
    tenantQuota.releaseTenantRequest(admission.requestId);

    subscriptionService.patchCredentialQuotaEstimates("grok-parent-split", {
      "5h": "20000",
      "7d": "40000",
    });
    const updatedState = quotaAccounting.getSubscriptionQuotaState(
      subscription.id,
    );
    expect(updatedState.windows["5h"].limitNanoUsd).toBe(4_000n);
    expect(updatedState.windows["7d"].limitNanoUsd).toBe(8_000n);
    const listed = subscriptionService
      .listSubscriptions()
      .find((item) => item.id === subscription.id)!;
    expect(listed.quota["5h"]?.limitNanoUsd).toBe("4000");
    expect(listed.quota["7d"]?.limitNanoUsd).toBe("8000");
  });

  test("marks rolling subscription windows as local until an upstream reset is observed", () => {
    const subscription = subscriptionService
      .listSubscriptions()
      .find((item) => item.credentialId === "grok-parent-split")!;
    const fiveHourReset = "2026-07-23T15:00:00.000Z";
    const sevenDayReset = "2026-07-30T10:00:00.000Z";
    quotaAccounting.reserveSubscriptionQuota({
      requestId: "reset-source-probe",
      subscriptionId: subscription.id,
      reserveNanoUsd: 1n,
      windows: {
        "5h": { limitNanoUsd: 100n, resetsAt: fiveHourReset },
        "7d": { limitNanoUsd: 1000n, resetsAt: sevenDayReset },
      },
      now: new Date("2026-07-23T10:00:00.000Z"),
      expiresAt: new Date("2026-07-23T10:01:00.000Z"),
    });
    quotaAccounting.releaseSubscriptionQuota("reset-source-probe");

    let listed = subscriptionService
      .listSubscriptions()
      .find((item) => item.id === subscription.id)!;
    expect(listed.quota["5h"]?.resetSource).toBe("local");
    expect(listed.quota["7d"]?.resetSource).toBe("local");

    quotaCalibration.recordProviderQuotaObservation({
      provider: "grok",
      credentialId: "grok-parent-split",
      planType: "supergrok",
      observedAt: "2026-07-23T10:00:30.000Z",
      windows: [
        { kind: "5h", usedPercent: 1, resetsAt: fiveHourReset },
        { kind: "7d", usedPercent: 1, resetsAt: sevenDayReset },
      ],
    });

    listed = subscriptionService
      .listSubscriptions()
      .find((item) => item.id === subscription.id)!;
    expect(listed.quota["5h"]?.resetSource).toBe("upstream");
    expect(listed.quota["7d"]?.resetSource).toBe("upstream");
  });

  test("removes a channel when its last provider credential is deleted", async () => {
    grokCredentials.saveGrokCredential({
      id: "grok-delete-last",
      authType: "api_key",
      email: "delete@example.com",
      subject: "delete-subject",
      planType: "api-key",
      tokens: {
        access_token: "",
        refresh_token: "",
        id_token: "",
        token_type: "Bearer",
        expired: "",
        token_endpoint: "",
        api_key: "delete-key",
      },
    });
    const channel = channelService.createChannel({
      provider: "grok",
      name: "Delete last credential",
      credentialIds: ["grok-delete-last"],
      modelAllowlist: ["grok-delete-model"],
    });

    await providerCredentialService.removeProviderCredential(
      "grok",
      "grok-delete-last",
    );

    expect(channelService.listChannelRecords()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: channel.id })]),
    );
  });

  test("resets a Grok channel URL from the replacement credential auth type", () => {
    grokCredentials.saveGrokCredential({
      id: "grok-default-api-key",
      authType: "api_key",
      email: "key@example.com",
      subject: "",
      planType: "api-key",
      tokens: {
        access_token: "",
        refresh_token: "",
        id_token: "",
        token_type: "Bearer",
        expired: "",
        token_endpoint: "",
        api_key: "key-default",
      },
    });
    grokCredentials.saveGrokCredential({
      id: "grok-default-oauth",
      authType: "oauth",
      email: "oauth@example.com",
      subject: "oauth-subject",
      planType: "supergrok",
      tokens: {
        access_token: "access",
        refresh_token: "refresh",
        id_token: "id",
        token_type: "Bearer",
        expired: new Date(Date.now() + 60_000).toISOString(),
        token_endpoint: "https://example.com/token",
        api_key: "",
      },
    });
    const channel = channelService.createChannel({
      provider: "grok",
      credentialIds: ["grok-default-api-key"],
      modelAllowlist: ["grok-default-model"],
    });
    expect(channel.baseUrl).toBe("https://api.x.ai/v1");

    const updated = channelService.patchChannel(channel.id, {
      credentialIds: ["grok-default-oauth"],
      baseUrl: "",
    });

    expect(updated.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
  });
});
