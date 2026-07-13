import { cookies } from "next/headers";
import { isHttpError } from "@/src/server/http/errors";
import { createAuthorizationRedirect, validateAuthorizationRequest } from "@/src/server/services/oidcProvider";
import { getTenantSessionFromCookieValue, TENANT_SESSION_COOKIE } from "@/src/server/services/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = validateAuthorizationRequest(new URL(request.url));
    const cookieStore = await cookies();
    const session = getTenantSessionFromCookieValue(cookieStore.get(TENANT_SESSION_COOKIE)?.value);
    if (!session) {
      const requestUrl = new URL(request.url);
      return Response.redirect(new URL(`/?returnTo=${encodeURIComponent(requestUrl.pathname + requestUrl.search)}`, request.url), 302);
    }
    return Response.redirect(createAuthorizationRedirect(input, session.user.id), 302);
  } catch (error) {
    const status = isHttpError(error) ? error.status : 500;
    const code = isHttpError(error) ? error.code : "server_error";
    return Response.json({ error: code, error_description: error instanceof Error ? error.message : "OIDC authorization failed" }, { status });
  }
}
