import { cookies } from "next/headers";

import { errorToResponse, HttpError } from "@/src/server/http/errors";
import {
  createTenantSessionToken,
  loginTenant,
  TENANT_SESSION_COOKIE,
  tenantSessionCookieOptions,
  expiredTenantSessionCookieOptions,
} from "@/src/server/services/tenants";
import {
  createWebSessionToken,
  expiredWebSessionCookieOptions,
  verifyAdminCredentials,
  WEB_SESSION_COOKIE,
  webSessionCookieOptions,
} from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = objectValue(await request.json().catch(() => null));
    const username = body?.username ?? body?.email;
    const password = body?.password;
    const cookieStore = await cookies();

    if (verifyAdminCredentials({ username, password })) {
      cookieStore.set(
        WEB_SESSION_COOKIE,
        createWebSessionToken(),
        webSessionCookieOptions(request),
      );
      cookieStore.set(
        TENANT_SESSION_COOKIE,
        "",
        expiredTenantSessionCookieOptions(request),
      );
      return Response.json({ authenticated: true, role: "admin" });
    }

    try {
      const context = loginTenant({ email: username, password });
      cookieStore.set(
        TENANT_SESSION_COOKIE,
        createTenantSessionToken(context),
        tenantSessionCookieOptions(request),
      );
      cookieStore.set(
        WEB_SESSION_COOKIE,
        "",
        expiredWebSessionCookieOptions(request),
      );
      return Response.json({ authenticated: true, role: "tenant" });
    } catch {
      throw new HttpError(
        401,
        "invalid_credentials",
        "账号或密码不正确",
      );
    }
  } catch (error) {
    return errorToResponse(error);
  }
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
