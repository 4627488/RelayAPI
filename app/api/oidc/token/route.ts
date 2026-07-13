import { isHttpError } from "@/src/server/http/errors";
import { exchangeAuthorizationCode, exchangeRefreshToken } from "@/src/server/services/oidcProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const basic = parseBasic(request.headers.get("authorization"));
    const clientId = basic?.id || value(form, "client_id");
    const clientSecret = basic?.secret || value(form, "client_secret");
    const grantType = value(form, "grant_type");
    const result = grantType === "authorization_code"
      ? exchangeAuthorizationCode({ code: value(form, "code"), clientId, clientSecret, redirectUri: value(form, "redirect_uri"), codeVerifier: value(form, "code_verifier") })
      : grantType === "refresh_token"
        ? exchangeRefreshToken({ refreshToken: value(form, "refresh_token"), clientId, clientSecret })
        : null;
    if (!result) return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    return Response.json(result, { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
  } catch (error) {
    const status = isHttpError(error) ? error.status : 500;
    return Response.json({ error: isHttpError(error) ? error.code : "server_error", error_description: error instanceof Error ? error.message : "Token exchange failed" }, { status });
  }
}

function value(form: FormData, key: string) { const item = form.get(key); return typeof item === "string" ? item : ""; }
function parseBasic(value: string | null) {
  const match = (value || "").match(/^Basic\s+(.+)$/i); if (!match) return null;
  try { const decoded = Buffer.from(match[1], "base64").toString("utf8"); const split = decoded.indexOf(":"); return split >= 0 ? { id: decodeURIComponent(decoded.slice(0, split)), secret: decodeURIComponent(decoded.slice(split + 1)) } : null; } catch { return null; }
}
