import { oidcDiscovery } from "@/src/server/services/oidcProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(oidcDiscovery(), { headers: { "Cache-Control": "public, max-age=300" } });
}
