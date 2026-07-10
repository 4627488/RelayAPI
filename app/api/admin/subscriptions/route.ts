import { errorToResponse } from "@/src/server/http/errors";
import { createSubscription, listSubscriptions } from "@/src/server/services/tenantSubscriptions";
import { requireWebRequest } from "@/src/server/services/webAccess";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { requireWebRequest(request); const tenantId = new URL(request.url).searchParams.get("tenantId") || undefined; return Response.json({ object: "list", data: listSubscriptions(tenantId) }); } catch (error) { return errorToResponse(error); } }
export async function POST(request: Request) { try { requireWebRequest(request); return Response.json(createSubscription(await request.json()), { status: 201 }); } catch (error) { return errorToResponse(error); } }
