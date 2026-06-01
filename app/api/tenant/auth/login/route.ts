import { cookies } from "next/headers";

import { errorToResponse } from "@/src/server/http/errors";
import {
  createTenantSessionToken,
  loginTenant,
  TENANT_SESSION_COOKIE,
  tenantSessionCookieOptions,
} from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const context = loginTenant({
      email: objectValue(body)?.email,
      password: objectValue(body)?.password,
    });
    const cookieStore = await cookies();
    cookieStore.set(
      TENANT_SESSION_COOKIE,
      createTenantSessionToken(context),
      tenantSessionCookieOptions(request),
    );
    return Response.json({ authenticated: true });
  } catch (error) {
    return errorToResponse(error);
  }
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
