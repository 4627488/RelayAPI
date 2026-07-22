import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

type TenantService = typeof import("@/src/server/services/tenants");
type ApiKeyService = typeof import("@/src/server/services/apiKeys");
type TenantRepository = typeof import("@/src/server/repositories/tenants");
type SubscriptionRepository = typeof import("@/src/server/repositories/tenantSubscriptions");
type CodexCredentialRepository = typeof import("@/src/server/repositories/codexCredentials");
type GrokCredentialRepository = typeof import("@/src/server/repositories/grokCredentials");
type TenantQuotaService = typeof import("@/src/server/services/tenantQuota");
type SubscriptionService = typeof import("@/src/server/services/tenantSubscriptions");
type ChannelService = typeof import("@/src/server/services/channels");

let tenants: TenantService;
let apiKeys: ApiKeyService;
let tenantRepository: TenantRepository;
let subscriptions: SubscriptionRepository;
let codexCredentials: CodexCredentialRepository;
let grokCredentials: GrokCredentialRepository;
let tenantQuota: TenantQuotaService;
let subscriptionService: SubscriptionService;
let channelService: ChannelService;

describe("tenant subscription user access", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-subscription-access-"));
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");

    tenants = await import("@/src/server/services/tenants");
    apiKeys = await import("@/src/server/services/apiKeys");
    tenantRepository = await import("@/src/server/repositories/tenants");
    subscriptions = await import("@/src/server/repositories/tenantSubscriptions");
    codexCredentials = await import("@/src/server/repositories/codexCredentials");
    grokCredentials = await import("@/src/server/repositories/grokCredentials");
    tenantQuota = await import("@/src/server/services/tenantQuota");
    subscriptionService = await import("@/src/server/services/tenantSubscriptions");
    channelService = await import("@/src/server/services/channels");
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

    expect(tenantQuota.eligibleCredentialIdsForTenant(tenant.id, user.id)).toEqual([
      "parent-credential-assigned",
    ]);
    expect(tenantQuota.eligibleCredentialIdsForTenant(tenant.id, "tuser-other")).toEqual([
      "parent-credential-other",
    ]);
    expect(subscriptionService.listSubscriptions(tenant.id, user.id).map((item) => item.id)).toEqual([
      assigned.id,
    ]);
    expect(() => tenantQuota.admitTenantRequest({
      tenantId: tenant.id,
      tenantUserId: "tuser-other",
      credentialId: "parent-credential-assigned",
      requestId: "request-cross-user",
      model: "gpt-5.5",
    })).toThrowError(/No active subscription is assigned/);
  });

  test("attributes tenant API keys to the tenant user", () => {
    const tenant = tenantRepository.getTenantById(
      tenantRepository.getTenantUserByEmail("assigned@example.com")!.tenantId,
    )!;
    const user = tenantRepository.getTenantOwnerUser(tenant.id)!;
    const created = apiKeys.createTenantApiKey(tenant, { name: "User key" });
    const context = apiKeys.authenticateRelayRequest(new Request("https://relay.example/v1/responses", {
      headers: { authorization: `Bearer ${created.key}` },
    }));

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
    channelService.createChannel({
      provider: "grok",
      name: "Grok shared pool",
      credentialIds: ["grok-parent-split"],
      modelAllowlist: ["grok-shared-model"],
    });

    expect(subscription.units).toBe(1);
    expect(subscription.unitsPerCredential).toBe(5);
    const pool = subscriptionService.getSubscriptionAllocationOverview().pools
      .find((item) => item.id === "grok-parent-split")!;
    expect(pool.capacityUnits).toBe(1);
    expect(pool.allocatedUnits).toBeCloseTo(0.2);
    expect(pool.subscriptions[0].allocatedPoolUnits).toBeCloseTo(0.2);
    const resources = await tenants.getTenantResources(
      tenant,
      tenantRepository.getTenantOwnerUser(tenant.id)!.id,
    );
    expect(resources.models).toContain("grok-shared-model");
    expect(resources.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "grok" }),
    ]));
  });
});
