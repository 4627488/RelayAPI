import { expiredTenantSessionCookieOptions, TENANT_SESSION_COOKIE } from "@/src/server/services/tenants";
import { getOidcProviderSettings } from "@/src/server/services/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  const requestedTarget = url.searchParams.get("post_logout_redirect_uri");
  const target = safeLogoutTarget(requestedTarget) || "/";
  const response = Response.redirect(
    new URL(target, getOidcProviderSettings().issuer),
    302,
  );
  response.headers.append("Set-Cookie", `${TENANT_SESSION_COOKIE}=; Max-Age=0; Path=${expiredTenantSessionCookieOptions(request).path || "/"}; HttpOnly; SameSite=Lax`);
  return response;
}

function safeLogoutTarget(value: string | null) {
  if (!value) return null;
  try {
    const settings = getOidcProviderSettings();
    const target = new URL(value, settings.issuer);
    const allowedOrigins = new Set([
      new URL(settings.issuer).origin,
      ...settings.redirectUris.map((item) => new URL(item).origin),
    ]);
    return allowedOrigins.has(target.origin) ? target.toString() : null;
  } catch {
    return null;
  }
}
