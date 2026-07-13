import { oidcJwks } from "@/src/server/services/oidcProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(oidcJwks(), { headers: { "Cache-Control": "public, max-age=3600" } });
}
