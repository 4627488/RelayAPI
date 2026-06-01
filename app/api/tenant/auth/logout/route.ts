import { cookies } from "next/headers";

import { errorToResponse } from "@/src/server/http/errors";
import {
  expiredTenantSessionCookieOptions,
  TENANT_SESSION_COOKIE,
} from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    cookieStore.set(
      TENANT_SESSION_COOKIE,
      "",
      expiredTenantSessionCookieOptions(request),
    );
    return Response.json({ authenticated: false });
  } catch (error) {
    return errorToResponse(error);
  }
}
