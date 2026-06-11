import { cookies } from "next/headers";

import { errorToResponse } from "@/src/server/http/errors";
import {
  activateTenantInvite,
  createTenantSessionToken,
  TENANT_SESSION_COOKIE,
  tenantSessionCookieOptions,
} from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const data = objectValue(body) || {};
    const context = activateTenantInvite({
      token: data.token,
      email: data.email,
      password: data.password,
      displayName: data.displayName,
    });
    const cookieStore = await cookies();
    cookieStore.set(
      TENANT_SESSION_COOKIE,
      createTenantSessionToken(context),
      tenantSessionCookieOptions(request),
    );
    return Response.json({ activated: true });
  } catch (error) {
    return errorToResponse(error);
  }
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
