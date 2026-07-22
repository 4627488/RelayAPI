import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

type TenantService = typeof import("@/src/server/services/tenants");
type ApiKeyService = typeof import("@/src/server/services/apiKeys");
type TenantRepository = typeof import("@/src/server/repositories/tenants");
type SubscriptionRepository = typeof import("@/src/server/repositories/tenantSubscriptions");
type CodexCredentialRepository = typeof import("@/src/server/repositories/codexCredentials");
type TenantQuotaService = typeof import("@/src/server/services/tenantQuota");
type SubscriptionService = typeof import("@/src/server/services/tenantSubscriptions");

let tenants: TenantService;
let apiKeys: ApiKeyService;
let tenantRepository: TenantRepository;
let subscriptions: SubscriptionRepository;
let codexCredentials: CodexCredentialRepository;
let tenantQuota: TenantQuotaService;
let subscriptionService: SubscriptionService;

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
    tenantQuota = await import("@/src/server/services/tenantQuota");
    subscriptionService = await import("@/src/server/services/tenantSubscriptions");
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
      estimatedFiveHourNanoUsd: null,
      estimatedSevenDayNanoUsd: null,
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
});
