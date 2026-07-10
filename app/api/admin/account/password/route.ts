import { cookies } from "next/headers";
import { errorToResponse } from "@/src/server/http/errors";
import { changeAdminPassword, createWebSessionToken, requireWebRequest, WEB_SESSION_COOKIE, webSessionCookieOptions } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    changeAdminPassword(body?.currentPassword, body?.newPassword);
    (await cookies()).set(WEB_SESSION_COOKIE, createWebSessionToken(), webSessionCookieOptions(request));
    return Response.json({ changed: true });
  } catch (error) { return errorToResponse(error); }
}
