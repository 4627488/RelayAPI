import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type TenantService = typeof import("@/src/server/services/tenants");
let tenants: TenantService;

describe("tenant account operations", () => {
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tenant-account-"));
    process.env.DATA_DIR = dir;
    process.env.RELAY_MAIN_DB_PATH = path.join(dir, "main.sqlite");
    process.env.RELAY_LOG_DB_PATH = path.join(dir, "log.sqlite");
    tenants = await import("@/src/server/services/tenants");
  });

  it("replaces reset tokens and consumes a token once", () => {
    const tenant = tenants.createTenant({ name: "Acme", ownerEmail: "owner@example.com" });
    const first = tenants.createTenantPasswordReset(tenant.id);
    const second = tenants.createTenantPasswordReset(tenant.id);
    expect(() => tenants.completeTenantPasswordReset(first.token, "a-secure-password"))
      .toThrowError(/invalid or expired/i);
    const context = tenants.completeTenantPasswordReset(second.token, "a-secure-password");
    expect(context.user.email).toBe("owner@example.com");
    expect(() => tenants.completeTenantPasswordReset(second.token, "another-secure-password"))
      .toThrowError(/invalid or expired/i);
  });

  it("invalidates an older session when sessions are revoked", () => {
    const context = tenants.loginTenant({ email: "owner@example.com", password: "a-secure-password" });
    const token = tenants.createTenantSessionToken(context);
    expect(tenants.getTenantSessionFromCookieValue(token)).not.toBeNull();
    tenants.revokeTenantSessions(context.tenant.id);
    expect(tenants.getTenantSessionFromCookieValue(token)).toBeNull();
  });

});
