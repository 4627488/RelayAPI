import { isHttpError } from "@/src/server/http/errors";
import { oauthBearer, oidcUserInfo } from "@/src/server/services/oidcProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try { return Response.json(oidcUserInfo(oauthBearer(request)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: isHttpError(error) ? error.code : "invalid_token" }, { status: isHttpError(error) ? error.status : 401, headers: { "WWW-Authenticate": "Bearer" } }); }
}
